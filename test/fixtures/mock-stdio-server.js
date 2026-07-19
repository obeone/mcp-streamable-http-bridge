#!/usr/bin/env node
/**
 * Minimal MCP stdio server for integration tests (newline-delimited JSON).
 */
import process from 'node:process';

let buffer = '';

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  processMessages();
});

function processMessages() {
  while (true) {
    const newline = buffer.indexOf('\n');
    if (newline === -1) return;
    let line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.endsWith('\r')) {
      line = line.slice(0, -1);
    }
    if (!line.trim()) continue;
    handleMessage(JSON.parse(line));
  }
}

function writeMessage(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
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
