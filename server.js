'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// In-memory store keyed by key string; entry shape { value, expiresAt }
// mirrors the PRD persistence layout issue #3's DATA_DIR/kv.json consumes.
const store = new Map();

// GET /<key> path constraint: exactly one raw, undecoded segment of 1-64
// chars from [A-Za-z0-9_-]. Matching the raw pathname (never decodeURIComponent,
// which throws URIError on malformed escapes) makes "we ird!" and "%zz"
// segments fall to the global 404 instead of erroring.
const KEY_PATTERN = /^\/([A-Za-z0-9_-]{1,64})$/;

// Lazy expiry: decided at read time, so expired entries are indistinguishable
// from absent ones while reads never mutate the store.
function isExpired(entry, now = Date.now()) {
  return entry.expiresAt !== null && Date.parse(entry.expiresAt) <= now;
}

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

// POST /set: strict validation, store, and expiresAt response semantics.
// Async because the body is consumed via the async request iterator; every
// failure path answers 400 and returns, so the promise itself never rejects.
async function handleSet(req, res) {
  let raw = null;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    raw = Buffer.concat(chunks).toString('utf8');
  } catch (err) {
    sendJson(res, 400, { error: 'failed to read request body' });
    return;
  }
  let body = null;
  try {
    body = JSON.parse(raw);
  } catch (err) {
    sendJson(res, 400, { error: 'invalid JSON body' });
    return;
  }
  // Guard ladder: every rejection is an explicit, self-describing 400.
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, { error: 'body must be a JSON object' });
    return;
  }
  if (typeof body.key !== 'string') {
    sendJson(res, 400, { error: 'key is required and must be a string' });
    return;
  }
  // Presence, not truthiness: a JSON null value is a storable value.
  if (!Object.hasOwn(body, 'value')) {
    sendJson(res, 400, { error: 'value is required' });
    return;
  }
  if (body.ttlSec !== undefined && !Number.isInteger(body.ttlSec)) {
    sendJson(res, 400, { error: 'ttlSec must be an integer' });
    return;
  }
  let expiresAt = null;
  if (body.ttlSec !== undefined) {
    // Clamp the resulting time value (the valid Date range applies to it, not
    // to the offset alone) so any integer ttlSec yields a valid UTC instant
    // instead of an Invalid Date whose toISOString throws.
    const targetMs = Date.now() + body.ttlSec * 1000;
    expiresAt = new Date(Math.max(-8.64e15, Math.min(8.64e15, targetMs))).toISOString();
  }
  store.set(body.key, { value: body.value, expiresAt });
  sendJson(res, 200, { key: body.key, expiresAt });
}

// GET /<key>: on hit answer { key, value } and report handled; on miss or
// expired entry report not-handled so requestHandler reaches the single
// global 404 (expired and absent respond identically).
function handleGet(key, res) {
  const entry = store.get(key);
  if (entry === undefined || isExpired(entry)) return false;
  sendJson(res, 200, { key, value: entry.value });
  return true;
}

// GET /dump: bare key -> value map of every unexpired entry, values verbatim
// (no expiresAt metadata). A single now snapshot keeps the pass consistent.
function handleDump(res) {
  const now = Date.now();
  const entries = {};
  for (const [key, entry] of store) {
    if (isExpired(entry, now)) continue;
    entries[key] = entry.value;
  }
  sendJson(res, 200, { entries });
}

// DELETE /<key>: existence is decided by presence in the store, expired or
// not — lazy expiry (#3) leaves expired entries in the Map, and the issue
// counts them as existing until a read or delete removes them. So no
// isExpired() call here: Map.prototype.delete's return value alone decides
// between 200 {"deleted":true} and 404 {"deleted":false}.
function handleDelete(key, res) {
  const existed = store.delete(key);
  sendJson(res, existed ? 200 : 404, { deleted: existed });
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
  if (req.method === 'POST' && pathname === '/set') {
    handleSet(req, res).catch(() => {
      // Unreachable while handleSet catches its own failures; kept so a
      // future edit can never surface as an unhandled rejection mid-probe.
      sendJson(res, 400, { error: 'failed to read request body' });
    });
    return;
  }
  if (req.method === 'GET' && pathname === '/dump') {
    handleDump(res);
    return;
  }
  if (req.method === 'DELETE') {
    // No reserved DELETE paths: /health, /set and /dump are GET/POST-only,
    // so a stored key "dump" stays deletable via DELETE /dump. Non-matching
    // DELETE paths fall through to the single global 404 below.
    const m = KEY_PATTERN.exec(pathname);
    if (m !== null) {
      handleDelete(m[1], res);
      return;
    }
  }
  if (req.method === 'GET') {
    const m = KEY_PATTERN.exec(pathname);
    if (m !== null && handleGet(m[1], res)) return;
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
