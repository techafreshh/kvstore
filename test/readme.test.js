'use strict';

// Drift guard for README.md (issue #19): the acceptance bullet "every command
// and env var mentioned in the README matches the code" stays true only while
// the doc's factual claims are pinned to the source that documents them. The
// assertions read server.js rather than a copy of its values, so a new env var
// or route fails here until the README is updated. Prose is deliberately not
// asserted — only the strings a reader copies or types.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { readPort, readDataDir } = require('../server.js');

const ROOT = path.join(__dirname, '..');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const SERVER_SOURCE = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

test('README documents every environment variable server.js reads', () => {
  const names = new Set(
    [...SERVER_SOURCE.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1])
  );
  // A scraper that silently matches nothing would make this test vacuous.
  assert.strictEqual(names.size >= 2, true);
  for (const name of names) {
    assert.ok(README.includes(name), `README must document env var ${name}`);
  }
});

test('README documents every route requestHandler dispatches', () => {
  for (const route of ['GET /health', 'POST /set', 'GET /dump', 'GET /<key>', 'DELETE /<key>']) {
    assert.ok(README.includes(route), `README must document ${route}`);
  }
});

test("README quickstart uses the repo's real toolchain and the code's defaults", () => {
  assert.match(README, /node server\.js/);
  assert.match(README, /node --test/);
  // There is no package.json, so any dependency install step would be false.
  assert.strictEqual(fs.existsSync(path.join(ROOT, 'package.json')), false);
  assert.doesNotMatch(README, /\b(npm|yarn|pnpm) (install|ci|i|add)\b/);
  assert.ok(README.includes(String(readPort(undefined))));
  const original = process.env.DATA_DIR;
  delete process.env.DATA_DIR;
  try {
    assert.ok(README.includes(readDataDir()));
  } finally {
    // Sibling suites share this process env, so leave it as it was found.
    if (original !== undefined) process.env.DATA_DIR = original;
  }
});
