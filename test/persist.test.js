'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../server.js');

// One shared temp DATA_DIR for this file's process; persistStore() resolves
// DATA_DIR per call, so setting it here (before any mutation) is enough.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kvstore-persist-'));
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
// exercises persistence, not body validation (that is set.test.js's job).
async function postSet(base, body) {
  return fetch(`${base}/set`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('every mutation persists the full store to DATA_DIR/kv.json in the contract shape', async () => {
  await withServer(async (url) => {
    const res = await postSet(url, { key: 'persist-shape', value: 42 });
    assert.strictEqual(res.status, 200);

    const file = readStoreFile();
    assert.ok(Object.hasOwn(file, 'nextCheckpoint'));
    assert.ok(Object.hasOwn(file, 'entries'));
    assert.strictEqual(file.entries['persist-shape'].value, 42);
    assert.strictEqual(file.entries['persist-shape'].expiresAt, null);
  });
});

test('large object values round-trip the file losslessly', async () => {
  await withServer(async (url) => {
    const value = { nested: [1, 'two', { deep: true, nil: null }] };
    const res = await postSet(url, { key: 'persist-round', value });
    assert.strictEqual(res.status, 200);

    const file = readStoreFile();
    assert.deepStrictEqual(file.entries['persist-round'].value, value);
  });
});

test('a ttlSec set persists expiresAt as RFC3339 ending Z near now+ttl', async () => {
  await withServer(async (url) => {
    const res = await postSet(url, { key: 'persist-ttl', value: 1, ttlSec: 60 });
    assert.strictEqual(res.status, 200);

    const entry = readStoreFile().entries['persist-ttl'];
    assert.match(entry.expiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    assert.ok(Math.abs(Date.parse(entry.expiresAt) - (Date.now() + 60000)) < 5000);
  });
});

test('overwriting with no ttlSec clears expiresAt and updates the value in the file', async () => {
  await withServer(async (url) => {
    const first = await postSet(url, { key: 'persist-ow', value: 1, ttlSec: 60 });
    assert.strictEqual(first.status, 200);
    assert.notStrictEqual(readStoreFile().entries['persist-ow'].expiresAt, null);

    const second = await postSet(url, { key: 'persist-ow', value: 2 });
    assert.strictEqual(second.status, 200);

    const entry = readStoreFile().entries['persist-ow'];
    assert.strictEqual(entry.value, 2);
    assert.strictEqual(entry.expiresAt, null);
  });
});

test('a successful delete removes the key from the file; a 404 delete leaves it unchanged', async () => {
  await withServer(async (url) => {
    const set = await postSet(url, { key: 'persist-del', value: 7 });
    assert.strictEqual(set.status, 200);
    assert.ok(Object.hasOwn(readStoreFile().entries, 'persist-del'));

    const del = await fetch(`${url}/persist-del`, { method: 'DELETE' });
    assert.strictEqual(del.status, 200);
    assert.deepStrictEqual(await del.json(), { deleted: true });
    assert.ok(!Object.hasOwn(readStoreFile().entries, 'persist-del'));

    // The store keeps deleting keys from earlier tests in this file, so
    // compare key *sets*, not whole entries maps, around the no-op delete.
    const before = Object.keys(readStoreFile().entries).sort();
    const miss = await fetch(`${url}/persist-del-miss`, { method: 'DELETE' });
    assert.strictEqual(miss.status, 404);
    assert.deepStrictEqual(await miss.json(), { deleted: false });
    const after = Object.keys(readStoreFile().entries).sort();
    assert.deepStrictEqual(after, before);
  });
});

test('50 alternating set/delete calls always leave kv.json complete JSON with no temp residue', async () => {
  await withServer(async (url) => {
    for (let i = 0; i < 50; i++) {
      let res;
      if (i % 2 === 0) {
        res = await postSet(url, { key: 'persist-loop', value: i });
        assert.strictEqual(res.status, 200, `call ${i}`);
      } else {
        res = await fetch(`${url}/persist-loop`, { method: 'DELETE' });
        assert.strictEqual(res.status, 200, `call ${i}`);
      }
      // A reader racing the write sees only whole files: rename(2) never
      // exposes a partial kv.json, so JSON.parse must succeed every time.
      const file = readStoreFile();
      if (i % 2 === 0) {
        assert.strictEqual(file.entries['persist-loop'].value, i, `call ${i}`);
      } else {
        assert.ok(!Object.hasOwn(file.entries, 'persist-loop'), `call ${i}`);
      }
    }
    // Final call was a delete: the key must be gone and the directory must
    // hold exactly kv.json (the temp file never survives the rename).
    const finalFile = readStoreFile();
    assert.ok(!Object.hasOwn(finalFile.entries, 'persist-loop'));
    assert.ok(Object.hasOwn(finalFile, 'nextCheckpoint'));
    assert.deepStrictEqual(fs.readdirSync(DATA_DIR).sort(), ['kv.json']);
  });
});
