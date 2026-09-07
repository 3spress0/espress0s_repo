import { describe, it } from 'node:test';
import assert from 'node:assert';

import { readCounted, shouldCountView, withCounted, countView } from '../src/lib/viewCounting.js';

/**
 * The browser half of "one view per device".
 *
 * The server counts what it is told and keeps no per-device record, so this
 * module is the only thing standing between `view_count` and a reload-count.
 * The cases worth pinning are the ones a later edit can quietly break: a second
 * call for the same item must not fire, and the whole thing must survive a
 * browser that refuses storage or a request that fails.
 */

// A stand-in for localStorage, since the test runner has none.
const fakeStore = (initial = {}) => {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = v; },
  };
};

const KEY = 'espress0_viewed_counted';
const item = (id, slug = `item-${id}`) => ({ id, slug, name: 'x' });

function harness(initialIds = []) {
  const store = fakeStore(initialIds.length ? { [KEY]: JSON.stringify(initialIds) } : {});
  const seen = new Set();
  const sent = [];
  const call = (it, opts = {}) => countView(it, {
    // `store: null` in opts stands in for a browser that refuses storage.
    store: opts.store === null ? null : store,
    seen,
    send: (slug) => {
      sent.push(slug);
      return opts.reject ? Promise.reject(new Error('offline')) : Promise.resolve();
    },
  });
  return { store, sent, call };
}

describe('shouldCountView', () => {
  it('is true for an item this browser has not counted', () => {
    assert.equal(shouldCountView(item(1), []), true);
    assert.equal(shouldCountView(item(1), [2, 3]), true);
  });

  it('is false once counted', () => {
    assert.equal(shouldCountView(item(1), [1]), false);
  });

  it('is false for anything it cannot report or dedupe against', () => {
    assert.equal(shouldCountView({ id: 1 }, []), false, 'no slug to post to');
    assert.equal(shouldCountView({ slug: 'x' }, []), false, 'no id to remember');
    assert.equal(shouldCountView(null, []), false);
    assert.equal(shouldCountView(item('not-a-number'), []), false, 'a non-numeric id is not a key');
  });
});

describe('the counted set', () => {
  it('reads storage, and reads anything broken as empty', () => {
    assert.deepEqual(readCounted(fakeStore({ [KEY]: '[3,4]' })), [3, 4]);
    assert.deepEqual(readCounted(fakeStore({ [KEY]: 'not json' })), []);
    assert.deepEqual(readCounted(fakeStore()), [], 'first visit ever');
    assert.deepEqual(readCounted(null), [], 'no storage at all');
  });

  it('drops ids that are not numbers, so a corrupted entry cannot stick', () => {
    assert.deepEqual(readCounted(fakeStore({ [KEY]: '[1,"two",null,3]' })), [1, 3]);
  });

  it('grows by one per id and never repeats one', () => {
    let counted = [];
    for (const id of [1, 2, 1, 3]) counted = withCounted(counted, id);
    assert.deepEqual(counted, [1, 2, 3]);
  });

  it('keeps the newest entries when it exceeds its ceiling', () => {
    const grown = withCounted([1, 2, 3, 4], 5, 3);
    assert.deepEqual(grown, [3, 4, 5], 'an unbounded list would grow for the life of the install');
  });
});

describe('countView', () => {
  it('reports the first view of a page and remembers it', () => {
    const h = harness();
    assert.equal(h.call(item(7)), true);
    assert.deepEqual(h.sent, ['item-7']);
    assert.deepEqual(JSON.parse(h.store.data[KEY]), [7]);
  });

  it('does not report the same page again on the next visit', () => {
    const h = harness([7]);
    assert.equal(h.call(item(7)), false);
    assert.deepEqual(h.sent, [], 'this is the reload/back-navigation case the whole module exists for');
  });

  it('survives a browser with no storage by remembering the current page', () => {
    const h = harness();
    assert.equal(h.call(item(9), { store: null }), true);
    assert.equal(h.call(item(9), { store: null }), false, 'no second beacon for the same mount');
  });

  it('survives a failing request without throwing or retrying into the UI', async () => {
    const h = harness();
    assert.equal(h.call(item(11), { reject: true }), true);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(h.call(item(11)), false, 'a view that could not be sent is not re-sent on the next click');
  });

  it('is silent for an item it cannot name', () => {
    const h = harness();
    assert.equal(h.call({ id: 5 }), false);
    assert.deepEqual(h.sent, []);
  });
});
