# github-core-clone-01-entry-2

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Wedspierre/github-core-clone-01-entry-2/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Wedspierre/github-core-clone-01-entry-2/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node 22 process, with no dependencies — only Node builtins. Git smart HTTP, REST v3, GraphQL and MCP in one process.

## What it serves

- **Git smart HTTP** (`/<owner>/<repo>.git/...`): protocol v2 `ls-refs` and `fetch`
  (with shallow and deepen support), v0 fetch, and `receive-pack` pushes with
  fast-forward checks and per-ref report-status. Clone and push work end-to-end
  with real `git`.
- **REST v3** (`/api/v3`): repositories, branches, refs, commits, contents,
  labels, issues, comments and pull requests, including squash merges.
- **GraphQL** (`/api/graphql`): viewer, repository, issue and pull-request
  queries, cursor pagination, introspection, and the create/close/merge/add-comment
  mutations.
- **MCP** (`/mcp`): JSON-RPC 2.0 Streamable HTTP with `server/discover`,
  `initialize`, `ping`, `tools/list` and six tools (`create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`).

## Layout

- `main.ts` — lifecycle: ephemeral bind, register with the trial environment,
  poll for done, exit.
- `app.ts` — HTTP routing, Bearer auth, JSON envelope.
- `store.ts` — the in-memory store, git object primitives, pack read/write and
  the deterministic clock (timestamps come from `MAKEFUN_TRIAL_NOW` plus a
  counter, so two runs on the same instance export byte-identical state).
- `gitproto.ts` — pkt-lines, advertisements, ls-refs, fetch planning (including
  shallow/deepen), receive-pack.
- `rest.ts` — REST v3 handlers and response shapes.
- `graphql.ts` — GraphQL parser and executor.
- `mcp.ts` — MCP JSON-RPC dispatch and tools.

## Run it

```sh
MAKEFUN_SHOP_TOKEN=<token> MAKEFUN_ENV_URL=<env> node --experimental-strip-types main.ts
```

Health check: `GET /healthz` returns `{"ok": true}`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=ta01qs0h&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
