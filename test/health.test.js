'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { createServer, readPort, readDataDir } = require('../server.js');

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

test('GET /health returns 200 with JSON {"ok":true}', async () => {
  await withServer(async (url) => {
    const res = await fetch(`${url}/health`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /^application\/json/);
    assert.deepStrictEqual(await res.json(), { ok: true });
  });
});

test('unknown route returns 404 with JSON error', async () => {
  await withServer(async (url) => {
    const res = await fetch(`${url}/nope`);
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(await res.json(), { error: 'not found' });
  });
});

test('readPort falls back to 3000 on unset/empty/invalid, honors valid values', () => {
  assert.strictEqual(readPort(undefined), 3000);
  assert.strictEqual(readPort(''), 3000);
  assert.strictEqual(readPort('not-a-port'), 3000);
  assert.strictEqual(readPort('0'), 3000);
  assert.strictEqual(readPort('8123'), 8123);
});

test('readDataDir returns ./data when DATA_DIR is unset or empty', () => {
  const original = process.env.DATA_DIR;
  delete process.env.DATA_DIR;
  try {
    assert.strictEqual(readDataDir(), './data');
    process.env.DATA_DIR = '';
    assert.strictEqual(readDataDir(), './data');
  } finally {
    if (original === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = original;
    }
  }
});

// Probes hammer the server with odd targets and aborted connections; none of
// that may kill the process (an uncaught 'error' event would end readiness).
test('server stays alive across malformed targets and aborted clients', async () => {
  await withServer(async (url) => {
    const port = new URL(url).port;

    // Target llhttp accepts but URL parsing would reject, routed as 404.
    await new Promise((resolve, reject) => {
      const sock = net.connect(Number(port), '127.0.0.1', () => {
        sock.end('GET /\\ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
      });
      sock.on('data', () => {
        sock.destroy();
        resolve();
      });
      sock.on('error', reject);
    });

    // Client aborts mid-request; server must not crash on the socket error.
    await new Promise((resolve) => {
      const sock = net.connect(Number(port), '127.0.0.1', () => {
        sock.write('GET /health HTTP/1.1\r\nHost: x\r\n'); // no final CRLF
        setTimeout(() => {
          sock.destroy();
          resolve();
        }, 50);
      });
      sock.on('error', () => {}); // ECONNRESET from our own destroy
    });

    const res = await fetch(`${url}/health`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { ok: true });
  });
});
