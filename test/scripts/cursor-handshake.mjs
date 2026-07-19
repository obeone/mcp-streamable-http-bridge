/**
 * Simulates Cursor Streamable HTTP MCP client against /mcp/weather.
 */
const base = process.argv[2] ?? 'http://127.0.0.1:8080/mcp/weather';

const headers = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

async function post(body, sessionId) {
  const h = { ...headers };
  if (sessionId) h['mcp-session-id'] = sessionId;
  const res = await fetch(base, { method: 'POST', headers: h, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, sessionId: res.headers.get('mcp-session-id') ?? sessionId, text };
}

async function main() {
  console.log('Target:', base);

  const init = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'cursor-handshake-test', version: '1.0.0' },
    },
  });
  console.log('1 initialize', init.status, init.text.slice(0, 200));
  if (init.status !== 200) process.exit(1);

  const sid = init.sessionId;
  if (!sid) {
    console.error('No mcp-session-id on initialize');
    process.exit(1);
  }

  const notif = await post({ jsonrpc: '2.0', id: 0, method: 'notifications/initialized' }, sid);
  console.log('2 notifications/initialized (id:0)', notif.status, notif.text || '(empty)');

  const notif2 = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sid);
  console.log('3 notifications/initialized (no id)', notif2.status, notif2.text || '(empty)');

  const tools = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sid);
  console.log('4 tools/list', tools.status, tools.text.slice(0, 300));

  const sseRes = await fetch(base, {
    method: 'GET',
    headers: { Accept: 'text/event-stream', 'mcp-session-id': sid },
  });
  console.log('5 GET SSE', sseRes.status, sseRes.headers.get('content-type'));
  sseRes.body?.cancel();

  if (notif.status !== 202 || tools.status !== 200) {
    process.exit(1);
  }
  const toolsBody = JSON.parse(tools.text);
  console.log('tools count', toolsBody.result?.tools?.length ?? 0);
  console.log('OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
