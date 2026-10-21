# kvstore

A tiny durable key-value HTTP service, grown issue-by-issue by the
pi-dark-factory. Single plain-Node process, zero runtime dependencies, one
JSON file for state.

## What it does

`POST /set` / `GET /<key>` / `DELETE /<key>` / `GET /dump` — with **atomic
file persistence** (`DATA_DIR/kv.json`, loaded on boot, honored as-is) and
**lazy TTL expiry** on reads. A pre-seeded data file is served exactly as
found, pre-expired entries included.

## Documents

- [`PRD.md`](./PRD.md) — background, the exact HTTP + persistence contract
  (including the on-boot data-file semantics), non-goals, and the delivery
  requirements (CI workflow + docker-compose `worker` shipped by the factory).

## Operating model

Built autonomously: issues come from slicing `PRD.md`; every issue is
implemented, verified black-box (runtime + adversarial holdout scenarios,
including seeded-file startup), reviewed, and squash-merged. The verifier's
probe contract lives outside this repo by design.
