# kvstore

[![CI](https://github.com/techafreshh/kvstore/actions/workflows/ci.yml/badge.svg)](https://github.com/techafreshh/kvstore/actions/workflows/ci.yml)

> A tiny, durable key-value store you run as a single Node.js process.

`kvstore` is an HTTP service exposing set, get, delete and dump over JSON. It is one plain `node:http` process with zero dependencies, and all of its state lives in a single JSON file on disk. TTLs are lazy: an entry expires the next time it is read.

## Why this exists

Small internal tools keep needing the same thing — a counter, a feature flag, a token, a cache entry with a lifetime. This is that store distilled, and nothing else: one process, one file, state that survives a restart unchanged. A data directory is honoured exactly as found, so the service can be pointed at state written by an earlier run without rewriting it.

## Quickstart

Requires **Node.js 22 or newer**.

```bash
git clone https://github.com/techafreshh/kvstore.git
cd kvstore
node server.js
```

The process prints `listening on port 3000`. State is written to `./data/kv.json`: the directory is created at boot, the file on the first write.

> [!NOTE]
> There is no install step: the project has no dependencies and no `package.json`.

```bash
curl -s http://localhost:3000/health
# {"ok":true}
```

### With Docker

`docker compose up worker` runs the same server on <http://localhost:3000>, with `DATA_DIR=/data` backed by the `worker-data` volume. `docker compose down` stops it; `docker compose down -v` also discards the stored data.

## Usage

| Endpoint | Request | Success response | Failure |
| --- | --- | --- | --- |
| `GET /health` | — | `200` `{"ok":true}` | — |
| `POST /set` | JSON body `{"key":"<k>","value":<any JSON>,"ttlSec":<integer, optional>}` | `200` `{"key":"<k>","expiresAt":"<RFC 3339 UTC>"\|null}` | `400` `{"error":"…"}` for malformed JSON, a non-object body, a missing or non-string `key`, a missing `value`, or a non-integer `ttlSec`; `500` if persistence fails |
| `GET /<key>` | — | `200` `{"key":"<k>","value":<v>}` | `404` `{"error":"not found"}` when the key is absent **or expired** |
| `DELETE /<key>` | — | `200` `{"deleted":true}`; expired entries count as existing | `404` `{"deleted":false}`; `500` if persistence fails |
| `GET /dump` | — | `200` `{"entries":{"<k>":<v>,…}}` for every unexpired entry, values verbatim | — |

```bash
curl -s -X POST http://localhost:3000/set \
  -H 'content-type: application/json' \
  -d '{"key":"greeting","value":"hello"}'
# {"key":"greeting","expiresAt":null}

curl -s http://localhost:3000/greeting
# {"key":"greeting","value":"hello"}

curl -s http://localhost:3000/dump
# {"entries":{"greeting":"hello"}}

curl -s -X DELETE http://localhost:3000/greeting
# {"deleted":true}
```

- `ttlSec` is an integer number of seconds. `expiresAt` is `null` when it is omitted, and overwriting a key without `ttlSec` clears whatever TTL it had.
- `value` may be any JSON value, `null` included.
- Keys addressed by path must match `[A-Za-z0-9_-]{1,64}`. `POST /set` stores any string key and `GET /dump` returns it, but a key outside that pattern cannot be fetched or deleted by path.
- Query strings are ignored: `GET /dump?x=1` is `GET /dump`.

## Persistence

Every successful `set` or `delete` rewrites the whole store to `DATA_DIR/kv.json` atomically — a temporary file inside `DATA_DIR` first, then a `rename` — so a reader of the file never sees a partial write.

```json
{
  "entries": { "<key>": { "value": <any JSON>, "expiresAt": "<RFC 3339 UTC>" } },
  "nextCheckpoint": 0
}
```

`expiresAt` is `null` for an entry without a TTL. `nextCheckpoint` is a reserved, currently unused field. Expired entries stay in memory and in the file until the key is overwritten or deleted.

On boot an existing `kv.json` is served exactly as found: pre-seeded entries are readable, already-expired ones are invisible, future-dated ones expire on schedule, and the file is not rewritten before the first mutation. A missing file means an empty store.

> [!WARNING]
> A `kv.json` that cannot be read, does not parse, or has no `entries` object is fatal: the process prints `kvstore: cannot load state:` on stderr and exits non-zero rather than starting empty.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | TCP port to listen on. Unset, empty, non-numeric or out-of-range values fall back to `3000`. |
| `DATA_DIR` | `./data` | Directory holding `kv.json`; created if missing and resolved to an absolute path at boot. |

```bash
PORT=8080 DATA_DIR=/var/lib/kvstore node server.js
```

## Project layout

```text
server.js                     HTTP routing, in-memory store, TTL, persistence
test/                         node:test suites for HTTP, TTL and persistence
docker-compose.yml            worker service for container runs
.github/workflows/ci.yml      test suite plus compose smoke job
PRD.md                        product contract and non-goals
```

## Testing

`node --test` runs every `test/*.test.js`: HTTP contracts, atomic persistence, restart round-trips, TTL semantics and concurrent writes. A single suite runs on its own, for example `node --test test/get.test.js`. CI runs the same suite on Node.js 22, validates `docker-compose.yml`, and boots the `worker` service to check a live `/health`, a write, and `kv.json` inside the container.

## Limitations

- One process, one instance: no replication, authentication, TLS, namespaces or watch/subscribe.
- The whole store is in memory and every mutation synchronously rewrites all of `kv.json`, so write cost grows with store size and blocks the event loop.
- Expired entries are never swept; they remain in memory and in the file until the key is overwritten or deleted.
- Path-addressable keys are limited to `[A-Za-z0-9_-]{1,64}`. Keys outside that pattern, including the empty string, are reachable only through `/dump`.
- `GET` reserves `/health` and `/dump` before the key route, so stored keys named `health` or `dump` are not readable through `GET /<key>`; `GET /set` does read a key named `set`. `DELETE` has no reserved paths, so `DELETE /dump` deletes a stored key named `dump`.
- `ttlSec` is integer seconds only; zero or negative values produce entries that are already expired.
- No value-size or body-size limits, and no pagination on `/dump`.
- No CORS headers.
- Sharing one `DATA_DIR` between processes is not safe: the last writer wins.

## Documentation

[`PRD.md`](./PRD.md) is the product contract: background, exact HTTP and persistence semantics, and non-goals. This repository is built issue-by-issue from that PRD by `pi-dark-factory`; the black-box verification probes live outside the repo by design.
