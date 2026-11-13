# Product overview

## Problem

MCP servers that speak **stdio** are designed for a single client process: one subprocess, environment variables set once at launch, no shared URL. Platforms that want many users or tenants on the same MCP tooling hit three walls:

1. **Credentials and URLs differ per user** but stdio `env` is static for a given process.
2. **Remote access** requires something other than stdin/stdout pipes (typically HTTP).
3. **Resource control** — without idle eviction, every distinct credential spawns a process that never exits.

## Solution

**mcp-streamable-http-bridge** is a gateway container/service that:

- Reads **Cursor-compatible** `mcpServers` configuration from a mounted config directory.
- Exposes **MCP Streamable HTTP** (`POST` + session header, optional `GET` SSE) while proxying to stdio children.
- Uses a **convention-based tenant model**: empty `env` entries, or keys explicitly listed in `headerEnv`, can be supplied or overridden via **`x-<ENV_NAME>`** headers; resolved env plus server name defines a **hash** and thus a dedicated subprocess.
- Applies a **global idle timeout** (`MCP_WRAPPER_IDLE_MINUTES`) to stop unused subprocesses.
- Preinstalls **npx**, **uv (Astral)**, and **python3** so most upstream MCP packages run without custom images.
- Provides **operations-grade** logging (Winston, size-based rotation) and **Prometheus** metrics for capacity and SLO monitoring.

## Target users

| Persona | Need |
|---------|------|
| Platform engineer | Host many MCP servers behind one URL with per-user secrets in headers |
| Internal tools team | Reuse desktop `mcp.json` configs in Kubernetes or Docker without rewriting servers |
| SRE / on-call | Idle eviction, metrics, rotated logs, health checks |

## Core features

### Configuration compatibility

- Config folder with the same **`mcpServers`** schema as Cursor **`mcp.json`**.
- No wrapper-specific per-server blocks required: **`env` keys** define both injection and tenancy.

### Multi-tenant stdio instances

- One subprocess per **(server name, resolved env)** hash.
- Header **`x-<ENV>`** supplies empty `env` entries and explicitly allowlisted `headerEnv` overrides.
- Nonempty JSON values stay fixed unless explicitly listed in `headerEnv`.

### Lifecycle management

- Lazy start on first request for a hash.
- **Touch** idle timer on MCP activity.
- Periodic eviction of instances idle longer than **`MCP_WRAPPER_IDLE_MINUTES`**.

### Runtime stack (container)

- **Node.js** wrapper process (class-first JavaScript codebase).
- **npx**, **uv**, **python3** available for launching upstream MCP servers.

### Observability

- **Winston**: console + file, **size** rotation (`LOG_MAX_SIZE`, default 10m), **`LOG_MAX_FILES`** (default 5), default level **info**.
- **Prometheus**: configured server count, active instances per server, RPC and tool call rates and latency — **without** using full tenant hash as metric labels.

## User-facing behavior

### Success path

1. Operator opens **`GET /`** (styled HTML catalog) or **`GET /catalog.md`** for raw Markdown.
2. Client sends HTTP POST to `/mcp/{serverName}` with MCP JSON-RPC body and required `x-*` headers.
2. Wrapper resolves env, computes hash, reuses or starts stdio child, completes MCP handshake if new.
3. Request is forwarded; response returned over HTTP.
4. Idle timer resets for that instance.

### Failure path

- Unknown server name → **404**.
- Missing required env (no header and no JSON value) → **401**.
- Child crash → instance dropped; next request may respawn.
- Pool/resource limits (future) → **503** with clear message.

## Non-goals (initial release)

- Rewriting MCP servers to native HTTP.
- Strong isolation between untrusted tenants (subprocess separation only; not per-tenant containers or gVisor).
- Per-server idle TTL in config (global env only for v1).
- Per-tenant billing or quota stores (use logs/metrics aggregates first).
- Legacy non-Streamable HTTP MCP clients (use a client that speaks Streamable HTTP).

## Success criteria

- Drop-in config from an existing **`mcp.json`** entry (plus headers for secret keys).
- N distinct header/env combinations → at most N active subprocesses for that server (plus eviction).
- Operators can scrape **`/metrics`** and tail rotated logs without seeing raw secrets.
- Documented env vars for idle time and logging; **`/metrics`** is always on at a fixed path.

## Related reading

- [Architecture](architecture.md) — components, data flow, observability design
- [README](../README.md) — quick start and configuration examples
