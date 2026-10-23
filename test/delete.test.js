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
// exercises deletion, not body validation (that is set.test.js's job).
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

test('DELETE /<key> removes a present key: 200 {"deleted":true}, then 404 on GET and gone from /dump', async () => {
  await withServer(async (url) => {
    const set = await postSet(url, { key: 'del-k', value: 1 });
    assert.strictEqual(set.status, 200);
    const keep = await postSet(url, { key: 'del-keep', value: 2 });
    assert.strictEqual(keep.status, 200);

    const del = await fetch(`${url}/del-k`, { method: 'DELETE' });
    assert.strictEqual(del.status, 200);
    assert.deepStrictEqual(await del.json(), { deleted: true });

    const gone = await fetch(`${url}/del-k`);
    assert.strictEqual(gone.status, 404);
    assert.deepStrictEqual(await gone.json(), { error: 'not found' });

    const dump = await fetch(`${url}/dump`);
    assert.strictEqual(dump.status, 200);
    const { entries } = await dump.json();
    assert.deepStrictEqual(pick(entries, ['del-k', 'del-keep']), { 'del-keep': 2 });
  });
});

test('DELETE /<key> returns 404 with exactly {"deleted":false} for an unknown key', async () => {
  await withServer(async (url) => {
    const res = await fetch(`${url}/never`, { method: 'DELETE' });
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(await res.json(), { deleted: false });
  });
});

test('DELETE /<key> deletes an already-expired entry (negative ttlSec) counting it as existing', async () => {
  await withServer(async (url) => {
    const set = await postSet(url, { key: 'del-e', value: 1, ttlSec: -1 });
    assert.strictEqual(set.status, 200);

    const del = await fetch(`${url}/del-e`, { method: 'DELETE' });
    assert.strictEqual(del.status, 200);
    assert.deepStrictEqual(await del.json(), { deleted: true });

    // Second delete must miss: removal is real, not read-time hiding.
    const again = await fetch(`${url}/del-e`, { method: 'DELETE' });
    assert.strictEqual(again.status, 404);
    assert.deepStrictEqual(await again.json(), { deleted: false });
  });
});

test('DELETE /<key> deletes an entry expired under the real clock', async () => {
  await withServer(async (url) => {
    const set = await postSet(url, { key: 'del-ttl', value: 1, ttlSec: 1 });
    assert.strictEqual(set.status, 200);

    // Outlive the 1s TTL before deleting: lazy expiry keeps the entry stored.
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const del = await fetch(`${url}/del-ttl`, { method: 'DELETE' });
    assert.strictEqual(del.status, 200);
    assert.deepStrictEqual(await del.json(), { deleted: true });

    const gone = await fetch(`${url}/del-ttl`);
    assert.strictEqual(gone.status, 404);
    assert.deepStrictEqual(await gone.json(), { error: 'not found' });
  });
});

test('DELETE respects the path pattern: 64-char keys are addressable, non-matching paths keep the global 404 body', async () => {
  await withServer(async (url) => {
    const maxKey = 'a'.repeat(64);
    const set = await postSet(url, { key: maxKey, value: 1 });
    assert.strictEqual(set.status, 200);

    const del = await fetch(`${url}/${maxKey}`, { method: 'DELETE' });
    assert.strictEqual(del.status, 200);
    assert.deepStrictEqual(await del.json(), { deleted: true });

    // A matched but absent key: 404 with the deleted body, not the error body.
    const again = await fetch(`${url}/${maxKey}`, { method: 'DELETE' });
    assert.strictEqual(again.status, 404);
    assert.deepStrictEqual(await again.json(), { deleted: false });

    // Non-matching segments: 404 with the global error body, never a 500.
    const segments = ['//', '/a/b', `/${'a'.repeat(65)}`];
    for (const segment of segments) {
      const res = await fetch(`${url}${segment}`, { method: 'DELETE' });
      assert.strictEqual(res.status, 404, segment);
      assert.deepStrictEqual(await res.json(), { error: 'not found' }, segment);
    }
  });
});

test('DELETE has no reserved paths: stored key "dump" is deletable while GET /dump keeps working', async () => {
  await withServer(async (url) => {
    const set = await postSet(url, { key: 'dump', value: 3 });
    assert.strictEqual(set.status, 200);

    const del = await fetch(`${url}/dump`, { method: 'DELETE' });
    assert.strictEqual(del.status, 200);
    assert.deepStrictEqual(await del.json(), { deleted: true });

    const dump = await fetch(`${url}/dump`);
    assert.strictEqual(dump.status, 200);
    // Singleton store: pick only what this test owns — the key "dump" must
    // be gone from the entries map while GET /dump itself still answers.
    const { entries } = await dump.json();
    assert.deepStrictEqual(pick(entries, ['dump']), {});
  });
});
