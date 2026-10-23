'use strict';

// Issue #9's contract sweep, probed over HTTP: overwriting a ttlSec entry
// without ttlSec must clear the expiry — /dump keeps serving the new value,
// the persisted entry stores expiresAt null, and a previously expired entry
// stays reachable past its original deadline. The key pattern's bounds are
// pinned too: 64 allowed chars hit, 65 chars and invalid characters fall to
// the single global 404.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../server.js');

// One shared temp DATA_DIR for this file's process; persistStore() resolves
// DATA_DIR per call, so setting it here (before any mutation) is enough.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kvstore-sweep-'));
process.env.DATA_DIR = DATA_DIR;

function kvPath() {
  return path.join(DATA_DIR, 'kv.json');
}

// Every persistence assertion reads the file the way an external consumer
// would: straight off disk, through JSON.parse.
function readStoreFile() {
  return JSON.parse(fs.readFileSync(kvPath(), 'utf8'));
}

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
// exercises overwrite/TTL/bounds behavior, not body validation.
async function postSet(base, body) {
  return fetch(`${base}/set`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('overwriting a ttlSec entry without ttlSec keeps the value in /dump and stores expiresAt null in the file', async () => {
  await withServer(async (url) => {
    const first = await postSet(url, { key: 'sw-clear', value: 1, ttlSec: 60 });
    assert.strictEqual(first.status, 200);
    assert.notStrictEqual((await first.json()).expiresAt, null);

    // The acceptance overwrite verbatim: same key, new value, no ttlSec.
    const second = await postSet(url, { key: 'sw-clear', value: 2 });
    assert.strictEqual(second.status, 200);
    assert.deepStrictEqual(await second.json(), { key: 'sw-clear', expiresAt: null });

    const dump = await fetch(`${url}/dump`);
    assert.strictEqual(dump.status, 200);
    assert.deepStrictEqual((await dump.json()).entries['sw-clear'], 2);

    assert.deepStrictEqual(readStoreFile().entries['sw-clear'], { value: 2, expiresAt: null });
  });
});

test('a cleared expiry is gone, not re-armed: an expired-then-overwritten entry outlives its original deadline', async () => {
  await withServer(async (url) => {
    const armed = await postSet(url, { key: 'sw-revive', value: 'stale', ttlSec: 1 });
    assert.strictEqual(armed.status, 200);
    const originalDeadline = Date.parse((await armed.json()).expiresAt);

    // Outlive the 1s TTL: the entry must be invisible before the overwrite.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const expired = await fetch(`${url}/sw-revive`);
    assert.strictEqual(expired.status, 404);
    assert.deepStrictEqual(await expired.json(), { error: 'not found' });

    const revived = await postSet(url, { key: 'sw-revive', value: 'fresh' });
    assert.strictEqual(revived.status, 200);
    assert.deepStrictEqual(await revived.json(), { key: 'sw-revive', expiresAt: null });

    const res = await fetch(`${url}/sw-revive`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { key: 'sw-revive', value: 'fresh' });

    // A second read past the ORIGINAL deadline: a kept (or re-derived) old
    // expiry would flip this to 404, proving the overwrite stored a true
    // null rather than refreshing an inherited expiry.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.ok(Date.now() > originalDeadline);
    const later = await fetch(`${url}/sw-revive`);
    assert.strictEqual(later.status, 200);
    assert.deepStrictEqual(await later.json(), { key: 'sw-revive', value: 'fresh' });

    assert.deepStrictEqual(readStoreFile().entries['sw-revive'], { value: 'fresh', expiresAt: null });
  });
});

test('key bounds: /<64 allowed chars> hits while 65 chars and invalid characters fall to the global 404', async () => {
  await withServer(async (url) => {
    // The issue's exact maximum: 64 "a" chars is a storable, addressable key.
    const maxKey = 'a'.repeat(64);
    const set = await postSet(url, { key: maxKey, value: 'max-ok' });
    assert.strictEqual(set.status, 200);
    const hit = await fetch(`${url}/${maxKey}`);
    assert.strictEqual(hit.status, 200);
    assert.deepStrictEqual(await hit.json(), { key: maxKey, value: 'max-ok' });

    // One char past the cap, and segments carrying characters outside
    // [A-Za-z0-9_-]: every miss answers the single global 404 body.
    const segments = [
      `/${'a'.repeat(65)}`, // length bound from the issue
      '/ab$cd', // the issue's invalid-character probe
      '/ab.cd', // '.' is outside the class
      '/a:b', // ':' is outside the class
    ];
    for (const segment of segments) {
      const res = await fetch(`${url}${segment}`);
      assert.strictEqual(res.status, 404, segment);
      assert.deepStrictEqual(await res.json(), { error: 'not found' }, segment);
    }
  });
});
