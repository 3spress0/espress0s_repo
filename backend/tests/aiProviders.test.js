import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * AI provider transport tests: dependency-free (no database, no network, no
 * native modules) so they run anywhere with `node --test tests/ai.test.js`.
 *
 * These cover the parts of "use a Gemini key instead of tgpt" that a config
 * review cannot catch: what the request actually looks like on the wire, and
 * what happens when the endpoint is wrong, slow, or hostile.
 */

const originalFetch = globalThis.fetch;

/** Replace fetch with a recorder; returns the closure that captured requests. */
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : null });
    return handler({ url: String(url), init, n: calls.length });
  };
  return calls;
}

const json = (obj, status = 200) => new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), {
  status,
  headers: { 'content-type': 'application/json' },
});

const KEY = 'AIzaSySup3rSecretKeyNotReal0123456789';

function baseCfg(overrides = {}) {
  return {
    format: 'gemini',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    baseUrlIsDefault: true,
    apiKey: KEY,
    temperature: 0.2,
    maxTokens: 1024,
    timeoutMs: 5000,
    draftTimeoutMs: 5000,
    allowPrivateBaseUrl: false,
    tgpt: {},
    ...overrides,
  };
}

let mod;
before(async () => {
  mod = await import('../src/services/aiProviders.js');
});
after(() => { globalThis.fetch = originalFetch; });

describe('gemini transport', () => {
  it('posts generateContent with the key in a header, not the URL', async () => {
    const calls = stubFetch(() => json({ candidates: [{ content: { parts: [{ text: ' Ubuntu 24.04 is at /file/ubuntu ' }] } }] }));
    const out = await mod.generate({
      system: 'STRICT RULES',
      prompt: 'Which Ubuntu?',
      cfg: baseCfg(),
      kind: 'ask',
    });

    assert.equal(out.text, 'Ubuntu 24.04 is at /file/ubuntu');
    assert.equal(out.provider, 'gemini');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/v1beta\/models\/gemini-2\.5-flash:generateContent$/);
    assert.ok(!calls[0].url.includes(KEY), 'the API key must never be in the query string (proxy and access logs)');
    assert.equal(calls[0].init.headers['x-goog-api-key'], KEY);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.redirect, 'manual', 'redirects must not be followed: they move the key');
    assert.deepEqual(calls[0].body.systemInstruction.parts[0].text, 'STRICT RULES');
    assert.deepEqual(calls[0].body.contents[0].parts[0].text, 'Which Ubuntu?');
    assert.equal(calls[0].body.generationConfig.maxOutputTokens, 1024);
  });

  it('joins a multi-part answer and reports a blocked prompt distinctly', async () => {
    stubFetch(() => json({
      candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] } }],
    }));
    assert.equal((await mod.generate({ prompt: 'x', cfg: baseCfg() })).text, 'ab');

    stubFetch(() => json({ promptFeedback: { blockReason: 'SAFETY' } }));
    await assert.rejects(
      () => mod.generate({ prompt: 'x', cfg: baseCfg() }),
      (e) => e.code === 'blocked' && /declined/.test(e.message)
    );
  });

  it('turns a wrong model name into an actionable 404 message', async () => {
    stubFetch(() => json({ error: { message: 'models/gemini-9.9-flash is not found for API version v1beta' } }, 404));
    await assert.rejects(
      () => mod.generate({ prompt: 'x', cfg: baseCfg({ model: 'gemini-9.9-flash' }) }),
      (e) => e.code === 'http' && /does not serve|404/.test(e.message)
    );
  });

  it('never lets the key escape in an error message', async () => {
    // A gateway echoing the authorization it was given is the realistic leak.
    stubFetch(() => json(`Request headers contained AI=${KEY}`, 400));
    const err = await mod.generate({ prompt: 'x', cfg: baseCfg() }).then(() => null, e => e);
    assert.ok(err, 'expected a rejection');
    assert.ok(!err.message.includes(KEY), `error leaked the key: ${err.message}`);
    assert.match(err.message, /\[redacted/);
  });
});

describe('openai-compatible transport', () => {
  it('posts chat/completions with a bearer key and system+user turns', async () => {
    const calls = stubFetch(() => json({ choices: [{ message: { content: 'two ISOs' }, finish_reason: 'stop' }] }));
    const out = await mod.generate({
      system: 'rules',
      prompt: 'what is here?',
      cfg: baseCfg({ format: 'openai', provider: 'openai', baseUrl: 'https://openrouter.ai/api/v1' }),
    });

    assert.equal(out.text, 'two ISOs');
    assert.match(calls[0].url, /\/chat\/completions$/);
    assert.equal(calls[0].init.headers.authorization, `Bearer ${KEY}`);
    assert.deepEqual(calls[0].body.messages.map(m => m.role), ['system', 'user']);
    assert.equal(calls[0].body.model, 'gemini-2.5-flash'); // whatever was configured
    assert.equal(calls[0].body.stream, false);
  });

  it('supports Groq through the OpenAI-compatible base URL', async () => {
    const calls = stubFetch(() => json({
      id: 'chatcmpl-groq-test',
      object: 'chat.completion',
      choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
    }));
    const out = await mod.generate({
      system: 'Reply with exactly: OK',
      prompt: 'connection test',
      cfg: baseCfg({
        format: 'openai',
        provider: 'openai',
        baseUrl: 'https://api.groq.com/openai/v1',
        // Transport regression: endpoint validation has its own tests below;
        // keeping this true makes this wire-format test network-independent.
        baseUrlIsDefault: true,
        model: 'openai/gpt-oss-120b',
        apiKey: 'gsk_test_key_not_real_0123456789',
      }),
    });

    assert.deepEqual(out, { text: 'OK', provider: 'openai', model: 'openai/gpt-oss-120b' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(calls[0].init.headers.authorization, 'Bearer gsk_test_key_not_real_0123456789');
    assert.equal(calls[0].body.model, 'openai/gpt-oss-120b');
    assert.equal(calls[0].body.stream, false);
  });

  it('keeps the configured timeout active while reading the response body', async () => {
    let finishBody;
    globalThis.fetch = async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"choices":['));
        const finish = () => {
          try {
            controller.enqueue(new TextEncoder().encode('{"message":{"content":"too late"}}]}'));
            controller.close();
          } catch { /* the timeout already errored the stream */ }
        };
        finishBody = setTimeout(finish, 200);
        init.signal.addEventListener('abort', () => {
          clearTimeout(finishBody);
          controller.error(init.signal.reason);
        }, { once: true });
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });

    const started = Date.now();
    await assert.rejects(
      () => mod.generate({
        prompt: 'x',
        cfg: baseCfg({
          format: 'openai',
          provider: 'openai',
          baseUrl: 'https://api.groq.com/openai/v1',
          baseUrlIsDefault: true,
          model: 'openai/gpt-oss-120b',
          timeoutMs: 40,
        }),
      }),
      (e) => e.code === 'timeout' && /40 ms/.test(e.message)
    );
    assert.ok(Date.now() - started < 180, 'the stalled response body outlived the configured timeout');
    clearTimeout(finishBody);
  });

  it('surfaces Groq API errors with their provider code and message', async () => {
    stubFetch(() => json({ error: { message: 'The model `missing/model` does not exist', type: 'invalid_request_error' } }, 400));
    await assert.rejects(
      () => mod.generate({
        prompt: 'x',
        cfg: baseCfg({
          format: 'openai',
          provider: 'openai',
          baseUrl: 'https://api.groq.com/openai/v1',
          baseUrlIsDefault: true,
          model: 'missing/model',
        }),
      }),
      (e) => e.code === 'http' && /HTTP 400/.test(e.message) && /does not exist/.test(e.message)
    );
  });

  it('accepts a base URL that already includes the endpoint path', async () => {
    const calls = stubFetch(() => json({ choices: [{ message: { content: 'ok' } }] }));
    await mod.generate({
      prompt: 'x',
      cfg: baseCfg({ format: 'openai', provider: 'openai', baseUrl: 'http://127.0.0.1:11434/v1/chat/completions', apiKey: '' }),
    });
    assert.equal(calls[0].url, 'http://127.0.0.1:11434/v1/chat/completions');
    assert.ok(!('authorization' in calls[0].init.headers),
      'a local Ollama needs no Authorization header; sending an empty Bearer makes some gateways answer 401');
  });

  it('reads the parts-array content shape some gateways return', async () => {
    stubFetch(() => json({ choices: [{ message: { content: [{ type: 'text', text: 'part one ' }, { type: 'text', text: 'part two' }] } }] }));
    const out = await mod.generate({ prompt: 'x', cfg: baseCfg({ format: 'openai', provider: 'openai', baseUrl: 'https://gw.example/v1' }) });
    assert.equal(out.text, 'part one part two');
  });

  it('refuses to invent a model name', async () => {
    stubFetch(() => json({ choices: [{ message: { content: 'x' } }] }));
    await assert.rejects(
      () => mod.generate({ prompt: 'x', cfg: baseCfg({ format: 'openai', provider: 'openai', model: '', baseUrl: 'http://127.0.0.1:11434/v1', baseUrlIsDefault: false }) }),
      (e) => e.code === 'config' && /AI_MODEL/.test(e.message)
    );
  });
});

describe('wrong wire format', () => {
  it('says so when a 200 response has no candidates / no choices', async () => {
    // The realistic misconfiguration: an OpenAI-shaped endpoint reached with
    // AI_FORMAT=gemini (or the reverse). A 200 with an unexpected body must not
    // become "the model is down" in the admin's mind.
    stubFetch(() => json({ reply: 'hello', object: 'chat.completion' }));
    await assert.rejects(
      () => mod.generate({ prompt: 'x', cfg: baseCfg() }),
      (e) => e.code === 'http' && /no "candidates"/.test(e.message) && /AI_FORMAT=openai/.test(e.message)
    );

    stubFetch(() => json({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }));
    await assert.rejects(
      () => mod.generate({ prompt: 'x', cfg: baseCfg({ format: 'openai', provider: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', baseUrlIsDefault: false }) }),
      (e) => e.code === 'http' && /no "choices"/.test(e.message) && /AI_FORMAT=gemini/.test(e.message)
    );
  });
});

describe('endpoint guardrails', () => {
  it('refuses a redirect instead of replaying the key elsewhere', async () => {
    stubFetch(() => new Response('', { status: 302, headers: { location: 'http://169.254.169.254/_latest/meta-data' } }));
    await assert.rejects(
      () => mod.generate({ prompt: 'x', cfg: baseCfg({ baseUrl: 'http://127.0.0.1:11434/v1', baseUrlIsDefault: false }) }),
      (e) => e.code === 'config' && /redirect/i.test(e.message)
    );
  });

  it('refuses a configured endpoint that points at cloud metadata', async () => {
    for (const bad of ['http://169.254.169.254/latest/api/v1', 'http://[fd00:ec2::254]/v1', 'http://[fe80::1]:11434/v1']) {
      await assert.rejects(
        () => mod.generate({ prompt: 'x', cfg: baseCfg({ format: 'openai', provider: 'openai', baseUrl: bad, baseUrlIsDefault: false }) }),
        (e) => e.code === 'config',
        `should have refused ${bad}`
      );
    }
  });

  it('blocks a LAN address until the flag is given, but not loopback', async () => {
    await assert.rejects(
      () => mod.generate({
        prompt: 'x',
        cfg: baseCfg({ format: 'openai', provider: 'openai', baseUrl: 'http://192.168.0.7:11434/v1', baseUrlIsDefault: false, apiKey: '' }),
      }),
      (e) => e.code === 'config' && /non-public/.test(e.message)
    );
    const calls = stubFetch(() => json({ choices: [{ message: { content: 'lan answer' } }] }));
    await mod.generate({
      prompt: 'x',
      cfg: baseCfg({ format: 'openai', provider: 'openai', baseUrl: 'http://192.168.0.7:11434/v1', baseUrlIsDefault: false, apiKey: '', allowPrivateBaseUrl: true }),
    });
    assert.equal(calls.length, 1, 'the flag is what opens the LAN');
  });

  it('still allows a loopback inference server, which is the point of the setting', async () => {
    const calls = stubFetch(() => json({ choices: [{ message: { content: 'local answer' } }] }));
    const out = await mod.generate({
      prompt: 'x',
      cfg: baseCfg({ format: 'openai', provider: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', baseUrlIsDefault: false, apiKey: '' }),
    });
    assert.equal(out.text, 'local answer');
    assert.equal(calls.length, 1);
  });

  it('caps the body it reads from a runaway endpoint, and keeps the error small', async () => {
    // A base URL mistyped onto some other service can answer with megabytes.
    // The cap means the truncated JSON fails to parse rather than being held in
    // memory whole - and the message must not carry the payload either.
    const huge = '{"candidates": [{"content": {"parts": [{"text": "' + 'x'.repeat(4 * 1024 * 1024);
    globalThis.fetch = async () => new Response(huge, { status: 200 });
    const err = await mod.generate({ prompt: 'x', cfg: baseCfg() }).then(() => null, e => e);
    assert.ok(err, 'a truncated response should not parse into an answer');
    assert.equal(err.code, 'http');
    assert.ok(err.message.length < 600, `error message was ${err.message.length} chars`);
  });
});

describe('redact', () => {
  it('scrubs the configured key and the shapes keys usually have', () => {
    assert.equal(mod.redact('failed with AIzaSyAbcDefGhiJklMnoPqrSt1234567890', 'AIzaSyAbcDefGhiJklMnoPqrSt1234567890'),
      'failed with [redacted]');
    assert.match(mod.redact('authorization: Bearer sk-proj-abcdefghijklmnop'), /\[redacted-key\]/);
    assert.equal(mod.redact('nothing secret here', ''), 'nothing secret here');
  });

  it('ignores a too-short secret rather than shredding ordinary text', () => {
    assert.equal(mod.redact('the sk-1 model', 'sk-1'), 'the sk-1 model');
  });
});

describe('tgpt transport still works', () => {
  it('reports unavailable instead of spawning nothing', async () => {
    await assert.rejects(
      () => mod.callTgpt({ prompt: 'x', cfg: { timeoutMs: 1000, tgpt: { binary: '' }, apiKey: '' } }),
      (e) => e.code === 'unavailable' && /not installed/.test(e.message)
    );
  });

  it('bounds the version probe used by status checks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgpt-probe-timeout-'));
    const binary = path.join(dir, 'tgpt');
    fs.writeFileSync(binary, '#!/bin/sh\nexec sleep 2\n');
    fs.chmodSync(binary, 0o755);
    try {
      const started = Date.now();
      assert.equal(await mod.tgptRuns(binary, 50), false);
      assert.ok(Date.now() - started < 500, 'tgpt --version ignored the status-check timeout');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
