'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// PORT from env, default 3000 for unset/empty/invalid values.
function readPort(raw) {
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 3000;
}

// DATA_DIR from env, default ./data.
function readDataDir() {
  return process.env.DATA_DIR && process.env.DATA_DIR.trim() !== ''
    ? process.env.DATA_DIR
    : './data';
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function requestHandler(req, res) {
  // No-op error listeners: a probe client aborting mid-request must not
  // crash the process with an uncaught 'error' event.
  req.on('error', () => {});
  res.on('error', () => {});

  const pathname = req.url.split('?')[0]; // never throws; query-insensitive
  if (req.method === 'GET' && pathname === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }
  // Global 404 shape from the PRD: JSON error, never 5xx, never a hang.
  sendJson(res, 404, { error: 'not found' });
}

function createServer() {
  return http.createServer(requestHandler);
}

// Bare process only: tests require() this module in-process.
if (require.main === module) {
  const dataDir = path.resolve(readDataDir());
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (err) {
    console.error(`kvstore: cannot create DATA_DIR ${dataDir}: ${err.message}`);
    process.exit(1);
  }
  const server = createServer();
  // No host argument: bind all interfaces so compose port-forwarding works.
  server.listen(readPort(process.env.PORT), () => {
    // Readiness scanners match this line; keep it the only boot output.
    console.log(`listening on port ${server.address().port}`);
  });
}

module.exports = { createServer, requestHandler, readPort, readDataDir };
