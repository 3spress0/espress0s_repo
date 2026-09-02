import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { searchService } from './searchService.js';

const execFileAsync = promisify(execFile);

// Provider names are pasted into an argv slot; keep them boring.
const PROVIDER_PATTERN = /^[a-zA-Z0-9_.-]{1,32}$/;
// Models may contain slashes (meta-llama/…) and colons (ollama llama3:8b).
const MODEL_PATTERN = /^[a-zA-Z0-9_.:/-]{1,64}$/;

// Providers that cannot answer anything without a key; tgpt just errors out.
const KEY_PROVIDERS = new Set(['openai', 'deepseek', 'groq', 'gemini', 'mistral', 'anthropic']);
let warnedAboutKeylessProvider = false;

function providerArgs() {
  const provider = config.ai.provider;
  if (!provider) return [];
  if (!PROVIDER_PATTERN.test(provider)) {
    console.warn(`[ai] Ignoring invalid TGPT_PROVIDER value: ${provider}`);
    return [];
  }
  if (KEY_PROVIDERS.has(provider) && !config.ai.apiKey) {
    // A .env from before the defaults changed says TGPT_PROVIDER=openai
    // without a key, which makes every AI call fail. Fall back to tgpt's
    // built-in free provider and say so once.
    if (!warnedAboutKeylessProvider) {
      warnedAboutKeylessProvider = true;
      console.warn(`[ai] TGPT_PROVIDER=${provider} needs TGPT_API_KEY in .env; using tgpt's free default provider instead.`);
    }
    return [];
  }
  return ['--provider', provider];
}

function modelArgs() {
  const model = config.ai.model;
  if (!model) return [];
  // Model names are provider-specific ('gpt-3.5-turbo' means nothing to
  // phind). Only forward one when a provider was explicitly chosen.
  if (!config.ai.provider) {
    if (!warnedAboutKeylessProvider) {
      warnedAboutKeylessProvider = true;
      console.warn('[ai] TGPT_MODEL is set but TGPT_PROVIDER is empty; ignoring the model (provider default will be used).');
    }
    return [];
  }
  if (!MODEL_PATTERN.test(model)) {
    console.warn(`[ai] Ignoring invalid TGPT_MODEL value: ${model}`);
    return [];
  }
  return ['--model', model];
}

/**
 * Run tgpt with the prompt on stdin.
 *
 * Replaces the previous `cat /tmp/tgpt-prompt-<timestamp>.txt | tgpt ...`
 * shell pipeline, which (a) invoked a shell with interpolated values, and
 * (b) wrote predictable filenames into a world-writable directory, so any
 * local user could pre-create a symlink there and have us clobber a file or
 * feed the model their own prompt.
 *
 * The API key (when the chosen provider needs one) goes in via the
 * AI_API_KEY environment variable, never on the command line where other
 * local users could read it from ps(1).
 */
function runTgpt(binary, prompt, { timeoutMs = 30000, maxBytes = 1024 * 1024 } = {}) {
  const env = { ...process.env };
  if (config.ai.apiKey) env.AI_API_KEY = config.ai.apiKey;
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...providerArgs(), ...modelArgs(), '--quiet'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      env,
    });

    let out = '';
    let err = '';
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; fn(value); } };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, Object.assign(new Error('tgpt timed out'), { code: 'ETIMEDOUT' }));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.length > maxBytes) { child.kill('SIGKILL'); out = out.slice(0, maxBytes); }
    });
    child.stderr.on('data', (chunk) => { if (err.length < 8192) err += chunk; });
    child.on('error', (e) => { clearTimeout(timer); finish(reject, e); });
    child.on('close', () => {
      clearTimeout(timer);
      if (!out.trim() && err.trim()) return finish(reject, new Error(err.trim().slice(0, 500)));
      finish(resolve, out);
    });

    child.stdin.on('error', () => {}); // tgpt may exit before we finish writing
    child.stdin.end(prompt);
  });
}

/**
 * AI Service using tgpt as backend
 * - Searches repository metadata first
 * - Uses tgpt CLI if available
 * - Falls back to rule-based answering
 * - Never hallucinates files
 */

export class AIService {
  constructor() {
    this.tgptAvailable = null; // null = unknown, check lazily
    this.tgptBinary = null;    // resolved once alongside availability
    this.lastError = null;     // why the last tgpt call failed (shown to admins)
  }

  /**
   * Decide once which tgpt binary we use, preferring TGPT_BINARY_PATH but
   * falling back to a tgpt on PATH, and answer whether it actually runs.
   * Previously a tgpt found via PATH marked us available while the fixed
   * default path (/usr/local/bin/tgpt) was what got spawned — install via a
   * package manager (~/go/bin, ~/.local/bin) and every AI call died with
   * ENOENT even though `tgpt` worked fine in a shell.
   */
  async checkTgptAvailable() {
    if (this.tgptAvailable !== null) return this.tgptAvailable;

    if (!config.ai.enabled) {
      this.tgptAvailable = false;
      return false;
    }

    const configured = config.ai.binaryPath;
    let binary = null;
    if (configured && fs.existsSync(configured)) {
      binary = configured;
    } else if (configured && configured !== 'tgpt') {
      // Configured path missing — try PATH before giving up.
      try { binary = (await execFileAsync('which', ['tgpt'])).stdout.trim() || 'tgpt'; }
      catch { binary = null; }
    } else {
      try { binary = (await execFileAsync('which', ['tgpt'])).stdout.trim() || 'tgpt'; }
      catch { binary = null; }
    }

    if (!binary) {
      this.tgptAvailable = false;
      this.lastError = 'tgpt binary not found (./espress0 ai installs it)';
      return false;
    }
    try {
      await execFileAsync(binary, ['--version']);
      this.tgptBinary = binary;
      this.tgptAvailable = true;
      return true;
    } catch (e) {
      this.tgptAvailable = false;
      this.lastError = `tgpt found at ${binary} but failed to run: ${e.message}`.slice(0, 200);
      return false;
    }
  }

  async tgptSpawnTarget() {
    if (await this.checkTgptAvailable()) return this.tgptBinary;
    return fs.existsSync(config.ai.binaryPath) ? config.ai.binaryPath : 'tgpt';
  }

  /**
   * Main ask method
   */
  async ask(question, options = {}) {
    const { limit = 5 } = options;
    
    // 1. Search repository metadata first - this is mandatory
    const searchResults = searchService.search({
      q: question,
      published: 1,
      limit,
      page: 1,
      sort: 'relevance',
    });

    const db = getDb();
    const faqResults = db.prepare(`
      SELECT * FROM faq_entries 
      WHERE LOWER(question) LIKE @q OR LOWER(answer) LIKE @q
      LIMIT 3
    `).all({ q: `%${question.toLowerCase()}%` });

    const context = this.buildContext(searchResults.results, faqResults, question);

    // 2. If tgpt available, use it with strict context
    const tgptAvailable = await this.checkTgptAvailable();
    
    if (tgptAvailable) {
      try {
        const answer = await this.askWithTgpt(question, context);
        return {
          answer,
          sources: searchResults.results.slice(0, 3).map(item => ({
            id: item.id,
            name: item.name,
            slug: item.slug,
            category: item.category_slug,
          })),
          relatedItems: searchResults.results,
          usedTgpt: true,
          metadata: {
            totalFound: searchResults.total,
          }
        };
      } catch (e) {
        console.warn('tgpt failed, falling back to rule-based:', e.message);
        // Fall through to rule-based
      }
    }

    // 3. Fallback: rule-based answering using only metadata
    const answer = this.ruleBasedAnswer(question, searchResults.results, faqResults);

    return {
      answer,
      sources: searchResults.results.slice(0, 3).map(item => ({
        id: item.id,
        name: item.name,
        slug: item.slug,
        category: item.category_slug,
      })),
      relatedItems: searchResults.results,
      usedTgpt: false,
      metadata: {
        totalFound: searchResults.total,
      }
    };
  }

  buildContext(items, faqs, question) {
    let ctx = `You are Barista, the personal file finder for espress0's repo.

Your purpose: easily find files in a personal software archive for the user.
You are named Barista — like a coffee barista, but you serve ISOs, tools, and docs.

STRICT RULES:
- Only mention files that are listed in the repository data below
- Never invent file names, versions, or download links
- If information is not in repository data, say "I don't have that file in the repository"
- Prefer repository metadata over general knowledge
- You can link to items using their slug: /file/{slug}
- Do not fabricate checksums or sizes
- Your purpose is to easily find files — be helpful, concise, and accurate

`;

    if (faqs.length > 0) {
      ctx += `\nRELEVANT FAQ:\n`;
      faqs.forEach(f => {
        ctx += `Q: ${f.question}\nA: ${f.answer}\n\n`;
      });
    }

    if (items.length > 0) {
      ctx += `\nREPOSITORY ITEMS (most relevant to "${question}"):\n`;
      items.forEach(item => {
        ctx += `
- Name: ${item.name}
  Slug: ${item.slug}
  Description: ${item.description}
  Version: ${item.version || 'N/A'}
  Category: ${item.category_slug || 'other'}
  Platform: ${item.platform || 'N/A'}
  Architecture: ${item.architecture || 'N/A'}
  File Type: ${item.file_type || 'N/A'}
  File Size: ${item.file_size ? (item.file_size / 1024 / 1024).toFixed(2) + ' MB' : 'N/A'}
  Link: /file/${item.slug}
`;
      });
    } else {
      ctx += `\nNo matching items found in repository for query "${question}". You should say you don't have that file.`;
    }

    ctx += `\nUSER QUESTION: ${question}\n\nAnswer helpfully based ONLY on the repository data above. If no relevant items, say so clearly and suggest how to browse categories.`;

    return ctx;
  }

  async askWithTgpt(question, context) {
    const binary = await this.tgptSpawnTarget();
    
    // Build prompt - we use context + question
    // tgpt usage: echo "prompt" | tgpt --provider openai
    // We need to escape properly
    
    const fullPrompt = `${context}\n\nProvide a concise, helpful answer (max 300 words). Include links to relevant items as /file/{slug} if applicable.`;

    const stdout = await runTgpt(binary, fullPrompt, { timeoutMs: 30000 });

    // Clean output - tgpt may include extra formatting
    let answer = stdout.trim();

    // Basic sanitization: remove any potential hallucinated download URLs that aren't in our DB
    answer = this.sanitizeAnswer(answer);

    return answer || this.ruleBasedAnswer(question, [], []);
  }

  ruleBasedAnswer(question, items, faqs) {
    const qLower = question.toLowerCase();

    // Check FAQ first
    if (faqs.length > 0) {
      const bestFaq = faqs[0];
      let ans = bestFaq.answer;
      if (items.length > 0) {
        ans += `\n\nRelated files in the repo:\n`;
        items.slice(0, 3).forEach(item => {
          ans += `- [${item.name}](/file/${item.slug}) - ${item.description}\n`;
        });
      }
      return ans;
    }

    if (items.length === 0) {
      return `I couldn't find any files matching "${question}" in espress0's repo.\n\nTry:\n- Browsing categories like Operating Systems, ISOs, or Utilities\n- Using different keywords\n- Checking the search page with filters for platform or architecture\n\nIf you think this file should be in the repo, contact the administrator.`;
    }

    // Intent detection for common questions
    if (qLower.includes('smallest') || qLower.includes('size')) {
      const sorted = [...items].sort((a, b) => (a.file_size || 0) - (b.file_size || 0));
      const smallest = sorted[0];
      return `Based on your search, the smallest file is **${smallest.name}** (${smallest.file_size ? (smallest.file_size / 1024 / 1024).toFixed(2) + ' MB' : 'size unknown'}).\n\nFound ${items.length} matching files:\n${sorted.slice(0, 5).map(i => `- [${i.name}](/file/${i.slug}) - ${i.file_size ? (i.file_size / 1024 / 1024).toFixed(2) + ' MB' : ''} - ${i.architecture || ''} ${i.platform || ''}`).join('\n')}`;
    }

    if (qLower.includes('arm64') || qLower.includes('arm')) {
      const armItems = items.filter(i => i.architecture?.toLowerCase().includes('arm'));
      if (armItems.length > 0) {
        return `Yes, I found ${armItems.length} ARM64 compatible files:\n${armItems.map(i => `- [${i.name}](/file/${i.slug}) - ${i.version || ''} - ${i.platform || ''}`).join('\n')}\n\nYou can filter by ARM64 architecture on the browse page.`;
      } else {
        return `I searched for ARM64 versions but none of the ${items.length} results are marked as ARM64. The available architectures are: ${[...new Set(items.map(i => i.architecture))].join(', ')}.\n\nTry filtering by architecture in the browse page or ask about a specific OS.`;
      }
    }

    if (qLower.includes('intel') || qLower.includes('amd') || qLower.includes('x64') || qLower.includes('x86')) {
      const arch = qLower.includes('x86') && !qLower.includes('x64') ? 'x86' : 'x64';
      const matching = items.filter(i => i.architecture?.toLowerCase().includes(arch.toLowerCase()) || i.architecture === 'universal');
      if (matching.length > 0) {
        return `For Intel/AMD PCs (${arch}), I recommend:\n${matching.slice(0, 5).map(i => `- [${i.name}](/file/${i.slug}) - ${i.version || ''} - ${i.platform || ''} ${i.architecture || ''}`).join('\n')}\n\nMost modern Intel PCs use x64 (64-bit).`;
      }
    }

    if (qLower.includes('difference') || qLower.includes('compare')) {
      if (items.length >= 2) {
        return `Here's a comparison of the top results for "${question}":\n\n${items.slice(0, 3).map(i => `**${i.name}** (${i.version || 'N/A'})\n- Platform: ${i.platform || 'N/A'}\n- Arch: ${i.architecture || 'N/A'}\n- Size: ${i.file_size ? (i.file_size / 1024 / 1024 / 1024).toFixed(2) + ' GB' : 'N/A'}\n- Link: /file/${i.slug}\n`).join('\n')}\nLet me know if you want details on a specific one.`;
      }
    }

    if (qLower.includes('what does') || qLower.includes('what is')) {
      const top = items[0];
      return `**${top.name}** - ${top.description}\n\n${top.long_description || ''}\n\n- Version: ${top.version || 'N/A'}\n- Platform: ${top.platform || 'N/A'}\n- Architecture: ${top.architecture || 'N/A'}\n- Category: ${top.category_slug || 'other'}\n\nView details: /file/${top.slug}\n\n${items.length > 1 ? `Other related files:\n${items.slice(1, 3).map(i => `- [${i.name}](/file/${i.slug})`).join('\n')}` : ''}`;
    }

    // Default: list results
    return `I found ${items.length} file(s) matching "${question}" in espress0's repo:\n\n${items.slice(0, 5).map(i => `- **[${i.name}](/file/${i.slug})** - ${i.description}\n  Version: ${i.version || 'N/A'} | ${i.platform || ''} ${i.architecture || ''} | ${i.file_size ? (i.file_size / 1024 / 1024).toFixed(1) + ' MB' : ''}`).join('\n\n')}\n\nClick any link to view details, checksums, and download options. Use the browse page to filter by platform, architecture, or file type.`;
  }

  sanitizeAnswer(answer) {
    // Remove any URLs that look like direct downloads not from our domain or known providers
    // We only allow links to /file/ paths and known safe domains
    // This prevents hallucinated download links

    // Allow: /file/slug, https://drive.google.com, https://onedrive, https://github.com, relative links
    // For safety, we won't strip too aggressively, but we will add disclaimer if answer contains http and no item link
    
    // If answer contains a download link not referencing our items, append warning
    const hasHttp = answer.includes('http');
    const hasItemLink = answer.includes('/file/');
    
    if (hasHttp && !hasItemLink) {
      // Check if http link is from allowed providers
      const allowedDomains = ['drive.google.com', 'onedrive.live.com', '1drv.ms', 'github.com', 'espress0'];
      const urls = answer.match(/https?:\/\/[^\s]+/g) || [];
      const suspicious = urls.filter(url => !allowedDomains.some(d => url.includes(d)));
      
      if (suspicious.length > 0) {
        answer += `\n\n⚠️ Note: Some links in this answer may not be verified. Always download from the official item page at /file/{slug} to ensure integrity.`;
      }
    }

    return answer;
  }

  /**
   * Draft the copy for a file page from the metadata an admin has typed so far.
   *
   * This is a *writing* helper, not the visitor-facing Q&A path: it produces a
   * one-line summary plus a markdown body the admin can edit before saving.
   * tgpt is used when available; otherwise a deterministic markdown skeleton is
   * generated from the same metadata so the button always does something useful
   * on a VM without tgpt installed.
   *
   * @param {object} meta  { name, version, category, platform, architecture,
   *                         file_type, file_size, tags[], links[], notes }
   * @returns {{description: string, long_description: string, usedTgpt: boolean}}
   */
  async describeItem(meta = {}) {
    const clean = {
      name: String(meta.name || '').trim(),
      version: String(meta.version || '').trim(),
      category: String(meta.category || '').trim(),
      platform: String(meta.platform || '').trim(),
      architecture: String(meta.architecture || '').trim(),
      file_type: String(meta.file_type || '').trim(),
      file_size: Number(meta.file_size) || null,
      tags: Array.isArray(meta.tags) ? meta.tags.filter(Boolean).map(String).slice(0, 15) : [],
      links: Array.isArray(meta.links) ? meta.links.filter(Boolean).map(String).slice(0, 10) : [],
      notes: String(meta.notes || '').trim().slice(0, 1000),
    };

    if (!clean.name) throw new Error('name is required to draft a description');

    if (await this.checkTgptAvailable()) {
      try {
        const draft = await this.draftWithTgpt(clean);
        if (draft) return { ...draft, usedTgpt: true };
      } catch (e) {
        console.warn('tgpt draft failed, falling back to template:', e.message);
        this.lastError = String(e.message || e).slice(0, 200);
        return { ...this.templateDraft(clean), usedTgpt: false, tgptError: this.lastError };
      }
    }

    return { ...this.templateDraft(clean), usedTgpt: false, tgptError: this.lastError };
  }

  async draftWithTgpt(meta) {
    const binary = await this.tgptSpawnTarget();

    const facts = [
      `Name: ${meta.name}`,
      meta.version && `Version: ${meta.version}`,
      meta.category && `Category: ${meta.category}`,
      meta.platform && `Platform: ${meta.platform}`,
      meta.architecture && `Architecture: ${meta.architecture}`,
      meta.file_type && `File type: ${meta.file_type}`,
      meta.file_size && `File size: ${(meta.file_size / 1024 / 1024).toFixed(1)} MB`,
      meta.tags.length && `Tags: ${meta.tags.join(', ')}`,
      meta.links.length && `Download sources: ${meta.links.join(', ')}`,
      meta.notes && `Admin notes: ${meta.notes}`,
    ].filter(Boolean).join('\n');

    const prompt = `You are writing the catalogue page for a file in a personal software archive.

FACTS (the only things you know for certain):
${facts}

Write the page copy. Rules:
- Never invent version numbers, checksums, file sizes or download links.
- If you are unsure about a detail, leave a placeholder in square brackets, e.g. [confirm minimum RAM].
- Neutral, factual, technical tone. No marketing hype.

Reply with exactly this structure and nothing else:
SUMMARY: <one sentence, max 160 characters>
BODY:
<markdown body, 120-250 words, using "## " headings such as Overview, What's included, Requirements, Notes, plus bullet lists>`;

    try {
      const stdout = await runTgpt(binary, prompt, { timeoutMs: 45000 });

      const out = (stdout || '').trim();
      if (!out) return null;

      const summaryMatch = out.match(/SUMMARY:\s*(.+)/i);
      const bodyMatch = out.match(/BODY:\s*([\s\S]+)/i);

      const description = (summaryMatch?.[1] || '').trim().slice(0, 480);
      const long_description = (bodyMatch?.[1] || (summaryMatch ? '' : out)).trim().slice(0, 5000);

      if (!description && !long_description) return null;

      return {
        description: description || this.templateDraft(meta).description,
        long_description: long_description || this.templateDraft(meta).long_description,
      };
    } catch (e) {
      console.warn('[ai] describe failed:', e.message);
      return null;
    }
  }

  /**
   * Deterministic fallback draft. Produces a filled-in markdown skeleton from
   * the metadata, with [bracketed] prompts where the admin has to decide.
   */
  templateDraft(meta) {
    const label = [meta.name, meta.version].filter(Boolean).join(' ');
    const kind = meta.file_type ? meta.file_type.toUpperCase() : 'file';
    const target = [meta.platform, meta.architecture].filter(Boolean).join(' / ');

    const description = [
      label,
      meta.category ? `— ${meta.category.toLowerCase()}` : '',
      target ? `for ${target}` : '',
    ].filter(Boolean).join(' ').slice(0, 480);

    const lines = [
      '## Overview',
      '',
      `${label || meta.name} is [describe what this ${kind} is and who it is for].`,
      '',
      '## What you get',
      '',
      `- ${kind} download${meta.file_size ? ` (${(meta.file_size / 1024 / 1024).toFixed(1)} MB)` : ''}`,
      meta.links.length
        ? `- ${meta.links.length} mirror${meta.links.length === 1 ? '' : 's'}: ${meta.links.join(', ')}`
        : '- [add at least one download mirror]',
      '- [list notable contents, editions or bundled tools]',
      '',
      '## Requirements',
      '',
      target ? `- Runs on: ${target}` : '- Runs on: [platform / architecture]',
      '- [minimum RAM, disk space or dependencies]',
      '',
      '## Notes',
      '',
      '- Verify the SHA-256 checksum after downloading.',
      '- [licensing, source or anything a visitor should know]',
    ];

    if (meta.tags.length) {
      lines.push('', `Tags: ${meta.tags.map(t => `\`${t}\``).join(', ')}`);
    }

    return { description, long_description: lines.join('\n').slice(0, 5000) };
  }

  async getSuggestions() {
    return [
      "Which Ubuntu ISO should I download for an Intel PC?",
      "What is the difference between these two releases?",
      "Do you have an ARM64 version?",
      "What does this tool do?",
      "Which file is the smallest?",
      "Where can I find Windows recovery media?",
      "Which version should I use for development?",
      "How do I verify file integrity?",
    ];
  }
}

export const aiService = new AIService();
