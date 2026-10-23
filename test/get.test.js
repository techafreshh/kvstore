'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createServer } = require('../server.js');

// Start the server on an ephemeral localhost port so the suite never
// touches port 3000 and cannot flake against other processes.
async function withServer(fn) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(url);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// POST /set helper: only well-formed objects here, since this suite
// exercises retrieval, not body validation (that is set.test.js's job).
async function postSet(base, body) {
  return fetch(`${base}/set`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// The store is a module-level singleton, so every in-process server in this
// file shares it. Dump assertions therefore pick only the keys a test owns;
// the runtime acceptance probes a fresh process for exact whole bodies.
function pick(entries, keys) {
  const picked = {};
  for (const key of keys) {
    if (Object.hasOwn(entries, key)) picked[key] = entries[key];
  }
  return picked;
}

test('GET /<key> returns 200 with exact {"key":..,"value":..} for a present key', async () => {
  await withServer(async (url) => {
    const set = await postSet(url, { key: 'hit-flag', value: true });
    assert.strictEqual(set.status, 200);

    const res = await fetch(`${url}/hit-flag`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { key: 'hit-flag', value: true });
  });
});

test('GET /<key> returns 404 with exact {"error":"not found"} for an unknown key', async () => {
  await withServer(async (url) => {
    const res = await fetch(`${url}/nope`);
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(await res.json(), { error: 'not found' });
  });
});

test('GET /<key> returns 404 for an entry expired under the real clock', async () => {
  await withServer(async (url) => {
    const set = await postSet(url, { key: 'tmp', value: 9, ttlSec: 1 });
    assert.strictEqual(set.status, 200);

    // Outlive the 1s TTL before reading: expiry must be checked at read time.
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const res = await fetch(`${url}/tmp`);
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(await res.json(), { error: 'not found' });
  });
});

test('GET /<key> returns 404 for an already-expired entry (negative ttlSec) and /dump hides it', async () => {
  await withServer(async (url) => {
    const live = await postSet(url, { key: 'keep', value: 5 });
    assert.strictEqual(live.status, 200);
    const stale = await postSet(url, { key: 'old', value: 1, ttlSec: -1 });
    assert.strictEqual(stale.status, 200);

    const res = await fetch(`${url}/old`);
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(await res.json(), { error: 'not found' });

    const dump = await fetch(`${url}/dump`);
    assert.strictEqual(dump.status, 200);
    const { entries } = await dump.json();
    assert.deepStrictEqual(pick(entries, ['old', 'keep']), { keep: 5 });
  });
});

test('GET /<key> matches the path pattern: query strings split off, matching segments hit, everything else 404s', async () => {
  await withServer(async (url) => {
    // Query string must not leak into the key lookup.
    const flagged = await postSet(url, { key: 'path-flag', value: 1 });
    assert.strictEqual(flagged.status, 200);
    const withQuery = await fetch(`${url}/path-flag?x=1`);
    assert.strictEqual(withQuery.status, 200);
    assert.deepStrictEqual(await withQuery.json(), { key: 'path-flag', value: 1 });

    // A 64-char key of every allowed character class is addressable.
    const maxKey = 'A'.repeat(16) + 'z'.repeat(16) + '0'.repeat(16) + '_-'.repeat(8);
    assert.strictEqual(maxKey.length, 64);
    const setMax = await postSet(url, { key: maxKey, value: 'ok' });
    assert.strictEqual(setMax.status, 200);
    const maxRes = await fetch(`${url}/${maxKey}`);
    assert.strictEqual(maxRes.status, 200);
    assert.deepStrictEqual(await maxRes.json(), { key: maxKey, value: 'ok' });

    // Non-matching segments: 404 with the global error body, never a 500
    // (malformed escapes must not throw in the handler).
    const segments = [
      '/we%20ird!', // encoded space: raw segment fails the pattern
      '/%zz', // malformed percent escape
      '//', // empty key
      '/a/b', // two segments
      '/path-flag/', // trailing slash
      `/${'x'.repeat(65)}`, // 65 chars exceeds the 64-char cap
    ];
    for (const segment of segments) {
      const res = await fetch(`${url}${segment}`);
      assert.strictEqual(res.status, 404, segment);
      assert.deepStrictEqual(await res.json(), { error: 'not found' }, segment);
    }
  });
});

test('GET /dump returns all unexpired entries with verbatim values, including non-path keys', async () => {
  await withServer(async (url) => {
    const bodies = [
      { key: 'dump-a', value: 1 },
      { key: 'dump-b', value: { x: [2] } },
      { key: 'we ird!', value: 7 },
    ];
    for (const body of bodies) {
      const set = await postSet(url, body);
      assert.strictEqual(set.status, 200, JSON.stringify(body));
    }

    const res = await fetch(`${url}/dump`);
    assert.strictEqual(res.status, 200);
    const { entries } = await res.json();
    assert.deepStrictEqual(pick(entries, ['dump-a', 'dump-b', 'we ird!']), {
      'dump-a': 1,
      'dump-b': { x: [2] },
      'we ird!': 7,
    });

    // The non-path key is storable and dumpable but not GET-addressable.
    const weird = await fetch(`${url}/we%20ird!`);
    assert.strictEqual(weird.status, 404);
    assert.deepStrictEqual(await weird.json(), { error: 'not found' });
  });
});

test('GET /dump reflects overwritten values', async () => {
  await withServer(async (url) => {
    const first = await postSet(url, { key: 'ow-a', value: 1 });
    assert.strictEqual(first.status, 200);
    const second = await postSet(url, { key: 'ow-a', value: 9 });
    assert.strictEqual(second.status, 200);

    const res = await fetch(`${url}/dump`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(pick((await res.json()).entries, ['ow-a']), { 'ow-a': 9 });
  });
});
