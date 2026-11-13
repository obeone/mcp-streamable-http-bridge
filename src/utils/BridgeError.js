/** HTTP-safe operational failure without upstream credential-bearing details. */
export class BridgeError extends Error {
  /** @param {number} statusCode HTTP status. @param {string} message Public message. @returns {BridgeError} */
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}
