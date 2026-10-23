'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
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
    assert.ok(Object.hasOwn(file, 'entries'));
    assert.strictEqual(file.nextCheckpoint, 0);
    assert.deepStrictEqual(file.entries['persist-shape'], { value: 42, expiresAt: null });
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
    const { expiresAt: responseExpiresAt } = await res.json();

    const entry = readStoreFile().entries['persist-ttl'];
    assert.match(entry.expiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    assert.ok(Math.abs(Date.parse(entry.expiresAt) - (Date.now() + 60000)) < 5000);
    // File and response must describe the same instant.
    assert.strictEqual(entry.expiresAt, responseExpiresAt);
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

// --- child-process scenarios: boot hydration and fatal corrupt state ------

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

test('state survives a full process restart: a fresh process hydrates from kv.json', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kvstore-restart-'));

  let port = await freePort();
  let child = await startServer(dir, port);
  try {
    const res = await postSet(`http://127.0.0.1:${port}`, { key: 'boot-k', value: 42 });
    assert.strictEqual(res.status, 200);
  } finally {
    await stopServer(child);
  }

  // Same directory, brand-new process (and a new port): the old in-memory
  // state is gone, so a 200 here can only come from the persisted file.
  port = await freePort();
  child = await startServer(dir, port);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/boot-k`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { key: 'boot-k', value: 42 });
  } finally {
    await stopServer(child);
  }
});

test('an unparseable kv.json is a fatal boot error, never a silent empty start', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kvstore-corrupt-'));
  fs.writeFileSync(path.join(dir, 'kv.json'), 'not json');

  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, DATA_DIR: dir, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('corrupt-state process never exited')), 10000);
    child.once('exit', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });

  assert.notStrictEqual(code, 0);
  assert.ok(stderr.includes('not valid JSON'), `stderr must name the failure: ${stderr}`);
  assert.ok(stderr.includes('kv.json'), `stderr must name the file: ${stderr}`);
  assert.ok(!stdout.includes('listening on port'), 'process must not start serving');
});
