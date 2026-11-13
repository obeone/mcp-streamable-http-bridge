/**
 * @typedef {import('../types.js').ServerResponse} ServerResponse
 */

/** @param {ServerResponse} res */
export function initSseResponse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
}

/**
 * @param {ServerResponse} res
 * @param {object} data
 */
export function writeSseJson(res, data) {
  return res.write(`event: message\ndata: ${JSON.stringify(data)}\n\n`);
}
