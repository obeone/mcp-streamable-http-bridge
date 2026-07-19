# mcp-streamable-http-bridge

Bridge **stdio** Model Context Protocol (MCP) servers to **MCP Streamable HTTP** behind a single gateway. Each client supplies tenant-specific values via HTTP headers; the wrapper spawns isolated subprocesses, routes MCP traffic, evicts idle instances, and exposes logs and Prometheus metrics.

## Objective

Stdio MCP servers assume one long-lived process per client with environment variables fixed at startup. That works for a desktop client (for example Cursor) but not for a shared, multi-user gateway.

This project:

- Loads MCP server definitions from a **config folder** using the same shape as Cursor **`mcp.json`** (`mcpServers`).
- Accepts **HTTP** requests and forwards them to the correct **stdio** child process.
- Maps **`x-<ENV_NAME>`** request headers to process environment variables declared under each server’s `env` block.
- Derives a **stable hash** from the server name plus resolved `env` values to reuse one subprocess per tenant.
- **Evicts** subprocesses after a configurable idle period (global setting).
- Ships with **Node.js**, **npx**, **uv**, and **python3** in the container image for common MCP launch patterns.
- Logs with **Winston** (console + size-rotated file) and exposes **Prometheus** metrics.

Implementation is **Node.js (JavaScript)**, organized in a **class-first** structure.

## Quick start

### Docker Compose

```bash
docker compose up --build
```

- **Config:** edit JSON under [`config/`](config/) (mounted read-only at **`/config`** in the container).
- **Logs:** written to [`logs/`](logs/) on the host via **`./logs:/app/logs`** (active file **`/app/logs/mcp-wrapper.log`** inside the container).
- **Env:** copy [`.env.example`](.env.example) to `.env` to override defaults; Compose also reads optional `.env` for `PORT` on the host mapping.

Health: `http://localhost:8080/` (HTML catalog) · Raw Markdown: `/catalog.md` · Metrics: `http://localhost:8080/metrics`

### Docker (manual)

```bash
docker build -t mcp-streamable-http-bridge .
docker run --rm -p 8080:8080 \
  -v /path/to/mcp-config:/config:ro \
  -v /path/to/logs:/app/logs \
  -e MCP_WRAPPER_IDLE_MINUTES=15 \
  mcp-streamable-http-bridge
```

### Local development

```bash
npm install
npm start    # reads ./config, writes ./logs/mcp-wrapper.log
npm test
```

Outside Docker, paths resolve to the repo **`config/`** and **`logs/`** directories. In the container they stay **`/config`** and **`/app/logs/mcp-wrapper.log`** (via `/.dockerenv`). Integration tests override paths via constructor options.

## Configuration

### Gateway config (`config/`)

The wrapper reads **every `*.json` file** in the config directory (top level only—not subfolders) and **merges** all `mcpServers` entries. **Server names must be unique** across files; duplicates fail at startup.

| File | Loaded? | Role |
|------|---------|------|
| [`config/mcp.json`](config/mcp.json) | Yes | Your MCP servers (`command` / `args` / `env`) |
| [`config/example.mock.mcp.json.sample`](config/example.mock.mcp.json.sample) | No (not `.json`) | Copy/rename to `.json` if you want the sample `mock` server |

Each loaded file uses the **gateway** schema (stdio spawn line):

```json
{
  "mcpServers": {
    "grafana": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-grafana"],
      "env": {
        "GRAFANA_URL": "https://grafana.example.com",
        "GRAFANA_API_KEY": ""
      }
    }
  }
}
```

- **`command` / `args`**: spawn line for the MCP server (stdio).
- **`env`**: keys injected into the child process. Values may be defaults in JSON and/or overridden by headers (see below).

Every key listed under **`env`** participates in **tenant identity** (hash) and in the subprocess environment.

### Client config (Streamable HTTP)

MCP clients (e.g. Cursor) connect to the **gateway**, not to stdio directly. Use **`url`** pointing at `/mcp/{serverName}` and optional **`headers`** for tenant `x-<ENV>` values (same names as in the gateway `env` block):

```json
{
  "mcpServers": {
    "grafana": {
      "url": "http://localhost:8080/mcp/grafana",
      "headers": {
        "x-GRAFANA_URL": "https://grafana.example.com",
        "x-GRAFANA_API_KEY": "<your-api-key>"
      }
    }
  }
}
```

The client performs MCP **Streamable HTTP** (`initialize`, session id, tool calls). You do not configure `initialize` by hand—only the gateway URL and tenant headers.

Open **`GET /`** in a browser for a styled catalog with per-server client snippets, or **`GET /catalog.md`** / `Accept: text/markdown` for raw Markdown. Set **`PUBLIC_BASE_URL`** when the gateway is behind a reverse proxy so URLs in the catalog use the public host.

## HTTP usage (MCP Streamable HTTP)

The wrapper implements **MCP Streamable HTTP** on `/mcp/{serverName}`:

1. **First request** — `POST` with `method: "initialize"`, tenant **`x-*` headers**, and JSON-RPC body. Response includes **`mcp-session-id`** header.
2. **Later requests** — `POST` with the same **`mcp-session-id`** and one JSON-RPC message per request (no tenant headers required if session is valid).
3. **Server → client streaming** — `GET` with `Accept: text/event-stream` and **`mcp-session-id`** to receive MCP notifications over SSE.

| Path | Method | Purpose |
|------|--------|---------|
| `/` | GET | HTML catalog (GitHub-style); send `Accept: text/markdown` for raw Markdown |
| `/catalog.md` | GET | Raw Markdown catalog |
| `/mcp/{serverName}` | POST | Client → server MCP messages |
| `/mcp/{serverName}` | GET | SSE stream (requires session header) |
| `/health` | GET | Liveness |
| `/metrics` | GET | Prometheus scrape |

### Tenant headers

For each key in the server’s `env` object, send a header:

```text
x-<ENV_NAME>: <value>
```

Header names are **case-insensitive**. Examples:

| Config `env` key | Header |
|------------------|--------|
| `GRAFANA_URL` | `x-GRAFANA_URL` |
| `GRAFANA_API_KEY` | `x-GRAFANA_API_KEY` |

**Resolution order:** header value if present, otherwise the value from JSON. If a key has no value from either source, the request is rejected before spawning.

**Instance key:** `sha256(serverName + canonical resolved env)` — same server + same env → same subprocess; any difference → a new subprocess.

Do not log header values or full instance keys; use structured logs with a short hash prefix for support.

Stdio children use **Content-Length** framed JSON-RPC on stdin/stdout (same as the official MCP SDK).

## Environment variables

### Gateway

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP listen port |
| `MCP_WRAPPER_IDLE_MINUTES` | `15` | Idle time before stopping a tenant subprocess |
| `MCP_PROTOCOL_VERSION` | `2024-11-05` | MCP protocol version sent to stdio servers on spawn |
| `PUBLIC_BASE_URL` | _(empty)_ | Public base URL for links in the `GET /` Markdown catalog (e.g. `https://mcp.example.com`) |

### Logging (Winston)

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `info` | Log level for all transports |
| `LOG_MAX_SIZE` | `10m` | Rotate when file exceeds this size (not daily) |
| `LOG_MAX_FILES` | `5` | Number of rotated files to retain |

**Fixed paths (not env-configurable):** In Docker, MCP JSON under **`/config`**, logs **`/app/logs/mcp-wrapper.log`**, Prometheus at **`GET /metrics`**. Locally, **`config/`** and **`logs/mcp-wrapper.log`** under the repo root. Bind-mount host `config/` and `logs/` in Compose.

## Metrics (Prometheus)

Aggregated metrics avoid high-cardinality labels (no full tenant hash on time series). Typical series:

- **`mcp_servers_configured`** — count after config load
- **`mcp_instances_active{server}`** — running subprocesses per configured server
- **`mcp_rpc_requests_total{server,mcp_method}`** — MCP methods (`tools/list`, `tools/call`, …)
- **`mcp_tool_calls_total{server,tool}`** — `tools/call` by tool name
- **`mcp_rpc_duration_seconds{server,mcp_method}`** — latency histograms

Per-tenant detail belongs in **structured logs**, not metric labels. See [docs/architecture.md](docs/architecture.md).

## Documentation

| Document | Contents |
|----------|----------|
| [docs/product.md](docs/product.md) | Problem, users, features, non-goals |
| [docs/architecture.md](docs/architecture.md) | Components, flows, config, observability |

## License

Add your license file as appropriate for your distribution.
