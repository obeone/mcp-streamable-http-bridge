/**
 * Uses @modelcontextprotocol/sdk StreamableHTTPClientTransport against the live bridge.
 * Run from repo root while `npm start` is up on port 8080.
 */
const sdkRoot =
  'C:/Users/Eladb/AppData/Local/npm-cache/_npx/df0de4b47e60567b/node_modules/@modelcontextprotocol/sdk/dist/esm';

const { Client } = await import(`file:///${sdkRoot}/client/index.js`);
const { StreamableHTTPClientTransport } = await import(
  `file:///${sdkRoot}/client/streamableHttp.js`
);

const url = process.argv[2] ?? 'http://127.0.0.1:8080/mcp/weather';

const transport = new StreamableHTTPClientTransport(new URL(url));
const client = new Client({ name: 'sdk-handshake-test', version: '1.0.0' });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  console.log('connected, tools:', tools.tools.map((t) => t.name).join(', '));
  await client.close();
  console.log('OK');
} catch (e) {
  console.error('FAILED:', e.message);
  process.exit(1);
}
