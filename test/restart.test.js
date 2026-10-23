'use strict';

// Issue #8's contract, probed end-to-end: write → SIGTERM → restart on the
// same DATA_DIR → read back identical. Every state transfer goes through
// disk only — each boot is a real `node server.js` child process, so the
// in-process store is never involved. One fresh temp DATA_DIR per test, and
// a fresh port per boot, matching the restart idiom the other suites use.

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

function kvPath(dir) {
  return path.join(dir, 'kv.json');
}

// Every persistence assertion reads the file the way an external consumer
// would: straight off disk, through JSON.parse.
function readStoreFile(dir) {
  return JSON.parse(fs.readFileSync(kvPath(dir), 'utf8'));
}

// POST /set helper: only well-formed objects here, since this suite
// exercises restart round-trips, not body validation (that is set.test.js's job).
async function postSet(base, body) {
  return fetch(`${base}/set`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('a set value survives a restart: set {"a":[1,2]}, SIGTERM, fresh process reads it back identical', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kvstore-rt-p-'));

  const port = await freePort();
  const child = await startServer(dir, port);
  try {
    const res = await postSet(`http://127.0.0.1:${port}`, { key: 'p', value: { a: [1, 2] } });
    assert.strictEqual(res.status, 200);
  } finally {
    await stopServer(child);
  }

  // Same directory, brand-new process (and a new port): the in-memory state
  // is gone, so a 200 with the exact body can only come from the file.
  const port2 = await freePort();
  const child2 = await startServer(dir, port2);
  try {
    const res = await fetch(`http://127.0.0.1:${port2}/p`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { key: 'p', value: { a: [1, 2] } });
  } finally {
    await stopServer(child2);
  }
});

test('a TTL set survives a restart with its expiresAt byte-for-byte, and a seeded expired entry stays invisible', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kvstore-rt-q-'));
  // Seed the expired entry before the first boot (frozen 2020 instant, the
  // seeding idiom): boot 1 hydrates it, and the set's full-file rewrite
  // carries both entries, so the restart file genuinely holds {expired, q}.
  fs.writeFileSync(kvPath(dir), '{"entries":{"expired":{"value":"gone soon",'
    + '"expiresAt":"2020-01-01T00:00:00Z"}},"nextCheckpoint":0}');

  const port = await freePort();
  const child = await startServer(dir, port);
  try {
    const res = await postSet(`http://127.0.0.1:${port}`, { key: 'q', value: 1, ttlSec: 100 });
    assert.strictEqual(res.status, 200);
    const { expiresAt } = await res.json();

    // File and response must describe the same instant, and it must really
    // be on disk (non-null) before anything restarts.
    const entry = readStoreFile(dir).entries.q;
    assert.strictEqual(entry.expiresAt, expiresAt);
    assert.notStrictEqual(entry.expiresAt, null);
  } finally {
    await stopServer(child);
  }

  // Snapshot before the restart: the restart must not touch a single byte.
  const before = fs.readFileSync(kvPath(dir), 'utf8');

  const port2 = await freePort();
  const child2 = await startServer(dir, port2);
  try {
    const res = await fetch(`http://127.0.0.1:${port2}/q`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { key: 'q', value: 1 });

    const expired = await fetch(`http://127.0.0.1:${port2}/expired`);
    assert.strictEqual(expired.status, 404);
    assert.deepStrictEqual(await expired.json(), { error: 'not found' });
  } finally {
    await stopServer(child2);
  }

  // Reads never rewrite, so the whole file — q's expiresAt included — must
  // be byte-identical across the restart.
  assert.strictEqual(fs.readFileSync(kvPath(dir), 'utf8'), before);
});

test('a delete survives a restart: set d, restart, DELETE, restart again, still gone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kvstore-rt-d-'));

  const port = await freePort();
  const child = await startServer(dir, port);
  try {
    const res = await postSet(`http://127.0.0.1:${port}`, { key: 'd', value: 1 });
    assert.strictEqual(res.status, 200);
  } finally {
    await stopServer(child);
  }

  const port2 = await freePort();
  const child2 = await startServer(dir, port2);
  try {
    // The entry rode the disk into this fresh process...
    const res = await fetch(`http://127.0.0.1:${port2}/d`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { key: 'd', value: 1 });

    // ...and the delete persists the removal.
    const del = await fetch(`http://127.0.0.1:${port2}/d`, { method: 'DELETE' });
    assert.strictEqual(del.status, 200);
    assert.deepStrictEqual(await del.json(), { deleted: true });
  } finally {
    await stopServer(child2);
  }

  const port3 = await freePort();
  const child3 = await startServer(dir, port3);
  try {
    const res = await fetch(`http://127.0.0.1:${port3}/d`);
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(await res.json(), { error: 'not found' });
  } finally {
    await stopServer(child3);
  }
});
