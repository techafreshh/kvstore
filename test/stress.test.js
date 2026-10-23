'use strict';

// Issue #9's durability corner: a 100-op mixed set/delete loop with a file
// read after EVERY request must always observe whole JSON mirroring the
// in-memory model, and the final /dump must equal the last state on disk.
// A concurrent burst with an interleaved reader pins the PRD's
// file-never-corrupts clause: no torn read, and dump == disk once drained.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../server.js');

// One shared temp DATA_DIR for this file's process; persistStore() resolves
// DATA_DIR per call, so setting it here (before any mutation) is enough.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kvstore-stress-'));
process.env.DATA_DIR = DATA_DIR;

function kvPath() {
  return path.join(DATA_DIR, 'kv.json');
}

// Straight off disk, through JSON.parse: a torn or partial write throws
// right here and fails the test.
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

// POST /set helper: only well-formed objects here.
async function postSet(base, body) {
  return fetch(`${base}/set`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// The 100-loop runs its wheel over these seven keys; the burst below uses
// burst-0..3. Declared before the burst so the singleton store starts
// empty, keeping each test's full-map assertions deterministic.
const LOOP_KEYS = Array.from({ length: 7 }, (_, k) => `sw-${k}`);

// Projections: /dump entries are bare values; file entries are {value,...}.
function dumpValues(entries, keys) {
  const out = {};
  for (const key of keys) {
    if (Object.hasOwn(entries, key)) out[key] = entries[key];
  }
  return out;
}

function fileValues(entries, keys) {
  const out = {};
  for (const key of keys) {
    if (Object.hasOwn(entries, key)) out[key] = entries[key].value;
  }
  return out;
}

test('100 mixed set/delete calls always leave kv.json parseable, model-consistent, and finally equal to the dump', async () => {
  await withServer(async (url) => {
    const model = new Map();
    for (let i = 0; i < 100; i++) {
      const key = `sw-${i % 7}`;
      if (i % 2 === 0) {
        const res = await postSet(url, { key, value: i });
        assert.strictEqual(res.status, 200, `op ${i}`);
        model.set(key, i);
      } else {
        // A delete may legitimately miss (the key was never set or is
        // already gone); the model tracks which outcome is expected.
        const expected = model.has(key) ? 200 : 404;
        const res = await fetch(`${url}/${key}`, { method: 'DELETE' });
        assert.strictEqual(res.status, expected, `op ${i}`);
        model.delete(key);
      }
      // The acceptance read: after EVERY request the file on disk must
      // parse and mirror the model exactly.
      assert.deepStrictEqual(
        fileValues(readStoreFile().entries, LOOP_KEYS),
        Object.fromEntries(model),
        `after op ${i}`
      );
    }

    // Final /dump must match the last in-memory state...
    const dump = await fetch(`${url}/dump`);
    assert.strictEqual(dump.status, 200);
    const dumpEntries = (await dump.json()).entries;
    assert.deepStrictEqual(dumpValues(dumpEntries, LOOP_KEYS), Object.fromEntries(model));

    // ...and the disk, read after the dump response (dumps mutate nothing),
    // must agree with the dump on every stored value.
    assert.deepStrictEqual(
      fileValues(readStoreFile().entries, LOOP_KEYS),
      dumpValues(dumpEntries, LOOP_KEYS)
    );
    // The temp file never survives the atomic rename: only kv.json remains.
    assert.deepStrictEqual(fs.readdirSync(DATA_DIR).sort(), ['kv.json']);
  });
});

test('50-op concurrent burst under an interleaved file reader: no torn reads and dump equals disk once drained', async () => {
  await withServer(async (url) => {
    // Reader loop hammers kv.json between event-loop turns while the burst
    // is in flight; rename(2) must keep every read a whole file.
    let readError = null;
    let settled = false;
    const reader = (async () => {
      while (!settled) {
        try {
          if (fs.existsSync(kvPath())) JSON.parse(fs.readFileSync(kvPath(), 'utf8'));
        } catch (err) {
          readError = readError ?? err;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();

    const ops = Array.from({ length: 50 }, (_, i) => {
      const key = `burst-${i % 4}`;
      if (i % 2 === 0) {
        return postSet(url, { key, value: i }).then((res) => {
          assert.strictEqual(res.status, 200, `op ${i}`);
        });
      }
      return fetch(`${url}/${key}`, { method: 'DELETE' }).then((res) => {
        // Peer mutations may win the race, so only 200 (deleted here) or
        // 404 (already absent) are legal outcomes.
        assert.ok(res.status === 200 || res.status === 404, `op ${i}: ${res.status}`);
      });
    });
    await Promise.all(ops);
    settled = true;
    await reader;
    assert.strictEqual(readError, null);

    const dump = await fetch(`${url}/dump`);
    assert.strictEqual(dump.status, 200);
    const dumpEntries = (await dump.json()).entries;

    // No burst key carries a TTL, so once drained the dump and the disk
    // must agree on the FULL entries mapping, not a projection.
    const file = readStoreFile();
    assert.deepStrictEqual(dumpEntries, fileValues(file.entries, Object.keys(file.entries)));

    // Even ops last set burst-0:48 / burst-2:46; odd ops only ever delete
    // burst-1/3, which were never set and so are absent from the dump.
    assert.deepStrictEqual(dumpValues(dumpEntries, ['burst-0', 'burst-2']), {
      'burst-0': 48,
      'burst-2': 46,
    });
    assert.ok(!Object.hasOwn(dumpEntries, 'burst-1'));
    assert.ok(!Object.hasOwn(dumpEntries, 'burst-3'));

    assert.deepStrictEqual(fs.readdirSync(DATA_DIR).sort(), ['kv.json']);
  });
});
