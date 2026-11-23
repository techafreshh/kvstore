'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

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

async function assertFatalBoot(seedObject) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kvstore-shape-'));
  fs.writeFileSync(path.join(dir, 'kv.json'), JSON.stringify(seedObject));

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
    const timer = setTimeout(() => reject(new Error('malformed-entry process never exited')), 10000);
    child.once('exit', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });

  assert.notStrictEqual(code, 0, 'malformed seeded entry must fail boot');
  assert.ok(stderr.includes('kv.json'), `stderr must name the file: ${stderr}`);
  assert.ok(!stdout.includes('listening on port'), 'process must not start serving');
}

test('numeric seeded entry fails boot loudly', async () => {
  await assertFatalBoot({ entries: { k: 123 }, nextCheckpoint: 0 });
});

test('null seeded entry fails boot loudly', async () => {
  await assertFatalBoot({ entries: { k: null }, nextCheckpoint: 0 });
});

test('string seeded entry fails boot loudly', async () => {
  await assertFatalBoot({ entries: { k: 'v' }, nextCheckpoint: 0 });
});

test('array seeded entry fails boot loudly', async () => {
  await assertFatalBoot({ entries: { k: [1, 2] }, nextCheckpoint: 0 });
});

test('object entry with non-string expiresAt fails boot loudly', async () => {
  await assertFatalBoot({ entries: { k: { value: 1, expiresAt: 123 } }, nextCheckpoint: 0 });
});

test('valid seed boots, serves both entries, and stays byte-identical', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kvstore-shape-valid-'));
  const future = new Date(Date.now() + 60000).toISOString();
  const seed = JSON.stringify({
    entries: {
      a: { value: 1, expiresAt: null },
      b: { value: 'two', expiresAt: future },
    },
    nextCheckpoint: 0,
  });
  fs.writeFileSync(path.join(dir, 'kv.json'), seed);

  const port = await freePort();
  const child = await startServer(dir, port);
  try {
    const ra = await fetch(`http://127.0.0.1:${port}/a`);
    assert.strictEqual(ra.status, 200);
    assert.deepStrictEqual(await ra.json(), { key: 'a', value: 1 });

    const rb = await fetch(`http://127.0.0.1:${port}/b`);
    assert.strictEqual(rb.status, 200);
    assert.deepStrictEqual(await rb.json(), { key: 'b', value: 'two' });
  } finally {
    await stopServer(child);
  }

  assert.strictEqual(fs.readFileSync(path.join(dir, 'kv.json'), 'utf8'), seed);
});
