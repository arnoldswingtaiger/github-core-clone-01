# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/arnoldswingtaiger/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/arnoldswingtaiger/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node process, no dependencies beyond the
standard library. It serves git smart HTTP (protocol v2 upload-pack and v0
receive-pack), the REST v3 API, GraphQL v4 and MCP from its own in-memory
store: repositories, branches, commits, contents, issues, labels and pull
requests with squash merges, all backed by a real git object database
(SHA-1 objects, trees, packfiles, shallow and incremental fetches).

## Run it

```sh
MAKEFUN_ENV_URL=http://localhost:8080 MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

The entry binds an ephemeral port, registers it with the env, serves until the
env says done, then exits 0. `GET /healthz` answers `{"ok": true}`.

## Layout

- `main.ts` — the entry <-> env lifecycle (bind, register, poll `/done`).
- `app.ts` — the HTTP server and router: health, git, REST, GraphQL, MCP.
- `scenario.ts` — the token owner's identity, derived deterministically from
  the contest's fixed scenario seed.
- `gitobj.ts` — git objects: hashing, commit/tree/tag parsing, packfiles.
- `store.ts` — the forge store: repositories, refs, issues, pull requests.
- `gitproto.ts` — git smart HTTP: advertisements, ls-refs, fetch, push.
- `rest.ts` — the REST v3 API.
- `graphql.ts` — the GraphQL v4 API (small parser + executor).
- `mcp.ts` — the MCP endpoint (JSON-RPC 2.0, `server/discover` + tools).

---

Entered on [make.fun](https://make.fun/?ref=zv5hc3pw&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards
