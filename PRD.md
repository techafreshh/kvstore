# PRD — kvstore

## Background

Most internal tools start life needing a tiny durable store: counters,
feature flags, tokens, cache entries with lifetimes. This product is that
store, distilled: a single-process HTTP key-value service with **file
persistence** and **lazy TTL expiry**. Its defining property is that state
survives restarts exactly, byte-for-byte semantics included, and that a
pre-existing data file is honored on boot — the service is a good citizen of
whatever data directory it is pointed at.

## Product

`kvstore` is an HTTP service exposing set/get/delete/dump over JSON.
Single file (`server.js`), plain `node:http`, no frameworks, no npm
dependencies. Starts with `node server.js`, listens on `PORT` from the
environment. State lives in a JSON file at `DATA_DIR/kv.json` (`DATA_DIR`
from the environment, default `./data`).

## Contract (machine-checked; review walks these line by line)

### Health
- `GET /health` → `200` with JSON body containing `"ok":true`.

### Set
- `POST /set` with JSON `{"key":"<k>","value":<anything JSON-serializable>,"ttlSec":<int, optional>}`
  → `200` with JSON `{"key":"<k>","expiresAt":"<RFC3339 UTC>"|null}`.
  - `expiresAt` is null when `ttlSec` is absent; otherwise the instant
    `now + ttlSec` seconds, RFC3339 with `Z` suffix.
  - Reserved key namespace: keys given as **paths** (`GET/DELETE /<key>`) must
    match `^[A-Za-z0-9_-]{1,64}$`; a `POST /set` key outside that pattern is
    still accepted (storable, dumpable) but is only addressable via `/dump`
    — `GET /<that key>` is not required to find it.
  - Overwriting an existing key replaces value and TTL (or clears TTL when
    no `ttlSec` is given).
- Malformed JSON body, missing `key`, missing `value`, or a non-integer
  `ttlSec` → `400` with JSON `{"error":…}`; process keeps serving.

### Get
- `GET /<key>` → `200` `{"key":…,"value":…}` if present and unexpired.
- A present-but-expired key behaves exactly like an absent key: `404` with
  JSON `{"error":"not found"}`.
- Unknown key → `404` `{"error":"not found"}`. Never 5xx, never a hang.
- Expiry is enforced **no later than on read** (lazy expiry is fine);

### Delete
- `DELETE /<key>` → `200` `{"deleted":true}` when it existed (even expired),
  `404` `{"deleted":false}` when not.

### Dump
- `GET /dump` → `200` `{"entries":{ "<k>": <value>, … }}` — all unexpired
  entries, values verbatim.

### Persistence (the defining property)
- Every successful mutation (`set`, `delete`) writes the full store to
  `DATA_DIR/kv.json` **atomically** (write temp file, then rename).
- The file layout: `{"entries": { "<k>": {"value": <v>, "expiresAt": <RFC3339|null>} }, "nextCheckpoint": <unused-int> }`
  — the exact key set and JSON field names above; extra top-level fields are
  allowed but the `entries` shape is fixed.
- On boot, if `DATA_DIR/kv.json` exists and parses, the service serves its
  contents exactly: pre-seeded entries are readable, pre-seeded
  already-expired entries are invisible, pre-seeded future-dated entries
  expire on schedule.
- If the file is absent, the store starts empty. If the file is corrupt
  (unparseable), boot fails loudly: exit non-zero with a clear error on
  stderr (do not silently start empty).

### Concurrency
- Sequential requests only need to be correct; concurrent mutations must
  never corrupt the persisted file (atomic rename guarantees a reader of the
  file always sees a complete previous or new state).

## Delivery requirements (part of the contract, not optional)

1. **First issue ships the CI workflow**: `.github/workflows/ci.yml` running
   the test suite (`node --test`) on `pull_request` and `push` to the
   default branch, Node ≥ 22.
2. **First issue ships the container**: `docker-compose.yml` at the repo
   root, service named exactly `worker`, image with Node.js ≥ 22
   preinstalled, publishing the scenario port on `127.0.0.1`, and a volume
   or writable path for `DATA_DIR` such that the service can create and
   write `kv.json` inside the container.
3. Tests under `test/` (built-in `node:test`) covering persistence round-trips:
   write → restart process → read back identical.

## Non-goals

Replication, authentication, namespaces/collections, streaming, watch/
subscribe, compaction policies, size quotas, multi-process locking.

## Out of scope for this product

Metrics, admin endpoints, key listing beyond `/dump`, secondary indexes.

## Suggested build order (advisory — the slicer decides)

Skeleton (health, ports, `DATA_DIR` handling, compose + CI) → set/get/delete
with validation → atomic persistence file + boot loading → TTL expiry with
seeded-file semantics (pre-seeded expired entries invisible).
