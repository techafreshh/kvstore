'use strict';

// Issue #7's contract, probed end-to-end: entries loaded from a seeded
// DATA_DIR/kv.json must honor their seeded instants — a past expiresAt is
// invisible (GET 404, /dump omits it), a future expiresAt flips to 404 the
// moment it passes, and DELETE still counts an expired-but-present entry as
// existing. loadStore() runs only in the bare `node server.js` boot path,
// so a seeded file can only be exercised through real child processes.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

// Grab an unused loopback port; the probe is closed before the server binds.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Spawn a real `node server.js` process bounded to a private DATA_DIR and
// resolve once it is accepting connections (readiness = its stdout line).
function startServer(dir, port) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, DATA_DIR: dir, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`server not ready within 10s; stderr: ${stderr}`)),
      10000
    );
    child.stdout.on('data', () => {
      if (stdout.includes('listening on port')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited before readiness (code ${code}); stderr: ${stderr}`));
    });
  });
  return ready.then(() => child);
}

function stopServer(child) {
  child.kill('SIGTERM');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not exit within 5s')), 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// Every persistence assertion reads the file the way an external consumer
// would: straight off disk, through JSON.parse.
function readStoreFile(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'kv.json'), 'utf8'));
}

// Seed a temp DATA_DIR with the exact given file content and return its path.
function seedStore(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kvstore-persistence-'));
  fs.writeFileSync(path.join(dir, 'kv.json'), content);
  return dir;
}

// Sleep until the seeded instant has passed (plus margin), however long the
// readiness gate already took: elapsed time only accumulates, so a slow
// spawn can never make the expired-side requests land early.
async function sleepPast(instant) {
  const remaining = Date.parse(instant) - Date.now() + 500;
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, remaining)));
}

test('a pre-seeded expired entry is invisible: GET 404 with the exact error body and /dump omits it', async () => {
  // The issue pins the frozen instant: 2020-01-01T00:00:00Z, always in the past.
  const seed = '{"entries":{"old":{"value":"o","expiresAt":"2020-01-01T00:00:00Z"},'
    + '"live":{"value":"v","expiresAt":null}},"nextCheckpoint":0}';
  const dir = seedStore(seed);

  const port = await freePort();
  const child = await startServer(dir, port);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/old`);
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(await res.json(), { error: 'not found' });

    const dump = await fetch(`http://127.0.0.1:${port}/dump`);
    assert.strictEqual(dump.status, 200);
    assert.deepStrictEqual(await dump.json(), { entries: { live: 'v' } });
  } finally {
    await stopServer(child);
  }

  // Reads never purge: boot hydration must leave the seed byte-identical.
  assert.strictEqual(fs.readFileSync(path.join(dir, 'kv.json'), 'utf8'), seed);
});

test('a pre-seeded future entry serves until its instant passes, then 404s on schedule', async () => {
  const future = new Date(Date.now() + 2000).toISOString();
  const dir = seedStore(JSON.stringify({
    entries: { future: { value: 'f', expiresAt: future } },
    nextCheckpoint: 0,
  }));

  const port = await freePort();
  const child = await startServer(dir, port);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/future`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { key: 'future', value: 'f' });

    const dump = await fetch(`http://127.0.0.1:${port}/dump`);
    assert.strictEqual(dump.status, 200);
    assert.deepStrictEqual(await dump.json(), { entries: { future: 'f' } });

    await sleepPast(future);

    const expired = await fetch(`http://127.0.0.1:${port}/future`);
    assert.strictEqual(expired.status, 404);
    assert.deepStrictEqual(await expired.json(), { error: 'not found' });

    const dumpAfter = await fetch(`http://127.0.0.1:${port}/dump`);
    assert.strictEqual(dumpAfter.status, 200);
    assert.deepStrictEqual(await dumpAfter.json(), { entries: {} });
  } finally {
    await stopServer(child);
  }
});

test('DELETE counts an expired-but-present seeded entry as existing and rewrites the file without it', async () => {
  const dir = seedStore('{"entries":{"old":{"value":"o","expiresAt":"2020-01-01T00:00:00Z"}},'
    + '"nextCheckpoint":0}');

  const port = await freePort();
  const child = await startServer(dir, port);
  try {
    // Still expired-invisible to reads...
    const get = await fetch(`http://127.0.0.1:${port}/old`);
    assert.strictEqual(get.status, 404);
    assert.deepStrictEqual(await get.json(), { error: 'not found' });

    // ...but present in the store: 200 {"deleted":true}, not 404.
    const del = await fetch(`http://127.0.0.1:${port}/old`, { method: 'DELETE' });
    assert.strictEqual(del.status, 200);
    assert.deepStrictEqual(await del.json(), { deleted: true });

    const again = await fetch(`http://127.0.0.1:${port}/old`);
    assert.strictEqual(again.status, 404);
    assert.deepStrictEqual(await again.json(), { error: 'not found' });
  } finally {
    await stopServer(child);
  }

  // The successful delete's full-file rewrite must have carried it away.
  assert.deepStrictEqual(Object.keys(readStoreFile(dir).entries).sort(), []);
});

test('a restart round-trip honors the seeded instants: the fresh process expires the same entry', async () => {
  const future = new Date(Date.now() + 2000).toISOString();
  const seed = JSON.stringify({
    entries: {
      old: { value: 'o', expiresAt: '2020-01-01T00:00:00Z' },
      future: { value: 'f', expiresAt: future },
    },
    nextCheckpoint: 0,
  });
  const dir = seedStore(seed);

  let port = await freePort();
  let child = await startServer(dir, port);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/future`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { key: 'future', value: 'f' });
  } finally {
    await stopServer(child);
  }

  // No mutation happened in boot one: the file must be untouched.
  assert.strictEqual(fs.readFileSync(path.join(dir, 'kv.json'), 'utf8'), seed);

  await sleepPast(future);

  // Same directory, brand-new process (and a new port): the seeded instants
  // must keep ruling — future has now lapsed, old never existed to reads.
  port = await freePort();
  child = await startServer(dir, port);
  try {
    const futureRes = await fetch(`http://127.0.0.1:${port}/future`);
    assert.strictEqual(futureRes.status, 404);
    assert.deepStrictEqual(await futureRes.json(), { error: 'not found' });

    const oldRes = await fetch(`http://127.0.0.1:${port}/old`);
    assert.strictEqual(oldRes.status, 404);
    assert.deepStrictEqual(await oldRes.json(), { error: 'not found' });

    const dump = await fetch(`http://127.0.0.1:${port}/dump`);
    assert.strictEqual(dump.status, 200);
    assert.deepStrictEqual(await dump.json(), { entries: {} });
  } finally {
    await stopServer(child);
  }

  // Reads never rewrite: even a restarted process hydrates exactly and lets
  // lazy expiry do its thing.
  assert.strictEqual(fs.readFileSync(path.join(dir, 'kv.json'), 'utf8'), seed);
});
