#!/usr/bin/env node
/**
 * Minimal MCP stdio server for integration tests (Content-Length framing).
 */
import process from 'node:process';

let buffer = '';

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  processMessages();
});

function processMessages() {
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;
    const headerText = buffer.slice(0, headerEnd);
    const match = headerText.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }
    const len = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + len) return;
    const body = buffer.slice(bodyStart, bodyStart + len);
    buffer = buffer.slice(bodyStart + len);
    handleMessage(JSON.parse(body));
  }
}

function writeMessage(msg) {
  const body = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`;
  process.stdout.write(header + body);
}

function handleMessage(msg) {
  if (msg.method === 'initialize') {
    writeMessage({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-mcp', version: '1.0.0' },
      },
    });
    return;
  }

  if (msg.method === 'tools/list') {
    writeMessage({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [
          {
            name: 'echo',
            description: 'Echo tool',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
          },
        ],
      },
    });
    return;
  }

  if (msg.method === 'notifications/initialized') {
    return;
  }

  writeMessage({
    jsonrpc: '2.0',
    id: msg.id,
    error: { code: -32601, message: `Method not found: ${msg.method}` },
  });
}
