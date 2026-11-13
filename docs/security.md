# Security and deployment

The bridge relies on an authenticating reverse proxy. Keep its listener private and protect every route, including the catalog and metrics. Authentication does not sandbox the subprocesses or filter prompt injections in MCP results.

## Session ownership

Set `MCP_WRAPPER_TRUSTED_USER_HEADER=x-authenticated-user` when the reverse proxy supplies a verified identity. Strip client-supplied copies of that header at the proxy before setting its value. A different or missing identity cannot use the session on POST or GET.

If no trusted header is configured, the bridge binds the session to the incoming Authorization header when present. It does not validate that token. Without either identity source, the session ID is a bearer capability. A proxy that strips Authorization should supply the trusted identity header instead.

Tenant credential headers are optional after initialization. If supplied again, they must match the environment used to start the subprocess. Unknown or expired session IDs return 404 and require a fresh initialization. Each session has a dedicated process; equal credentials never share one. DELETE verifies the same owner and stops only that session.

## Environment migration

Nonempty values under `env` are fixed administrator settings. Empty entries require `x-<ENV_NAME>` headers. To allow overriding an existing default, declare the key explicitly:

```json
{
  "mcpServers": {
    "example": {
      "command": "/usr/local/bin/example-mcp",
      "env": {
        "API_URL": "https://trusted.example.com",
        "API_KEY": ""
      },
      "headerEnv": ["API_KEY"]
    }
  }
}
```

This keeps a client from redirecting a configured API endpoint while retaining a static secret. Only trusted administrators should make destination URLs overridable. Runtime-loading and executable-search variables cannot be header-controlled. Fixed runtime settings may still be declared explicitly by the administrator.

Children inherit essential OS variables plus their declared environment, rather than the bridge's unrelated secrets. Child stderr content is omitted even in debug logs. MCP errors returned to clients are generic. The catalog includes variable names and placeholders, never configured defaults or command arguments.

On Windows, launch an executable directly (for example Node plus a JavaScript entry point); shell-only `.cmd` launch lines are not executed through a shell.

## Bounds and lifecycle

All numeric limits must be positive integers. Defaults are 100 processes, 100 HTTP sessions, 1 MiB HTTP bodies and stdout frames, 128 pending RPCs per process, a 30-second RPC/body-read timeout, and four SSE streams per session. See the README environment table for overrides. Oversized compressed bodies are rejected rather than decompressed.

Pending starts count against capacity. Failed starts release their capacity and terminate their child. Busy instances cannot be evicted for inactivity; their idle clock resets when the request completes. Eviction invalidates sessions and closes their SSE streams. Slow SSE readers are disconnected on backpressure. Shutdown waits for process starts and terminates Unix child process groups with SIGTERM, escalating to SIGKILL after five seconds.

A timed-out operation may already have had side effects. It is never automatically retried. Late responses cannot match a subsequent request, even if a client reuses its JSON-RPC ID.

These limits complement ingress rate limits and container memory, PID, filesystem and network restrictions. Use pinned MCP packages and least-privilege credentials. A restart loses the in-memory sessions and subprocess state. `MCP_WRAPPER_IDLE_MINUTES=0` disables idle expiry when state must live until explicit DELETE or shutdown; global process and session quotas still apply.
