import { config } from '../config.js';
import { settingsService } from './settingsService.js';
import { GEMINI_DEFAULT_BASE, OPENAI_DEFAULT_BASE, GEMINI_DEFAULT_MODEL } from './aiProviders.js';

/**
 * Single source of truth for "what should the AI features do right now".
 *
 * Two places can configure this: `.env` (deployment-time, and the only place a
 * key may live) and the admin Settings page (`site_settings`, editable without
 * a deploy). A DB value wins over the environment, an empty/invalid DB value
 * falls back to it, and `auto` picks whatever this box can actually do.
 *
 * The API key is deliberately NOT a site setting: site_settings is plaintext,
 * readable through GET /api/admin/settings, dumped by every backup and shipped
 * to off-box storage. A secret that round-trips through an HTTP API and a
 * database backup is not a secret, so it stays in .env where the app already
 * keeps JWT_SECRET and ENCRYPTION_KEY.
 */

export const AI_PROVIDERS = ['auto', 'gemini', 'openai', 'tgpt', 'none'];
const PROVIDER_ALIASES = {
  '': 'auto',
  google: 'gemini',
  'google-gemini': 'gemini',
  generative: 'gemini',
  'openai-compatible': 'openai',
  openai_compat: 'openai',
  openrouter: 'openai',
  ollama: 'openai',
  lmstudio: 'openai',
  llamacpp: 'openai',
  'vllm': 'openai',
  cli: 'tgpt',
  off: 'none',
  disabled: 'none',
  none: 'none',
  auto: 'auto',
};

// The browser gives an AI request AI_TIMEOUT (60s) and the server must answer
// inside it so the metadata fallback still arrives; see backend/tests/ai.test.js.
const CLIENT_BUDGET_MS = 60000;

/**
 * Output-token budget for one answer.
 *
 * The old 1024 default was enough for the 300-word answer the prompt asks for
 * only when the reply carried no lists and no links; with either, the provider
 * hit its ceiling and the visitor was shown a sentence that stopped mid-word.
 * 2048 leaves headroom, and the floor keeps an admin from configuring a value
 * that guarantees the same cutoff.
 */
export const DEFAULT_MAX_TOKENS = 2048;
export const MIN_MAX_TOKENS = 256;
const ASK_TIMEOUT_MAX = 55000;

function str(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

/** Env first, then a non-empty DB override. */
function pick(dbValue, envValue) {
  const fromDb = str(dbValue);
  return fromDb || str(envValue);
}

function number(value, fallback, min, max, label) {
  const raw = str(value);
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    console.warn(`[ai] Ignoring ${label}="${raw}" (expected ${min}-${max}); using ${fallback}.`);
    return fallback;
  }
  return n;
}

function normalizeProvider(raw) {
  const value = str(raw).toLowerCase();
  if (AI_PROVIDERS.includes(value)) return value;
  return PROVIDER_ALIASES[value] ?? null;
}

/**
 * An admin edit must never be able to take the AI down: the settings table can
 * be missing (unit tests, a fresh checkout before migrate.js) and reading it
 * then yields "no override", which is exactly the right answer.
 */
function setting(key) {
  try {
    return settingsService.getSetting(key, null);
  } catch {
    return null;
  }
}

/** The production entry point: live .env config plus the admin settings table. */
export function resolveAi(opts = {}) {
  return decide({ env: config.ai, settings: setting, ...opts });
}

/**
 * The whole decision, as a pure function: `env` is the .env-derived block and
 * `settings` reads the admin table. Split out because precedence and fallback
 * logic is the part that needs testing, and testing it through module re-import
 * would pin a stale config.js.
 *
 * @param {object} args
 * @param {object} args.env                 config.ai
 * @param {(key: string) => any} [args.settings]
 * @param {boolean} [args.tgptAvailable]     "tgpt is installed and runs"
 * @param {string} [args.tgptBinary]         the binary that probe settled on, which
 *        is not necessarily the configured path (a tgpt found on PATH still has to
 *        be the one that gets spawned)
 * @returns {object} resolved config, plus `notes` explaining every fallback that fired
 */
export function decide({ env, settings = () => null, tgptAvailable = false, tgptBinary = null }) {
  const notes = [];
  const requested = normalizeProvider(pick(settings('ai_provider'), env.provider));
  if (!requested) {
    notes.push(`AI_PROVIDER="${str(env.provider)}" is not one of ${AI_PROVIDERS.join('/')}; using auto.`);
  }
  // Keep the operator's effective choice alongside the provider it resolves to.
  // aiService uses this to decide whether the tgpt fallback is relevant before
  // it starts a subprocess probe. In particular, an explicit OpenAI-compatible
  // endpoint must never wait for an unrelated `tgpt --version` command.
  const requestedProvider = requested || 'auto';
  let provider = requestedProvider;

  const apiKey = env.apiKey || '';
  // A key only implies "Gemini is intended" if it was set under one of the
  // names that mean that. An existing deployment's TGPT_API_KEY is the key for
  // TGPT_PROVIDER's service, not a Google key, and treating it as one would
  // retarget every AI call at Google with an sk- credential on the next
  // restart - a silent break on upgrade for exactly that box.
  const source = env.apiKeySource || (apiKey ? 'AI_API_KEY' : '');
  const geminiKey = !!apiKey && source !== 'TGPT_API_KEY';
  let autoPicked = null;
  if (provider === 'auto') {
    // A key present means a key-backed provider was clearly intended; without
    // one, keep the free tgpt CLI working if it is installed (that is how every
    // existing deployment runs today), else metadata-only.
    if (geminiKey) { provider = 'gemini'; autoPicked = `a Gemini API key is configured (${source})`; }
    else if (tgptAvailable) { provider = 'tgpt'; autoPicked = 'tgpt is installed and no API key is set'; }
    else provider = 'none';
  }

  if (provider === 'gemini' && apiKey && source === 'TGPT_API_KEY') {
    notes.push(`AI_PROVIDER=gemini but the only key found is TGPT_API_KEY, which is the `
      + `key for tgpt's provider. Set AI_API_KEY (or GEMINI_API_KEY) for the Gemini backend.`);
  }

  const needsKey = provider === 'gemini';
  if (needsKey && !apiKey) {
    // A pre-existing .env can enable a key-backed provider without ever having
    // had a key; say so once instead of failing every request mysteriously.
    if (tgptAvailable) {
      notes.push(`AI_PROVIDER=${provider} needs AI_API_KEY (or GEMINI_API_KEY) in .env; falling back to tgpt.`);
      provider = 'tgpt';
    } else {
      notes.push(`AI_PROVIDER=${provider} needs AI_API_KEY (or GEMINI_API_KEY) in .env; answers will come from metadata search.`);
      provider = 'none';
    }
  }

  let format = normalizeFormat(pick(settings('ai_format'), env.format), provider, notes);

  // Not validated here: an endpoint that resolves to a metadata address must be
  // refused when the request is made, not when the setting was saved (see
  // aiProviders.generate -> assertConfiguredEndpoint). Resolving also keeps
  // saving a settings form from depending on DNS being reachable.
  const baseUrlRaw = pick(settings('ai_base_url'), env.baseUrl);
  const baseUrl = baseUrlRaw
    || (format === 'gemini' ? GEMINI_DEFAULT_BASE : (format === 'openai' ? OPENAI_DEFAULT_BASE : ''));

  const resolved = {
    enabled: env.enabled !== false && str(settings('ai_enabled')) !== 'false',
    // Internal resolution detail. Public/admin serializers below deliberately
    // whitelist their fields, so this never exposes additional configuration.
    requestedProvider,
    provider,
    format,
    model: pick(settings('ai_model'), env.model) || (format === 'gemini' && !baseUrlRaw ? GEMINI_DEFAULT_MODEL : ''),
    baseUrl,
    baseUrlIsDefault: !baseUrlRaw,
    apiKey,
    keyConfigured: !!apiKey,
    keySource: apiKey ? source : '',
    temperature: number(pick(settings('ai_temperature'), env.temperature), 0.2, 0, 2, 'ai_temperature'),
    maxTokens: number(pick(settings('ai_max_tokens'), env.maxTokens), DEFAULT_MAX_TOKENS, MIN_MAX_TOKENS, 32768, 'ai_max_tokens'),
    timeoutMs: clampBudget(number(pick(settings('ai_timeout_ms'), env.timeoutMs), env.timeoutMs, 2000, 600000, 'ai_timeout_ms'), 'ai_timeout_ms', notes),
    draftTimeoutMs: clampBudget(number(pick(settings('ai_draft_timeout_ms'), env.draftTimeoutMs), env.draftTimeoutMs, 2000, 600000, 'ai_draft_timeout_ms'), 'ai_draft_timeout_ms', notes),
    allowPrivateBaseUrl: env.allowPrivateBaseUrl === true,
    tgpt: {
      binary: tgptBinary || env.tgpt.binaryPath,
      // Env-only on purpose: tgpt's own provider list (phind, openai, groq...)
      // is a CLI detail, and a settings row nobody can validate from the UI is
      // worse than none.
      provider: env.tgpt.provider || '',
      model: env.tgpt.model || '',
      available: tgptAvailable,
    },
    notes,
    autoPicked,
  };

  return resolved;
}

/** Budget must stay below the browser's or the fallback answer never arrives. */
function clampBudget(value, label, notes) {
  if (value > ASK_TIMEOUT_MAX) {
    notes.push(`${label}=${value} ms is above the browser's ${CLIENT_BUDGET_MS} ms request budget; clamped to ${ASK_TIMEOUT_MAX} ms.`);
    return ASK_TIMEOUT_MAX;
  }
  return value;
}

function normalizeFormat(raw, provider, notes) {
  const value = str(raw).toLowerCase();
  if (value === 'gemini' || value === 'openai' || value === 'tgpt') return value;
  if (value) notes.push(`AI_FORMAT="${value}" is unknown; deriving it from the provider instead.`);
  if (provider === 'tgpt') return 'tgpt';
  if (provider === 'openai') return 'openai';
  if (provider === 'gemini') return 'gemini';
  return 'none';
}

/**
 * Public shape of /api/ai/status. Never includes the key, the base URL or
 * internal error text - those live in describeAiForAdmin().
 */
export function describeAi(resolved) {
  return {
    enabled: resolved.enabled,
    ready: resolved.enabled && resolved.provider !== 'none',
    provider: resolved.provider === 'none' ? null : resolved.provider,
    model: resolved.provider === 'tgpt' ? (resolved.tgpt.model || resolved.tgpt.provider || 'tgpt default') : (resolved.model || null),
    fallback: 'rule-based metadata search',
  };
}

/** Admin shape: adds the resolved endpoint and why anything fell back. */
export function describeAiForAdmin(resolved, lastError = null) {
  return {
    ...describeAi(resolved),
    format: resolved.format,
    baseUrl: resolved.baseUrl,
    baseUrlIsDefault: resolved.baseUrlIsDefault,
    keyConfigured: resolved.keyConfigured,
    keyHint: resolved.keyConfigured
      ? `set from ${resolved.keySource} in .env; never stored in the database`
      : 'not set - add AI_API_KEY or GEMINI_API_KEY to .env and restart',
    temperature: resolved.temperature,
    maxTokens: resolved.maxTokens,
    timeoutMs: resolved.timeoutMs,
    draftTimeoutMs: resolved.draftTimeoutMs,
    tgptBinary: resolved.tgpt.binary,
    tgptAvailable: resolved.tgpt.available,
    tgptProvider: resolved.tgpt.provider || null,
    notes: resolved.notes,
    error: lastError,
  };
}

export const aiConfigService = { resolveAi, describeAi, describeAiForAdmin, AI_PROVIDERS };
