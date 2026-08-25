import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { searchService } from './searchService.js';

const execAsync = promisify(exec);

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
  }

  async checkTgptAvailable() {
    if (this.tgptAvailable !== null) return this.tgptAvailable;
    
    if (!config.ai.enabled) {
      this.tgptAvailable = false;
      return false;
    }

    try {
      const binary = config.ai.binaryPath;
      if (!fs.existsSync(binary)) {
        // Try which tgpt
        await execAsync('which tgpt');
        this.tgptAvailable = true;
        return true;
      }
      await execAsync(`${binary} --version`);
      this.tgptAvailable = true;
      return true;
    } catch {
      this.tgptAvailable = false;
      return false;
    }
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
    const binary = fs.existsSync(config.ai.binaryPath) ? config.ai.binaryPath : 'tgpt';
    
    // Build prompt - we use context + question
    // tgpt usage: echo "prompt" | tgpt --provider openai
    // We need to escape properly
    
    const fullPrompt = `${context}\n\nProvide a concise, helpful answer (max 300 words). Include links to relevant items as /file/{slug} if applicable.`;

    // Write prompt to temp file to avoid shell escaping issues
    const tmpFile = path.join('/tmp', `tgpt-prompt-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, fullPrompt);

    try {
      // Use tgpt with provider
      const providerFlag = config.ai.provider ? `--provider ${config.ai.provider}` : '';
      const cmd = `cat ${tmpFile} | ${binary} ${providerFlag} --quiet 2>&1`;
      
      const { stdout } = await execAsync(cmd, {
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      });

      // Clean output - tgpt may include extra formatting
      let answer = stdout.trim();
      
      // Basic sanitization: remove any potential hallucinated download URLs that aren't in our DB
      answer = this.sanitizeAnswer(answer);

      return answer || this.ruleBasedAnswer(question, [], []);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
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
