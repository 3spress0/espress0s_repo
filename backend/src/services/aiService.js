import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { searchService } from './searchService.js';
import { describeAi, describeAiForAdmin, resolveAi } from './aiConfig.js';
import { findTgpt, generate, redact, tgptRuns } from './aiProviders.js';

/**
 * The rules that make an answer safe. They live in the system prompt so they
 * apply identically to every backend - Gemini, an OpenAI-compatible endpoint
 * or tgpt - and so a proxy that ignores the user message still gets them.
 */
const SYSTEM_PROMPT = `You are Barista, the personal file finder for espress0's repo.

Your purpose: easily find files in a personal software archive for the user.
You are named Barista — like a coffee barista, but you serve ISOs, tools, and docs.

STRICT RULES:
- Only mention files that are listed in the repository data below
- Never invent file names, versions, or download links
- If information is not in repository data, say "I don't have that file in the repository"
- Prefer repository metadata over general knowledge
- You can link to items using their slug: /file/{slug}
- Do not fabricate checksums or sizes
- Your purpose is to easily find files — be helpful, concise, and accurate`;

/**
 * Rules for the admin drafting helper. Kept separate from SYSTEM_PROMPT: that
 * one is about not inventing files for a visitor, this one is about writing
 * publishable copy from a fixed fact list.
 */
const DRAFT_SYSTEM_PROMPT = `You are writing the catalogue page for a file in a personal software archive.

Rules:
- Never invent version numbers, checksums, file sizes or download links.
- If you are unsure about a detail, leave a placeholder in square brackets, e.g. [confirm minimum RAM].
- Neutral, factual, technical tone. No marketing hype.

Reply with exactly this structure and nothing else:
SUMMARY: <one sentence, max 160 characters>
BODY:
<markdown body, 120-250 words, using "## " headings such as Overview, What's included, Requirements, Notes, plus bullet lists>`;

/** Appended to the catalogue data instead of the system prompt: it is per-question. */
const ANSWER_TAIL = `Answer helpfully based ONLY on the repository data above. If no relevant items, say so clearly and suggest how to browse categories. Keep it under 300 words and link to relevant items as /file/{slug} where they apply.`;

export const BARISTA_SYSTEM_PROMPT = SYSTEM_PROMPT;

/**
 * Barista: repository search first, an AI answer second, metadata-only as the
 * last resort.
 *
 * Which model answers is configurable (see services/aiConfig.js) - a Gemini
 * key, any OpenAI-compatible endpoint, or the free tgpt CLI. Whichever it is,
 * this file decides the same three things: what gets sent, what happens to the
 * answer, and what the visitor is told when the provider is unavailable. The
 * fallback is not decorative: a personal archive with no matching file should
 * say so, and does, without a model in the loop at all.
 */

export class AIService {
  constructor() {
    this.tgptAvailable = null; // null = unknown, check lazily
    this.tgptBinary = null;    // resolved once alongside availability
    this.tgptProbe = null;     // share a bounded in-flight probe across requests
    this.lastError = null;     // why the last provider call failed (shown to admins)
  }

  /**
   * Decide once whether a usable tgpt binary exists, so `auto` can fall back to
   * it and a broken install is reported instead of silently ignored.
   *
   * A tgpt found on PATH must also be the thing that gets spawned: earlier
   * versions probed PATH but spawned a fixed default path, so installing via a
   * package manager (~/go/bin, ~/.local/bin) marked the service available while
   * every call died with ENOENT.
   */
  async checkTgptAvailable(timeoutMs = config.ai.timeoutMs) {
    if (this.tgptAvailable !== null) return this.tgptAvailable;
    if (this.tgptProbe) return this.tgptProbe;

    if (!config.ai.enabled) {
      this.tgptAvailable = false;
      return false;
    }

    // Both finding a PATH binary and invoking --version share one bounded
    // budget. A corrupt executable (or a wrapper that starts an interactive
    // process) used to make GET /api/ai/status wait forever.
    const configuredTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : config.ai.timeoutMs;
    const deadline = Date.now() + configuredTimeoutMs;
    const remaining = () => Math.max(1, deadline - Date.now());
    this.tgptProbe = (async () => {
      const binary = await findTgpt(config.ai.tgpt.binaryPath, remaining());
      if (!binary) {
        this.tgptAvailable = false;
        this.lastError = 'no AI provider configured (set AI_API_KEY in .env, or run ./espress0 ai for the free tgpt CLI)';
        return false;
      }
      if (Date.now() < deadline && await tgptRuns(binary, remaining())) {
        this.tgptBinary = binary;
        this.tgptAvailable = true;
        return true;
      }
      this.tgptAvailable = false;
      this.lastError = `tgpt found at ${binary} but failed to run within ${configuredTimeoutMs} ms`;
      return false;
    })();

    try {
      return await this.tgptProbe;
    } finally {
      this.tgptProbe = null;
    }
  }

  /** Effective settings for one call: .env, then admin overrides, then the probe. */
  async aiConfig() {
    // Resolve first. Explicit Gemini/OpenAI configurations have no dependency
    // on tgpt, so probing the CLI there is both wasted work and (when the local
    // executable hangs) a request-blocking bug. Only auto/tgpt and Gemini's
    // documented no-key fallback need the availability result.
    let resolved = resolveAi({
      tgptAvailable: this.tgptAvailable === true,
      tgptBinary: this.tgptBinary,
    });
    const couldUseTgpt = resolved.enabled && (
      resolved.provider === 'tgpt'
      || (resolved.provider === 'none' && ['auto', 'gemini'].includes(resolved.requestedProvider))
    );
    if (!couldUseTgpt || this.tgptAvailable !== null) return resolved;

    await this.checkTgptAvailable(resolved.timeoutMs);
    resolved = resolveAi({
      tgptAvailable: this.tgptAvailable === true,
      tgptBinary: this.tgptBinary,
    });
    return resolved;
  }

  /** What a visitor may know about the AI backend: enough to explain a fallback. */
  async status() {
    return describeAi(await this.aiConfig());
  }

  /** What only an admin may know: the resolved endpoint and the last failure. */
  async adminStatus() {
    const cfg = await this.aiConfig();
    return describeAiForAdmin(cfg, this.lastError);
  }

  /**
   * Live round-trip for the admin Settings "test" button: proves the key, the
   * model name and the endpoint all agree, without guessing from config.
   */
  async testProvider() {
    const cfg = await this.aiConfig();
    const base = {
      provider: cfg.provider,
      format: cfg.format,
      model: cfg.provider === 'tgpt' ? (cfg.tgpt.model || cfg.tgpt.provider || 'tgpt default') : cfg.model,
      baseUrl: cfg.baseUrl,
      keyConfigured: cfg.keyConfigured,
      notes: cfg.notes,
    };
    if (!cfg.enabled) {
      return { ok: false, ...base, code: 'disabled', error: 'AI features are switched off (Settings -> AI).' };
    }
    if (cfg.provider === 'none') {
      return { ok: false, ...base, code: 'unavailable', error: 'No usable provider. Set AI_API_KEY in .env or install tgpt.' };
    }

    const started = Date.now();
    try {
      const out = await generate({
        system: 'You are a connectivity check. Reply with exactly: OK',
        prompt: 'Reply with exactly: OK',
        cfg,
        kind: 'ask',
      });
      this.lastError = null;
      return { ok: true, ...base, ms: Date.now() - started, sample: out.text.slice(0, 120) };
    } catch (e) {
      const code = typeof e?.code === 'string' ? e.code : 'unavailable';
      const error = redact(e?.message || e, cfg.apiKey).slice(0, 300);
      // Keep the same sanitized failure visible in the admin status card. The
      // test endpoint previously swallowed it into one response, so a reload
      // claimed that no provider error had occurred.
      this.lastError = redact(`[${cfg.provider}] ${code}: ${error}`, cfg.apiKey).slice(0, 300);
      return { ok: false, ...base, ms: Date.now() - started, code, error };
    }
  }

  /**
   * Main ask method
   */
  async ask(question, options = {}) {
    const { limit = 5, messages = [] } = options;

    // 1. Search repository metadata first - this is mandatory, and it is what
    //    the answer is checked against.
    const searchResults = searchService.search({
      q: [question, ...messages.filter(m => m.role === 'user').slice(-3).map(m => m.content)].join(' '),
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

    // 2. Ask the configured provider, with only catalogue data in front of it.
    const cfg = await this.aiConfig();
    if (cfg.enabled && cfg.provider !== 'none') {
      try {
        const answer = await this.askWithProvider(question, searchResults.results, faqResults, cfg, messages);
        this.lastError = null;
        return this.askResponse(answer, searchResults, cfg.provider);
      } catch (e) {
        this.lastError = redact(`[${cfg.provider}] ${e.code === 'timeout'
          ? `timed out after ${cfg.timeoutMs} ms`
          : 'failed'}: ${e.message}`, cfg.apiKey).slice(0, 200);
        console.warn('[ai] provider failed, falling back to rule-based:', redact(e.message, cfg.apiKey));
      }
    }

    // 3. Fallback: rule-based answering using only metadata.
    const fallback = this.askResponse(
      this.ruleBasedAnswer(question, searchResults.results, faqResults),
      searchResults, null);
    // Say *why* this answer is metadata-only. Without it an admin watching a
    // degraded answer cannot tell a broken provider from a repository that
    // simply has nothing matching the question.
    if (this.lastError) fallback.aiError = this.lastError;
    if (cfg.notes.length) fallback.aiNotes = cfg.notes;
    return fallback;
  }

  async askWithProvider(question, items, faqs, cfg, messages = []) {
    const out = await generate({
      system: SYSTEM_PROMPT,
      prompt: this.buildContext(items, faqs, question, messages),
      cfg,
      kind: 'ask',
    });
    const answer = this.sanitizeAnswer(String(out.text || '').trim());
    return answer || this.ruleBasedAnswer(question, items, faqs);
  }

  /** Uniform ask() payload: answer + the verified items backing it. */
  askResponse(answer, searchResults, provider = null) {
    return {
      answer,
      // `usedAI`/`provider` replaced a tgpt-specific pair; nothing outside this
      // repo consumes them, and the frontend only needs to know whether a model
      // answered or the catalogue did.
      usedAI: !!provider,
      provider: provider || null,
      sources: searchResults.results.slice(0, 3).map(item => ({
        id: item.id,
        name: item.name,
        slug: item.slug,
        category: item.category_slug,
      })),
      relatedItems: searchResults.results,
      metadata: { totalFound: searchResults.total },
    };
  }

  /** The per-question message: catalogue data the model is allowed to mention. */
  buildContext(items, faqs, question, messages = []) {
    let ctx = '';

    const recentMessages = messages
      .filter(m => m && ['user', 'assistant'].includes(m.role))
      .slice(-8);

    if (recentMessages.length > 0) {
      ctx += `\nRECENT CONVERSATION CONTEXT:
Use this only to understand references and conversational context.
Repository facts must still come from the REPOSITORY ITEMS section below.

${recentMessages.map(m =>
  `${m.role === 'user' ? 'User' : 'Barista'}: ${String(m.content || '').slice(0, 2000)}`
).join('\n')}

`;
    }

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
      ctx += `\nNo matching items found in repository for query "${question}".`;
    }

    ctx += `\nCURRENT USER QUESTION: ${question}\n\n${ANSWER_TAIL}`;

    return ctx;
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
        answer += `\n\nNote: Some links in this answer may not be verified. Always download from the official item page at /file/{slug} to ensure integrity.`;
      }
    }

    return answer;
  }

  /**
   * Draft the copy for a file page from the metadata an admin has typed so far.
   *
   * This is a *writing* helper, not the visitor-facing Q&A path: it produces a
   * one-line summary plus a markdown body the admin can edit before saving.
   * The configured provider is used when one is available; otherwise a
   * deterministic markdown skeleton is generated from the same metadata so the
   * button always does something useful on a box with no key and no tgpt.
   *
   * @param {object} meta  { name, version, category, platform, architecture,
   *                         file_type, file_size, tags[], links[], notes }
   * @returns {{description: string, long_description: string, usedAI: boolean, provider?: string, aiError?: string}}
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

    const cfg = await this.aiConfig();
    if (cfg.enabled && cfg.provider !== 'none') {
      try {
        const draft = await this.draftWithProvider(clean, cfg);
        if (draft) return { ...draft, usedAI: true, provider: cfg.provider };
        // An empty or unparsable answer is not an error worth a warning: the
        // template below is the documented outcome for it.
      } catch (e) {
        this.lastError = redact(`[${cfg.provider}] draft failed: ${e.message}`, cfg.apiKey).slice(0, 200);
        console.warn('[ai] draft failed, falling back to template:', redact(e.message, cfg.apiKey));
        return { ...this.templateDraft(clean), usedAI: false, provider: cfg.provider, aiError: this.lastError };
      }
    }

    const template = { ...this.templateDraft(clean), usedAI: false, provider: null };
    // Without this the admin sees a skeleton and no reason, which reads as
    // "the button is broken" rather than "no model is configured".
    if (this.lastError) template.aiError = this.lastError;
    else if (cfg.notes.length) template.aiError = cfg.notes[cfg.notes.length - 1];
    return template;
  }

  async draftWithProvider(meta, cfg) {
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

    const prompt = `FACTS (the only things you know for certain):
${facts}

Write the page copy for this catalogue entry.`;

    try {
      // Was a hard-coded 45000 ms, i.e. longer than the browser's request
      // budget - the admin pressed "generate", the model was still writing, and
      // axios had already cancelled. cfg.draftTimeoutMs is deliberately below
      // AI_TIMEOUT in the frontend for the same reason as ask().
      const out = (await generate({ system: DRAFT_SYSTEM_PROMPT, prompt, cfg, kind: 'draft' }).then(r => r.text)) || '';
      if (!out.trim()) return null;

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
      console.warn('[ai] describe failed:', redact(e.message, cfg.apiKey));
      throw e;
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
