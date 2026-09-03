import { execFile, spawn } from 'child_process';
import fs from 'fs';
import { promisify } from 'util';
import { assertConfiguredEndpoint } from '../lib/safeFetch.js';

const execFileAsync = promisify(execFile);

/**
 * AI transport: turns (system prompt, user prompt) into text, whichever
 * backend is configured. Deliberately dependency-free - Node 18+ has fetch,
 * AbortSignal.timeout and URL, so a Gemini key needs no SDK.
 *
 *   gemini  Google's generateContent REST endpoint (the default).
 *   openai  Anything speaking POST {base}/chat/completions: OpenAI itself,
 *           OpenRouter, a company gateway, or a local Ollama / LM Studio /
 *           llama.cpp / vLLM server.
 *   tgpt    The tgpt CLI, spawned with the prompt on stdin. Kept because it is
 *           free, needs no key, and is what this repo's Docker image installs.
 *
 * Every function here throws Error with a `.code` in
 * ('config' | 'timeout' | 'http' | 'blocked' | 'unavailable' | 'empty') so
 * callers can decide between "fall back to metadata" and "tell the admin".
 */

// ------------------------------------------------------------------ hardening

const PROVIDER_PATTERN = /^[a-zA-Z0-9_.-]{1,32}$/;   // tgpt sub-provider names
// Models may contain slashes (meta-llama/…) colons (llama3:8b) and dots.
const MODEL_PATTERN = /^[a-zA-Z0-9_.:/+-]{1,80}$/;

/** Keys must never reach a log line or an admin-facing error string. */
export function redact(text, ...secrets) {
  let out = String(text ?? '');
  for (const s of secrets) {
    const secret = String(s || '');
    if (secret.length >= 6) out = out.split(secret).join('[redacted]');
  }
  return out
    .replace(/AIza[0-9A-Za-z_.-]{10,}/g, '[redacted-key]')
    .replace(/sk-(?:proj-)?[0-9A-Za-z_-]{10,}/g, '[redacted-key]')
    .replace(/(api[_-]?key|authorization["']?\s*[:=])\s*[^\s,}"]+/gi, '$1 [redacted]');
}

// ---------------------------------------------------------------------- fetch

const MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * Read a response body with a byte ceiling. A misconfigured base URL pointed at
 * some other service can answer with gigabytes; the tgpt path this replaced
 * capped its output the same way, so the cap carries over.
 */
async function readCapped(res, maxBytes = MAX_RESPONSE_BYTES) {
  if (!res.body) return (await res.text()).slice(0, maxBytes);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
    if (out.length > maxBytes) { truncated = true; await reader.cancel().catch(() => {}); break; }
  }
  try { reader.releaseLock(); } catch { /* already released by cancel() */ }
  return truncated ? out.slice(0, maxBytes) : out;
}

/**
 * POST JSON and return the parsed body, with the timeout, redirect and
 * error-text rules every provider call needs.
 */
async function postJson(urlStr, { headers, body, timeoutMs, key, format = 'json' }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  let res;
  try {
    res = await fetch(urlStr, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      // Following a redirect would let an allowlisted URL bounce the request -
      // and the key - to one that is not.
      redirect: 'manual',
    });
  } catch (e) {
    const aborted = e?.name === 'AbortError' || ctrl.signal.aborted;
    throw Object.assign(new Error(aborted
      ? `timed out after ${timeoutMs} ms`
      : `request to ${new URL(urlStr).host} failed (${format} format): ${redact(e?.message || e, key)}`
        + (e?.cause?.message ? ` (${redact(e.cause.message, key)})` : '')), {
      code: aborted ? 'timeout' : 'unavailable',
    });
  } finally {
    clearTimeout(timer);
  }

  if (res.status >= 300 && res.status < 400) {
    throw Object.assign(new Error(`endpoint redirected (HTTP ${res.status}); refusing to follow it`), { code: 'config' });
  }

  const text = await readCapped(res);
  if (!res.ok) {
    const detail = redact(text.replace(/\s+/g, ' ').trim().slice(0, 300), key);
    const hint = res.status === 401 || res.status === 403
      ? ' - the API key is missing, revoked, or restricted below what this endpoint needs'
      : res.status === 404
        ? ' - usually a model name this endpoint does not serve'
        : res.status === 429
          ? ' - quota or rate limit; the free tier for this key is used up'
          : '';
    throw Object.assign(new Error(`HTTP ${res.status}${hint}${detail ? `: ${detail}` : ''}`, { key }), { code: 'http' });
  }

  try { return JSON.parse(text); } catch {
    throw Object.assign(new Error(`endpoint returned non-JSON: ${redact(text.slice(0, 200), key)}`), { code: 'http' });
  }
}

// -------------------------------------------------------------------- gemini

export const GEMINI_DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash';

/**
 * generateContent, not the newer Interactions API: this call needs a system
 * instruction plus a token ceiling, and generateContent's shape has been
 * stable across every Gemini model generation so far. A proxy that speaks the
 * newer shape works too - set AI_FORMAT=openai for it.
 */
export async function callGemini({ system, prompt, cfg }) {
  const model = cfg.model || GEMINI_DEFAULT_MODEL;
  if (!MODEL_PATTERN.test(model)) {
    throw Object.assign(new Error(`ignoring invalid model name: ${redact(model, cfg.apiKey)}`), { code: 'config' });
  }
  const base = cfg.baseUrl || GEMINI_DEFAULT_BASE;
  // The key goes in a header, never in ?key=..., so it cannot end up in an
  // nginx access log, a proxy log, or the Error message a failed fetch carries.
  const url = `${base}/models/${encodeURIComponent(model)}:generateContent`;

  const generationConfig = {
    temperature: cfg.temperature,
    maxOutputTokens: cfg.maxTokens,
  };
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig,
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const data = await postJson(url, {
    headers: { 'x-goog-api-key': cfg.apiKey || '' },
    body,
    timeoutMs: cfg.timeoutMs,
    key: cfg.apiKey,
    format: 'gemini generateContent',
  });

  const blockReason = data?.promptFeedback?.blockReason;
  if (blockReason) {
    throw Object.assign(new Error(`the model declined to answer (safety: ${blockReason})`), { code: 'blocked' });
  }

  if (!Array.isArray(data?.candidates)) {
    // A 200 without candidates is almost always "this endpoint does not speak
    // generateContent" - the shape error has to say so, or the operator debugs
    // the wrong layer.
    throw Object.assign(new Error(
      'the endpoint answered but not in Gemini format (no "candidates" in the response) - if it speaks /chat/completions, set AI_FORMAT=openai'
    ), { code: 'http' });
  }
  const candidate = data.candidates[0];
  const text = (candidate?.content?.parts || [])
    .map(p => (typeof p?.text === 'string' ? p.text : ''))
    .join('');
  if (!text.trim()) {
    const why = candidate?.finishReason ? ` (finishReason: ${candidate.finishReason})` : '';
    throw Object.assign(new Error(`empty answer from ${model}${why}`), { code: 'empty' });
  }
  return { text: text.trim(), provider: 'gemini', model };
}

// ---------------------------------------------------------------- openai-compat

export const OPENAI_DEFAULT_BASE = 'https://api.openai.com/v1';

/**
 * Chat-completions. `baseUrl` is whatever the operator typed, with or without
 * the /chat/completions suffix, so a gateway mounted at an odd path works
 * without inventing another setting.
 */
export async function callOpenai({ system, prompt, cfg }) {
  const model = cfg.model;
  if (!model) {
    throw Object.assign(new Error(
      'this endpoint needs a model name - set AI_MODEL (e.g. gpt-4o-mini, llama3.1:8b, qwen2.5-coder)'
    ), { code: 'config' });
  }
  if (!MODEL_PATTERN.test(model)) {
    throw Object.assign(new Error(`ignoring invalid model name: ${redact(model, cfg.apiKey)}`), { code: 'config' });
  }
  const base = cfg.baseUrl || OPENAI_DEFAULT_BASE;
  const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  const data = await postJson(url, {
    // A local Ollama/llama.cpp server needs no Authorization header at all, and
    // sending `Bearer ` with an empty token makes some gateways answer 401.
    headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
    body: {
      model,
      messages,
      temperature: cfg.temperature,
      max_tokens: cfg.maxTokens,
      stream: false,
    },
    timeoutMs: cfg.timeoutMs,
    key: cfg.apiKey,
    format: 'openai chat/completions',
  });

  if (!Array.isArray(data?.choices)) {
    throw Object.assign(new Error(
      'the endpoint answered but not in chat/completions format (no "choices" in the response) - if it speaks Gemini generateContent, set AI_FORMAT=gemini'
    ), { code: 'http' });
  }
  const msg = data.choices[0]?.message;
  // Most servers return a string; a few gateways return a parts array.
  const text = Array.isArray(msg?.content)
    ? msg.content.map(p => (typeof p?.text === 'string' ? p.text : '')).join('')
    : (typeof msg?.content === 'string' ? msg.content : '');
  if (!text.trim()) {
    const why = data?.choices?.[0]?.finish_reason ? ` (finish_reason: ${data.choices[0].finish_reason})` : '';
    throw Object.assign(new Error(`empty answer from ${model}${why}`), { code: 'empty' });
  }
  return { text: text.trim(), provider: 'openai', model };
}

// ----------------------------------------------------------------------- tgpt

/**
 * Resolve which tgpt binary to run, preferring AI_TGPT_BINARY_PATH but falling
 * back to a tgpt on PATH. Previously a tgpt found via PATH marked the service
 * available while a fixed default path was what got spawned - install it with
 * a package manager (~/go/bin, ~/.local/bin) and every AI call died with ENOENT
 * even though `tgpt` worked fine in a shell.
 */
export async function findTgpt(configuredPath) {
  if (configuredPath && configuredPath !== 'tgpt' && fs.existsSync(configuredPath)) return configuredPath;
  try {
    return (await execFileAsync('which', ['tgpt'])).stdout.trim() || 'tgpt';
  } catch {
    return configuredPath && fs.existsSync(configuredPath) ? configuredPath : null;
  }
}

export function tgptRuns(binary) {
  if (!binary) return Promise.resolve(false);
  return execFileAsync(binary, ['--version']).then(() => true, () => false);
}

/**
 * Run tgpt with the prompt on stdin.
 *
 * Replaces the previous `cat /tmp/tgpt-prompt-<ts>.txt | tgpt ...` shell
 * pipeline, which (a) invoked a shell with interpolated values and (b) wrote
 * predictable filenames into a world-writable directory, so any local user
 * could pre-create a symlink there and have us clobber a file or feed the model
 * their own prompt.
 *
 * The key (when the chosen sub-provider needs one) goes in via AI_API_KEY in
 * the child's environment, never on the command line where other local users
 * could read it from ps(1).
 */
export async function callTgpt({ system, prompt, cfg }) {
  const binary = cfg.tgpt?.binary;
  if (!binary) {
    throw Object.assign(new Error('tgpt is not installed (./espress0 ai installs it)'), { code: 'unavailable' });
  }

  const args = [];
  const sub = cfg.tgpt.provider || '';
  if (sub && PROVIDER_PATTERN.test(sub)) args.push('--provider', sub);
  const subModel = cfg.tgpt.model || '';
  // Model names are provider-specific ('gpt-4o-mini' means nothing to phind),
  // so only pass one alongside an explicit provider.
  if (sub && subModel && MODEL_PATTERN.test(subModel)) args.push('--model', subModel);
  args.push('--quiet');

  const fullPrompt = system ? `${system}\n\n${prompt}` : prompt;
  const env = { ...process.env, AI_API_KEY: cfg.apiKey || process.env.AI_API_KEY || '' };
  if (!env.AI_API_KEY) delete env.AI_API_KEY;

  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, env });
    let out = '';
    let err = '';
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, Object.assign(new Error(`timed out after ${cfg.timeoutMs} ms`), { code: 'timeout' }));
    }, cfg.timeoutMs);

    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.length > MAX_RESPONSE_BYTES) { child.kill('SIGKILL'); out = out.slice(0, MAX_RESPONSE_BYTES); }
    });
    child.stderr.on('data', (chunk) => { if (err.length < 8192) err += chunk; });
    child.on('error', (e) => finish(reject, Object.assign(new Error(redact(e.message, cfg.apiKey)), { code: 'unavailable' })));
    child.on('close', () => {
      if (!out.trim() && err.trim()) {
        return finish(reject, Object.assign(new Error(redact(err.trim().slice(0, 300), cfg.apiKey)), { code: 'http' }));
      }
      if (!out.trim()) return finish(reject, Object.assign(new Error('tgpt returned nothing'), { code: 'empty' }));
      finish(resolve, { text: out.trim(), provider: 'tgpt', model: subModel || sub || 'tgpt default' });
    });

    child.stdin.on('error', () => {}); // tgpt may exit before we finish writing
    child.stdin.end(fullPrompt);
  });
}

// ------------------------------------------------------------------- dispatch

export const TRANSPORTS = { gemini: callGemini, openai: callOpenai, tgpt: callTgpt };

/**
 * @param {object} cfg resolved config from aiConfig.resolveAi()
 * @param {'ask'|'draft'} kind which timeout budget to use
 */
export async function generate({ system = '', prompt, cfg, kind = 'ask' }) {
  const run = TRANSPORTS[cfg.format];
  if (!run) {
    throw Object.assign(new Error(`unknown AI format: ${cfg.format}`), { code: 'config' });
  }

  let baseUrl = cfg.baseUrl;
  // The shipped defaults are public hosts this file controls, so they skip the
  // DNS round-trip; anything an operator typed is checked here, at request
  // time, rather than when the setting was saved - a host that was safe at
  // 3am is not necessarily safe now.
  if (cfg.format !== 'tgpt' && baseUrl && !cfg.baseUrlIsDefault) {
    try {
      const url = await assertConfiguredEndpoint(baseUrl, {
        allowPrivate: cfg.allowPrivateBaseUrl,
        // A model server on this very box is the most common non-default
        // endpoint; aiConfig keeps the flag for reaching further into the LAN.
        allowLoopback: true,
      });
      baseUrl = url.origin + url.pathname.replace(/\/$/, '');
    } catch (e) {
      throw Object.assign(new Error(`AI_BASE_URL refused: ${e.message}`), { code: 'config' });
    }
  }

  const call = {
    ...cfg,
    baseUrl,
    timeoutMs: kind === 'draft' ? cfg.draftTimeoutMs : cfg.timeoutMs,
  };
  if (cfg.format !== 'tgpt' && !call.baseUrl) {
    throw Object.assign(new Error('no AI base URL resolved for this provider'), { code: 'config' });
  }
  return run({ system, prompt, cfg: call });
}
