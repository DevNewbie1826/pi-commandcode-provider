# pi-commandcode-provider

A Command Code ([commandcode.ai](https://commandcode.ai)) provider plugin. The same
entrypoint is declared for **pi**, **Senpi**, and **Oh My Pi (OMP)** in `package.json`
(`pi` / `senpi` / `omp` manifests all point at `./src/index.ts`).

> Unofficial, community-maintained integration. Not affiliated with, endorsed by, or
> supported by Command Code. You need your own Command Code account, and Command Code's
> current terms, availability, limits, and pricing apply.

## What it does

- Streams Command Code models through the host provider contract.
- Keeps multiple Command Code accounts in a validated local store and rotates them
  deterministically (round-robin).
- Performs **bounded failover**: on a retryable failure (HTTP 401/403/429/5xx, or a
  transport/stream error that occurs _before_ any visible output), the current account is
  quarantined and the request moves to the next account.
- **Never replays after visible output** — once response content has been emitted, the
  request is never retried with another account (no duplicated text, tool calls, or billing).
- Logs in through the host `/login` flow using a local OAuth callback server.
- Discovers the model catalog from the Command Code API at load time and caches it for
  temporary offline use.
- Stores credential files atomically with mode `0600` on POSIX, and never prints tokens in
  CLI output or error messages.

## Account store

Credentials live at:

```
~/.commandcode/accounts.json
```

Override the path with `COMMANDCODE_ACCOUNTS_FILE`. The file is versioned, validated, and
atomically replaced; imports are parsed before any mutation, so a malformed import exits
non-zero and leaves the existing store unchanged.

### Selection order

For each request:

1. A healthy account from the store (round-robin; an account changes only after a
   safe-to-retry failure).
2. If no healthy account is available, `COMMANDCODE_API_KEY`.
3. Then the compatible host auth files below.

A concrete request-level API key bypasses account rotation.

### Auth fallback files

When the pool has no healthy account, these files are read in order:

```
~/.commandcode/accounts.json
~/.commandcode/auth.json
~/.omp/agent/auth.json
~/.pi/agent/auth.json
```

Accepted shapes include:

```json
{ "apiKey": "user_..." }
```

```json
{ "commandcode": "user_..." }
```

```json
{ "commandcode": { "type": "api", "key": "user_..." } }
```

(The official Command Code CLI shape under `"command-code"` is also recognised.)

## Manage accounts

An account CLI is included for local administration:

```sh
bun run qa:accounts -- list
bun run qa:accounts -- add <id> --token "user_..."
bun run qa:accounts -- next
bun run qa:accounts -- remove <id>
bun run qa:accounts -- import ./accounts.json
```

`list` prints each account id and state (`ready` / `quarantined`); it never prints tokens.

## Models

The catalog is fetched at load time from the Command Code provider API and cached at
`<agent-dir>/commandcode-models.json`. If discovery is temporarily unavailable, the cached
catalog is used. On a first offline launch without a cache, the host still loads, but
Command Code models remain unavailable until discovery succeeds.

## Configuration

| Variable                      | Purpose                                         |
| ----------------------------- | ----------------------------------------------- |
| `COMMANDCODE_API_KEY`         | Explicit credential; bypasses the account pool. |
| `COMMANDCODE_ACCOUNTS_FILE`   | Override the multi-account store path.          |
| `COMMANDCODE_API_BASE`        | Override the generation API base (tests/mocks). |
| `COMMANDCODE_AUTH_TIMEOUT_MS` | Browser callback timeout; default `15000`.      |
| `COMMANDCODE_MODELS_URL`      | Override the model-discovery endpoint.          |
| `COMMANDCODE_MODELS_CACHE`    | Override the model catalog cache path.          |

## Development

These commands install development dependencies and run repository checks only; they do
not install the extension into a host.

```sh
npm ci
npm test            # typecheck + tsx + node + bun test suites
npm run typecheck   # tsc --noEmit
npm run build       # tsc --noEmit
```

Requirements: Node.js 20 or newer, and [Bun](https://bun.sh) for the focused account
tests. Single runtime dependency: `zod`.

A manual end-to-end smoke test (requires a real `pi` binary and live Command Code
credentials) is available separately:

```sh
npm run test:smoke
```

## License

[MIT](THIRD_PARTY_NOTICES.md)
