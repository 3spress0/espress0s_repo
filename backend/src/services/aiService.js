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

Your purpose: help the user FIND files in a personal software archive. You are
named Barista — like a coffee barista, but you serve ISOs, tools, and docs.

STRICT RULES:
- Only mention files that appear in the REPOSITORY ITEMS section of this message. If that section is empty or has nothing relevant, say so plainly and suggest browsing categories — do NOT answer from general knowledge.
- Describe a file using ONLY the fields given for it (name, description, version, platform, architecture, file type, size). Do NOT add facts that are not in that data: no release dates, no code names, no "supported until" timelines, no feature lists, no history — even if you happen to know them. If a detail is not in the data, omit it or say it is not recorded here.
- Never invent or guess file names, versions, checksums, sizes, or download links.
- A bare "this", "this tool", "these", "it" or "that" refers ONLY to a file named earlier in the conversation. If nothing has been named yet, do NOT assume it means the first search result — ask the user which file they mean.
- Links: only ever write a relative /file/{slug} link using an exact slug from the data. Never write an absolute URL, never invent a domain, and never join several file names together into one link.
- Keep answers concise and about finding files. Prefer listing matching files with their /file/{slug} links over long prose.`;

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

/**
 * Rules for the "fill the gaps" helper. Unlike DRAFT_SYSTEM_PROMPT (which only
 * writes prose), this one classifies a known piece of software into the
 * catalogue's own controlled vocabulary so the empty metadata fields can be
 * pre-filled. The reply is strict JSON so the server can apply it field by
 * field, and every value is a suggestion the admin can still override.
 */
const FILL_SYSTEM_PROMPT = `You complete missing metadata for an entry in a personal software catalogue.

You are given the fields an admin has already filled in and the list of fields that are still empty. Using widely-documented, factual knowledge about the named software, propose values for ONLY the empty fields.

Rules:
- Never change a field the admin already filled — only suggest for the ones listed as empty.
- Never invent a version number, checksum, file size or download link. Leave those blank if you are not certain.
- Use ONLY these controlled values where they apply:
  - platform: one of windows, linux, macos, cross-platform
  - architecture: one of x86, x64, arm64, universal
  - file_type: a bare extension such as iso, exe, zip, msi, pdf, dmg, appimage, deb, tar.gz
  - license_status: one of public-domain, redistributable, proprietary, check-license, internal-only, abandonware
- tags: 3 to 8 short lowercase keywords, as a JSON array of strings.
- description: one factual sentence, max 160 characters.
- long_description: a markdown body of 120-250 words using "## " headings (Overview, Features, Requirements, Notes) and bullet lists. Put square-bracket placeholders like [confirm minimum RAM] where you are unsure.
- If you genuinely do not know a field, omit it from the JSON rather than guessing.

Reply with a single JSON object and nothing else. Example:
{"version":"","platform":"windows","architecture":"x64","file_type":"exe","license_status":"proprietary","tags":["editor","developer-tools"],"description":"...","long_description":"## Overview\\n..."}`;

/** Appended to the catalogue data instead of the system prompt: it is per-question. */
const ANSWER_TAIL = `Answer helpfully based ONLY on the repository data above. Do not add facts that are not in that data (no release dates, code names, support timelines or feature lists you were not given). If no relevant items are listed, say so clearly and suggest how to browse categories — do not answer from general knowledge. Aim for under 300 words, link to relevant items as relative /file/{slug} links using the exact slugs above, never as absolute URLs, and always finish your final sentence rather than stopping mid-thought.`;

/**
 * Sent instead of ANSWER_TAIL when a first attempt was cut off by the token
 * ceiling: the retry gets a larger budget *and* is told to be shorter, so the
 * second answer fits even if the model ignores the extra room.
 */
const RETRY_TAIL = `Answer helpfully based ONLY on the repository data above. Be brief: at most 150 words. Finish every sentence. Link to relevant items as /file/{slug}.`;

/** Extra room for the retry, capped so a huge configured ceiling is not doubled. */
const RETRY_MAX_TOKENS_CEILING = 8192;

export const BARISTA_SYSTEM_PROMPT = SYSTEM_PROMPT;

/** How much conversation is replayed to the model, and how much of each turn. */
export const MAX_CONTEXT_MESSAGES = 10;
const MAX_CONTEXT_CHARS = 2000;

/** Words that carry no search signal, so a question made only of them is a follow-up. */
const FOLLOW_UP_STOPWORDS = new Set([
  'a', 'about', 'all', 'also', 'am', 'an', 'and', 'any', 'anything', 'are', 'as', 'at',
  'be', 'both', 'but', 'by', 'can', 'could', 'did', 'do', 'does', 'doing', 'done',
  'for', 'from', 'get', 'give', 'good', 'has', 'have', 'how', 'i', 'if', 'in', 'is',
  'it', 'its', 'just', 'know', 'like', 'machine', 'make', 'me', 'more', 'my', 'need',
  'new', 'no', 'not', 'of', 'off', 'ok', 'on', 'one', 'only', 'or', 'other', 'our',
  'out', 'pc', 'please', 'run', 'runs', 'same', 'say', 'should', 'so', 'some', 'still',
  'such', 'sure', 'system', 'tell', 'than', 'that', 'the', 'their', 'them', 'then',
  'there', 'these', 'they', 'thing', 'this', 'those', 'to', 'too', 'us', 'use', 'used',
  'want', 'was', 'we', 'well', 'what', 'when', 'where', 'which', 'while', 'who', 'why',
  'will', 'with', 'work', 'works', 'would', 'you', 'your',
]);

/** Keep only well-formed chat turns, in order, with bounded content. */
export function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
    .map(m => ({ role: m.role, content: String(m.content ?? '').slice(0, MAX_CONTEXT_CHARS) }))
    .filter(m => m.content.trim().length > 0)
    .slice(-MAX_CONTEXT_MESSAGES);
}

/** The words in a question that could plausibly match a catalogue row. */
function contentWords(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}.+-]+/u)
    .filter(w => w.length > 1 && !FOLLOW_UP_STOPWORDS.has(w));
}

/**
 * "does that work on my pc?" has nothing to search for; "do you have Debian?"
 * does. Only the former should inherit the previous turns' search terms -
 * otherwise every question in a session drifts towards the first topic.
 */
export function isFollowUp(question) {
  return contentWords(question).length === 0;
}

/**
 * The query the catalogue search actually runs for one turn.
 *
 * A self-contained question is searched as typed. A follow-up is searched with
 * the search terms of the most recent turns that had any, so "does that work
 * on my pc?" still resolves to the item the user was just asking about.
 */
export function buildSearchQuery(question, messages = []) {
  const q = String(question || '').trim();
  if (!isFollowUp(q)) return q;

  const prior = [];
  for (const m of [...normalizeMessages(messages)].reverse()) {
    if (m.role !== 'user') continue;
    if (m.content.trim() === q) continue;
    const words = contentWords(m.content);
    if (words.length === 0) continue;
    prior.unshift(m.content.trim());
    if (prior.length >= 2) break;
  }
  return [...prior, q].join(' ').trim() || q;
}

/**
 * A one-line reminder of what "that" refers to, so the model resolves the
 * reference the same way the search did. Uses the last user turn with real
 * search terms, and names the top catalogue match when there is one.
 */
export function conversationSubject(messages = [], items = []) {
  const lastTopical = [...normalizeMessages(messages)]
    .reverse()
    .find(m => m.role === 'user' && contentWords(m.content).length > 0);
  const parts = [];
  if (lastTopical) parts.push(`the user's earlier question "${lastTopical.content.trim().slice(0, 200)}"`);
  if (items.length > 0) parts.push(`the repository item "${items[0].name}" (/file/${items[0].slug})`);
  return parts.join(', most likely ');
}

/**
 * Last resort when even the retry came back cut off: trim the dangling partial
 * sentence and say plainly that the answer was shortened. Never fabricates an
 * ending, and never leaves the visitor staring at half a word.
 */
export function completeCutOffAnswer(text) {
  const answer = String(text || '').trim();
  if (!answer) return answer;
  const lastStop = Math.max(answer.lastIndexOf('. '), answer.lastIndexOf('.\n'),
    answer.lastIndexOf('!'), answer.lastIndexOf('?'), answer.lastIndexOf('\n'));
  // Only trim when a clean break exists and is not throwing most of it away.
  const trimmed = lastStop > answer.length * 0.5
    ? answer.slice(0, lastStop + 1).trim()
    : answer;
  return `${trimmed}\n\n_(This answer was shortened because it reached the configured output limit. Ask a narrower question, or raise Max output tokens in Settings -> AI.)_`;
}

/** Controlled vocabularies for the gap-filling helper — the same the editor uses. */
const FILL_ENUMS = {
  platform: ['windows', 'linux', 'macos', 'cross-platform'],
  architecture: ['x86', 'x64', 'arm64', 'universal'],
  license_status: ['public-domain', 'redistributable', 'proprietary', 'check-license', 'internal-only', 'abandonware'],
};

/**
 * Pull the first balanced JSON object out of a model reply. Providers wrap the
 * object in prose or ```json fences often enough that JSON.parse on the raw
 * string is unreliable, so we scan for the outermost {...}.
 */
export function extractJsonObject(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try { return JSON.parse(slice); } catch { return null; }
      }
    }
  }
  return null;
}

/**
 * Validate a model's field suggestions against the form's own rules, keeping
 * only the requested targets. A value that is not in the controlled vocabulary
 * is dropped rather than passed through, so the editor never receives a
 * platform of "linux/mac" or a made-up license status.
 */
export function sanitizeFieldSuggestions(raw, targets) {
  if (!raw || typeof raw !== 'object') return {};
  const allow = new Set(targets);
  const out = {};

  const wantEnum = (key) => {
    const v = String(raw[key] ?? '').trim().toLowerCase();
    if (v && FILL_ENUMS[key].includes(v)) out[key] = v;
  };

  if (allow.has('platform')) wantEnum('platform');
  if (allow.has('architecture')) wantEnum('architecture');
  if (allow.has('license_status')) wantEnum('license_status');

  if (allow.has('file_type') && raw.file_type != null) {
    const ft = String(raw.file_type).trim().toLowerCase().replace(/^\.+/, '');
    if (ft && /^[a-z0-9.]{1,12}$/.test(ft)) out.file_type = ft;
  }

  if (allow.has('version') && raw.version != null) {
    const v = String(raw.version).trim();
    // Only accept a version that looks like one; never a placeholder sentence.
    if (v && v.length <= 40 && /\d/.test(v) && !/\s/.test(v)) out.version = v;
  }

  if (allow.has('tags') && raw.tags != null) {
    const list = Array.isArray(raw.tags)
      ? raw.tags
      : String(raw.tags).split(',');
    const tags = list
      .map(t => String(t).trim().toLowerCase())
      .filter(t => t && t.length <= 30)
      .slice(0, 8);
    if (tags.length) out.tags = Array.from(new Set(tags));
  }

  if (allow.has('description') && raw.description != null) {
    const d = String(raw.description).trim().replace(/\s+/g, ' ').slice(0, 480);
    if (d) out.description = d;
  }

  if (allow.has('long_description') && raw.long_description != null) {
    const b = String(raw.long_description).trim().slice(0, 5000);
    if (b) out.long_description = b;
  }

  return out;
}

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
    const { limit = 5 } = options;
    const messages = normalizeMessages(options.messages);

    // 1. Search repository metadata first - this is mandatory, and it is what
    //    the answer is checked against.
    // A follow-up like "does that work on my pc?" carries no searchable words
    // of its own, so the earlier turns supply them. Only follow-ups borrow
    // context: a fresh, self-contained question must not be dragged back to
    // the previous topic.
    const searchQuery = buildSearchQuery(question, messages);
    const searchResults = searchService.search({
      q: searchQuery,
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

  /**
   * One provider round-trip, plus a single retry when the answer was cut off.
   *
   * A reply that stops mid-sentence is worse than a short one, and the
   * provider tells us when its token ceiling caused that (finish_reason
   * "length" / "MAX_TOKENS"). Retrying once with more room and a tighter word
   * budget is bounded work and fixes the case that actually happens; if the
   * retry is cut off too, the longer of the two answers is returned with an
   * honest note rather than a dangling sentence.
   */
  async askWithProvider(question, items, faqs, cfg, messages = []) {
    const first = await generate({
      system: SYSTEM_PROMPT,
      prompt: this.buildContext(items, faqs, question, messages),
      cfg,
      kind: 'ask',
    });

    if (!first.truncated) {
      const answer = this.sanitizeAnswer(String(first.text || '').trim());
      return answer || this.ruleBasedAnswer(question, items, faqs);
    }

    const retryCfg = {
      ...cfg,
      maxTokens: Math.min(RETRY_MAX_TOKENS_CEILING, Math.max(cfg.maxTokens * 2, 2048)),
    };
    let second = null;
    try {
      second = await generate({
        system: SYSTEM_PROMPT,
        prompt: this.buildContext(items, faqs, question, messages, { tail: RETRY_TAIL }),
        cfg: retryCfg,
        kind: 'ask',
      });
    } catch (e) {
      // A failed retry must not lose the (partial) answer we already have.
      console.warn('[ai] retry after truncation failed:', redact(e.message, cfg.apiKey));
    }

    if (second && !second.truncated && String(second.text || '').trim()) {
      const answer = this.sanitizeAnswer(String(second.text).trim());
      if (answer) return answer;
    }

    const firstText = String(first.text || '').trim();
    const secondText = String(second?.text || '').trim();
    const best = secondText.length > firstText.length ? secondText : firstText;
    const answer = this.sanitizeAnswer(completeCutOffAnswer(best));
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
  buildContext(items, faqs, question, messages = [], { tail = ANSWER_TAIL } = {}) {
    let ctx = '';

    const recentMessages = normalizeMessages(messages).slice(-MAX_CONTEXT_MESSAGES);

    if (recentMessages.length > 0) {
      const subject = conversationSubject(recentMessages, items);
      ctx += `\nRECENT CONVERSATION CONTEXT (oldest first):
Use this only to understand references and conversational context.
Pronouns and short follow-ups such as "that", "it", "this one" or "does that work on my pc?"
refer to the most recent file or topic discussed below.
Repository facts must still come from the REPOSITORY ITEMS section below.

${recentMessages.map(m =>
  `${m.role === 'user' ? 'User' : 'Barista'}: ${String(m.content || '').slice(0, MAX_CONTEXT_CHARS)}`
).join('\n')}
${subject ? `\nCurrent subject of the conversation: ${subject}\n` : ''}
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

    ctx += `\nCURRENT USER QUESTION: ${question}\n\n${tail}`;

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
    if (!answer) return answer;

    // 1. Collapse any ABSOLUTE url that points at one of our own file pages back
    //    to a relative /file/{slug} link. The model was handed item names and
    //    slugs and sometimes stitched them into a full URL on a guessed domain
    //    (e.g. https://espress0.duckdns.org/file/... , or a markdown link whose
    //    text mashed several file names together). A relative link is what the
    //    frontend renders, and it can never point off-site.
    //    First, markdown links [text](<abs>/file/slug) -> [text](/file/slug).
    answer = answer.replace(
      /\]\(\s*https?:\/\/[^\s)]*?\/file\/([a-z0-9-]+)\s*\)/gi,
      '](/file/$1)'
    );
    //    Then any remaining bare absolute .../file/slug URL -> /file/slug.
    answer = answer.replace(
      /https?:\/\/[^\s)]*?\/file\/([a-z0-9-]+)/gi,
      '/file/$1'
    );

    // 2. If the answer still carries an off-site http link and no repo file
    //    link, warn: it is not something we can vouch for.
    const hasHttp = /https?:\/\//i.test(answer);
    const hasItemLink = answer.includes('/file/');

    if (hasHttp && !hasItemLink) {
      // Compare parsed hostnames, not substrings. `url.includes('github.com')`
      // is just as true for `github.com.attacker.example`, which is precisely
      // the link that should earn the disclaimer. Links to our own file pages
      // never reach this check: step 1 collapsed them to relative /file/... .
      const allowedHosts = ['drive.google.com', 'docs.google.com', 'onedrive.live.com', '1drv.ms', 'sharepoint.com', 'github.com'];
      const isAllowedHost = (rawUrl) => {
        let host;
        try {
          host = new URL(rawUrl).hostname.toLowerCase().replace(/\.$/, '');
        } catch {
          return false; // unparseable: treat as unverified
        }
        return allowedHosts.some(d => host === d || host.endsWith(`.${d}`));
      };
      const urls = answer.match(/https?:\/\/[^\s]+/g) || [];
      const suspicious = urls.filter(url => !isAllowedHost(url));

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

  /**
   * "Fill in the gaps": look at the metadata an admin has entered so far and
   * suggest values for the fields that are still empty, using the model's
   * knowledge of the named software.
   *
   * This differs from describeItem (which only writes the two prose fields)
   * and from the URL autofill (which scrapes a page): it needs no URL and can
   * classify platform / architecture / file type / license / tags as well as
   * write copy. Every returned value is a *suggestion* keyed by field name, so
   * the caller applies only the fields the admin approves and never overwrites
   * something already filled in.
   *
   * @param {object} meta   the current form values (same shape as describeItem
   *                         plus optional current values for the fields below)
   * @param {string[]} want the field names the admin wants filled; defaults to
   *                         every gap-fillable field that is currently empty.
   * @returns {{ suggestions: object, filledFields: string[], usedAI: boolean, provider?: string, aiError?: string }}
   */
  async suggestFields(meta = {}, want = null) {
    const name = String(meta.name || '').trim();
    if (!name) throw new Error('name is required to suggest fields');

    // The fields this helper is allowed to propose. Anything not here (slug,
    // download URLs, checksums, file size) is deliberately excluded: it is
    // instance-specific and must not be guessed.
    const FILLABLE = [
      'version', 'platform', 'architecture', 'file_type',
      'license_status', 'tags', 'description', 'long_description',
    ];

    const current = {
      version: String(meta.version || '').trim(),
      platform: String(meta.platform || '').trim(),
      architecture: String(meta.architecture || '').trim(),
      file_type: String(meta.file_type || '').trim(),
      license_status: String(meta.license_status || '').trim(),
      tags: Array.isArray(meta.tags)
        ? meta.tags.filter(Boolean).map(String)
        : String(meta.tags || '').split(',').map(s => s.trim()).filter(Boolean),
      description: String(meta.description || '').trim(),
      long_description: String(meta.long_description || '').trim(),
    };

    const isEmpty = (key) => {
      const v = current[key];
      if (key === 'tags') return v.length === 0;
      // check-license is the form's default, i.e. "not decided yet".
      if (key === 'license_status') return !v || v === 'check-license';
      return !v;
    };

    // Which fields to fill: an explicit request wins, otherwise every empty one.
    const requested = Array.isArray(want) && want.length
      ? want.filter(k => FILLABLE.includes(k))
      : FILLABLE.filter(isEmpty);
    const targets = requested.filter(isEmpty);

    if (targets.length === 0) {
      return { suggestions: {}, filledFields: [], usedAI: false, nothingToFill: true };
    }

    const clean = {
      name,
      version: current.version,
      category: String(meta.category || '').trim(),
      platform: current.platform,
      architecture: current.architecture,
      file_type: current.file_type,
      tags: current.tags.slice(0, 15),
      notes: String(meta.notes || '').trim().slice(0, 1000),
      targets,
    };

    const cfg = await this.aiConfig();
    if (cfg.enabled && cfg.provider !== 'none') {
      try {
        const suggestions = await this.fillWithProvider(clean, cfg);
        if (suggestions && Object.keys(suggestions).length) {
          return {
            suggestions,
            filledFields: Object.keys(suggestions),
            usedAI: true,
            provider: cfg.provider,
          };
        }
      } catch (e) {
        this.lastError = redact(`[${cfg.provider}] fill failed: ${e.message}`, cfg.apiKey).slice(0, 200);
        console.warn('[ai] fill failed:', redact(e.message, cfg.apiKey));
        return {
          suggestions: {},
          filledFields: [],
          usedAI: false,
          provider: cfg.provider,
          aiError: this.lastError,
        };
      }
    }

    // No model configured: say so plainly, the same way describeItem does.
    const aiError = this.lastError
      || (cfg.notes.length ? cfg.notes[cfg.notes.length - 1] : 'No AI model is configured — set one up in Settings → AI, or run ./espress0 ai for the free CLI.');
    return { suggestions: {}, filledFields: [], usedAI: false, provider: null, aiError };
  }

  /**
   * Ask the provider for the empty fields and parse its JSON reply into a
   * sanitised suggestion map. Only the requested target fields survive, and
   * each value is validated against the same controlled vocabulary the form
   * uses so a hallucinated "linux/mac" or "v.latest" never reaches the editor.
   */
  async fillWithProvider(meta, cfg) {
    const known = [
      `Name: ${meta.name}`,
      meta.version && `Version: ${meta.version}`,
      meta.category && `Category: ${meta.category}`,
      meta.platform && `Platform: ${meta.platform}`,
      meta.architecture && `Architecture: ${meta.architecture}`,
      meta.file_type && `File type: ${meta.file_type}`,
      meta.tags.length && `Tags: ${meta.tags.join(', ')}`,
      meta.notes && `Admin notes: ${meta.notes}`,
    ].filter(Boolean).join('\n');

    const prompt = `Already filled in:
${known}

Empty fields to suggest values for (only these): ${meta.targets.join(', ')}

Return the JSON object.`;

    const out = (await generate({ system: FILL_SYSTEM_PROMPT, prompt, cfg, kind: 'draft' }).then(r => r.text)) || '';
    if (!out.trim()) return null;

    const parsed = extractJsonObject(out);
    if (!parsed) return null;

    return sanitizeFieldSuggestions(parsed, meta.targets);
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

  /**
   * Chat starters for the empty Barista panel.
   *
   * These used to be a fixed list full of demonstratives with no antecedent —
   * "What does this tool do?", "What is the difference between these two
   * releases?". Opened from a cold chat there is no "this tool", so the model
   * would invent one (typically the first ISO it found) and answer about
   * software the user never mentioned. That is the hallucination we are killing
   * at the source: a starter must be answerable on its own.
   *
   * So they are built from the catalogue itself — real item names, real
   * categories, the platforms that actually exist here — and every one is
   * self-contained. On an empty catalogue we fall back to generic-but-still-
   * self-contained prompts (no "this"/"these"/"that").
   */
  async getSuggestions() {
    try {
      const db = getDb();

      // A few real, published item names to seed concrete questions.
      const items = db.prepare(`
        SELECT name, platform, architecture, category_id
        FROM items
        WHERE published = 1 AND name IS NOT NULL AND TRIM(name) != ''
        ORDER BY COALESCE(download_count, 0) DESC, id DESC
        LIMIT 40
      `).all();

      const categories = db.prepare(`
        SELECT c.name
        FROM categories c
        WHERE EXISTS (SELECT 1 FROM items i WHERE i.category_id = c.id AND i.published = 1)
        ORDER BY c.sort_order, c.name
        LIMIT 6
      `).all().map(r => r.name).filter(Boolean);

      const platforms = [...new Set(items.map(i => i.platform).filter(Boolean))];
      const suggestions = [];

      // Name a real file, so "what does X do?" resolves to something that exists.
      if (items[0]) suggestions.push(`What is ${items[0].name}?`);
      if (items[1]) suggestions.push(`Tell me about ${items[1].name}`);

      // Category-scoped browsing prompts.
      if (categories[0]) suggestions.push(`What do you have in ${categories[0]}?`);
      if (categories[1]) suggestions.push(`Show me ${categories[1]}`);

      // Platform/architecture prompts, only for platforms actually present.
      if (platforms.includes('windows')) suggestions.push('Which files are for Windows?');
      if (platforms.includes('linux')) suggestions.push('Which Linux files do you have?');
      if (platforms.includes('macos')) suggestions.push('Do you have anything for macOS?');
      if (items.some(i => /arm/i.test(i.architecture || ''))) {
        suggestions.push('Do you have any ARM64 files?');
      }

      // Always-useful, self-contained catalogue questions.
      suggestions.push('Which file is the smallest?');
      suggestions.push('How do I verify a file with its checksum?');

      // De-dupe, keep order, cap at 8.
      const unique = [...new Set(suggestions)].slice(0, 8);
      if (unique.length >= 4) return unique;
    } catch (e) {
      console.warn('[ai] suggestion build failed, using defaults:', e.message);
    }

    // Fallback: generic but still self-contained (no dangling "this"/"these").
    return [
      'What operating system ISOs do you have?',
      'Which files are for Windows?',
      'Do you have any Linux tools?',
      'Which file is the smallest?',
      'What categories can I browse?',
      'How do I verify a file with its checksum?',
    ];
  }
}

export const aiService = new AIService();
