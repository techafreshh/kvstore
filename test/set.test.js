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

// POST /set helper: objects are serialized, raw strings pass through
// verbatim so malformed-body cases can exercise the parser.
async function postSet(base, body) {
  return fetch(`${base}/set`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('POST /set without ttlSec returns 200 with exact {"key":..,"expiresAt":null}', async () => {
  await withServer(async (url) => {
    const res = await postSet(url, { key: 'a', value: 1 });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { key: 'a', expiresAt: null });
  });
});

test('POST /set with ttlSec 60 returns RFC3339 Z expiresAt ~now+60s', async () => {
  await withServer(async (url) => {
    const res = await postSet(url, { key: 'a', value: 1, ttlSec: 60 });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.key, 'a');
    assert.match(body.expiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    assert.ok(Math.abs(Date.parse(body.expiresAt) - (Date.now() + 60000)) < 5000);
  });
});

test('POST /set with malformed JSON returns 400 and the server keeps serving', async () => {
  await withServer(async (url) => {
    const res = await postSet(url, 'not json');
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.ok(Object.hasOwn(body, 'error'));

    const health = await fetch(`${url}/health`);
    assert.strictEqual(health.status, 200);
    assert.deepStrictEqual(await health.json(), { ok: true });
  });
});

// Each contract rejection case must yield 400 with a JSON "error" field.
test('POST /set rejects missing fields and non-integer ttlSec with 400', async () => {
  await withServer(async (url) => {
    const cases = [
      { value: 1 }, // missing key
      { key: 'a' }, // missing value
      { key: 'a', value: 1, ttlSec: 'x' }, // non-integer ttlSec
      { key: 'a', value: 1, ttlSec: 1.5 }, // fractional ttlSec
      { key: 'a', value: 1, ttlSec: null }, // explicit null is not "absent"
    ];
    for (const body of cases) {
      const res = await postSet(url, body);
      assert.strictEqual(res.status, 400, JSON.stringify(body));
      const parsed = await res.json();
      assert.ok(Object.hasOwn(parsed, 'error'), JSON.stringify(body));
    }
  });
});

test('POST /set overwrites any key string with any JSON value and honors a later ttlSec', async () => {
  await withServer(async (url) => {
    const first = await postSet(url, { key: 'a', value: { nested: [1, 2] } });
    assert.strictEqual(first.status, 200);

    const second = await postSet(url, { key: 'a', value: 2, ttlSec: 5 });
    assert.strictEqual(second.status, 200);
    const body = await second.json();
    assert.match(body.expiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    assert.ok(Math.abs(Date.parse(body.expiresAt) - (Date.now() + 5000)) < 5000);
  });
});

test('POST /set accepts integer ttlSec extremes and null values', async () => {
  await withServer(async (url) => {
    // Far-out integers are clamped to the valid Date range, not rejected.
    const huge = await postSet(url, { key: 'huge', value: 1, ttlSec: Number.MAX_SAFE_INTEGER });
    assert.strictEqual(huge.status, 200);
    const hugeBody = await huge.json();
    assert.ok(!Number.isNaN(Date.parse(hugeBody.expiresAt)));

    // Negative ttlSec lands in the past; still a 200 per contract.
    const past = await postSet(url, { key: 'past', value: 1, ttlSec: -1 });
    assert.strictEqual(past.status, 200);
    assert.ok(Date.parse((await past.json()).expiresAt) <= Date.now());

    // JSON null is a storable value (presence, not truthiness).
    const nullValue = await postSet(url, { key: 'nullv', value: null });
    assert.strictEqual(nullValue.status, 200);
    assert.deepStrictEqual(await nullValue.json(), { key: 'nullv', expiresAt: null });
  });
});
