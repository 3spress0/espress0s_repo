import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';

/**
 * "Fill in the gaps" — the AI helper that suggests values for the metadata
 * fields an admin left empty when authoring a page.
 *
 * Two properties matter and are tested here:
 *
 *   1. Suggestions are sanitised. A model that returns "linux/mac" for platform
 *      or "vLatest" for version must not leak that into the editor — only the
 *      form's own controlled vocabulary survives.
 *   2. It never proposes a field the admin already filled in, and it only
 *      returns the fields that were actually requested.
 *
 * The JSON-extraction and sanitiser are pure functions, tested without a model.
 * The end-to-end suggestFields path is tested against a stubbed provider.
 */

// config.js reads the environment at import time; make a provider resolvable so
// suggestFields takes the model path rather than the "no model" branch.
process.env.AI_PROVIDER = 'openai';
process.env.AI_API_KEY = 'sk-test-not-a-real-key-0123456789';
process.env.AI_MODEL = 'test-model';
process.env.AI_TIMEOUT_MS = '5000';

const {
  aiService,
  extractJsonObject,
  sanitizeFieldSuggestions,
} = await import('../src/services/aiService.js');

const realFetch = globalThis.fetch;

/** Stand in for an OpenAI-compatible endpoint returning one canned content. */
function stubProviderOnce(content) {
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  globalThis.fetch = realFetch;
  aiService.lastError = null;
});

after(() => { globalThis.fetch = realFetch; });

// -------------------------------------------------------- extractJsonObject

describe('fill gaps: extractJsonObject', () => {
  it('pulls a JSON object out of a fenced, prose-wrapped reply', () => {
    const reply = 'Sure! Here you go:\n```json\n{"platform":"windows","tags":["a","b"]}\n```\nHope that helps.';
    assert.deepEqual(extractJsonObject(reply), { platform: 'windows', tags: ['a', 'b'] });
  });

  it('handles nested braces and braces inside strings', () => {
    const reply = 'x {"long_description":"## Overview {not json} more","meta":{"a":1}} y';
    const out = extractJsonObject(reply);
    assert.equal(out.long_description, '## Overview {not json} more');
    assert.deepEqual(out.meta, { a: 1 });
  });

  it('returns null when there is no object at all', () => {
    assert.equal(extractJsonObject('no json here'), null);
    assert.equal(extractJsonObject(''), null);
  });
});

// ---------------------------------------------------- sanitizeFieldSuggestions

describe('fill gaps: sanitiser keeps only valid, requested fields', () => {
  const targets = ['version', 'platform', 'architecture', 'file_type', 'license_status', 'tags', 'description', 'long_description'];

  it('accepts controlled-vocabulary values and normalises case', () => {
    const out = sanitizeFieldSuggestions({
      platform: 'Windows',
      architecture: 'X64',
      license_status: 'Proprietary',
      file_type: '.EXE',
    }, targets);
    assert.equal(out.platform, 'windows');
    assert.equal(out.architecture, 'x64');
    assert.equal(out.license_status, 'proprietary');
    assert.equal(out.file_type, 'exe');
  });

  it('drops values outside the controlled vocabulary', () => {
    const out = sanitizeFieldSuggestions({
      platform: 'linux/mac',        // not a single allowed value
      architecture: 'sparc',        // unknown
      license_status: 'freeware',   // unknown
    }, targets);
    assert.equal(out.platform, undefined);
    assert.equal(out.architecture, undefined);
    assert.equal(out.license_status, undefined);
  });

  it('accepts a plausible version but rejects a placeholder sentence', () => {
    assert.equal(sanitizeFieldSuggestions({ version: '24.04.1' }, targets).version, '24.04.1');
    assert.equal(sanitizeFieldSuggestions({ version: 'the latest release' }, targets).version, undefined);
    assert.equal(sanitizeFieldSuggestions({ version: 'stable' }, targets).version, undefined); // no digit
  });

  it('caps and de-duplicates tags', () => {
    const out = sanitizeFieldSuggestions({
      tags: ['Editor', 'editor', 'dev', 'a', 'b', 'c', 'd', 'e', 'f', 'g'],
    }, targets);
    assert.ok(out.tags.length <= 8);
    assert.equal(out.tags.filter(t => t === 'editor').length, 1);
    assert.ok(out.tags.every(t => t === t.toLowerCase()));
  });

  it('only returns fields that were requested', () => {
    const out = sanitizeFieldSuggestions(
      { platform: 'linux', version: '1.0', description: 'hi' },
      ['platform'] // caller only wants platform
    );
    assert.deepEqual(Object.keys(out), ['platform']);
  });
});

// ------------------------------------------------------------ suggestFields

describe('fill gaps: suggestFields end to end', () => {
  it('requires a name', async () => {
    await assert.rejects(() => aiService.suggestFields({ name: '' }), /name is required/);
  });

  it('fills only the empty fields and never overwrites a filled one', async () => {
    stubProviderOnce(JSON.stringify({
      version: '2.0.0',                 // admin left empty -> should be offered
      platform: 'linux',               // admin already set windows -> must be ignored
      architecture: 'x64',
      file_type: 'appimage',
      license_status: 'redistributable',
      tags: ['linux', 'tool'],
      description: 'A handy tool.',
      long_description: '## Overview\nStuff.',
    }));

    const res = await aiService.suggestFields({
      name: 'Example App',
      platform: 'windows', // filled in already
    });

    assert.equal(res.usedAI, true);
    // platform was already filled, so it must not be among the suggestions.
    assert.equal(res.suggestions.platform, undefined);
    // an empty field the model answered comes back.
    assert.equal(res.suggestions.architecture, 'x64');
    assert.equal(res.suggestions.version, '2.0.0');
    assert.ok(Array.isArray(res.suggestions.tags));
    assert.ok(res.filledFields.includes('architecture'));
    assert.ok(!res.filledFields.includes('platform'));
  });

  it('reports nothing to fill when every field is already set', async () => {
    let called = false;
    globalThis.fetch = async () => { called = true; return realFetch(); };

    const res = await aiService.suggestFields({
      name: 'Complete App',
      version: '1.2.3',
      platform: 'linux',
      architecture: 'x64',
      file_type: 'iso',
      license_status: 'proprietary',
      tags: ['a', 'b'],
      description: 'Already described.',
      long_description: '## Overview\nAll set.',
    });

    assert.equal(res.nothingToFill, true);
    assert.deepEqual(res.suggestions, {});
    assert.equal(called, false, 'should not call the model when there is nothing to fill');
  });

  it('honours an explicit field allow-list', async () => {
    stubProviderOnce(JSON.stringify({
      version: '9.9',
      platform: 'macos',
      tags: ['x'],
    }));

    const res = await aiService.suggestFields(
      { name: 'Scoped App' },
      ['platform'] // only ask for platform
    );

    assert.deepEqual(Object.keys(res.suggestions), ['platform']);
    assert.equal(res.suggestions.platform, 'macos');
  });

  it('surfaces a clean result when the model returns unusable output', async () => {
    stubProviderOnce('I cannot help with that.');
    const res = await aiService.suggestFields({ name: 'Mystery App' });
    // No JSON parsed -> no suggestions, and usedAI is false so the UI explains it.
    assert.deepEqual(res.suggestions, {});
    assert.equal(res.usedAI, false);
  });
});
