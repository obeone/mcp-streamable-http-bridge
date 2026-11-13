# Session lifecycle

Each successful HTTP initialization owns one stdio MCP subprocess. Session A and session B get distinct processes even if they use the same server, credentials and arguments. The bridge generates the session ID; the MCP client stores the returned `Mcp-Session-Id` response header and sends it on later requests.

| Request | Process |
| --- | --- |
| Initialize session A | Start process A |
| Initialize session B with identical headers | Start process B |
| Tool call with A's session ID | Process A |
| Tool call with B's session ID | Process B |
| Reconnect SSE with A's session ID | Process A |
| Delete session A | Terminate A; B continues |

## Initialization and routing

The bridge validates the configured header environment and reserves session capacity before starting a child. It forwards the initializing client's protocol version and client info. The child receives one initialization and one initialized notification; the HTTP client's later initialized notification is acknowledged without repeating it upstream.

Server-initiated requests such as sampling, roots and elicitation are not bridged back to the HTTP client. The bridge advertises no client capabilities to the child for those interactions. Server notifications, cancellation and progress notifications retain their existing supported paths.

Every later request checks the owning identity configured in [security and deployment](security.md). Repeated tenant headers must match the process environment. Notifications are sent only to streams belonging to that process's session. No raw credential is used as the process registry key.

## Lifetime and cleanup

Closing or reconnecting an HTTP/SSE connection does not destroy the session. The child and its in-memory state remain available until one of these events:

- An authorized `DELETE /mcp/{serverName}` returns 204 after terminating that session's child and streams.
- Idle expiry runs after `MCP_WRAPPER_IDLE_MINUTES` (15 minutes by default, checked once per minute).
- The child exits or the bridge shuts down.

Set `MCP_WRAPPER_IDLE_MINUTES=0` to disable idle expiry. Process and session limits remain in effect; a full bridge returns 503 instead of reusing another session's process or evicting an active one. Busy requests prevent idle eviction, and the idle clock restarts at completion.

Failed initialization releases its session and process capacity. A stale ID receives 404, including when attached to another initialize request. The client must initialize without that ID to create fresh state. The bridge never reconstructs a dead process under an existing session ID.

State lives in the stdio process. It survives transport reconnections while that process is alive, but it does not survive bridge restarts, process crashes or expiry. Persistent files belong in the MCP server's own storage, with permissions and directories chosen for the required user/session isolation.
