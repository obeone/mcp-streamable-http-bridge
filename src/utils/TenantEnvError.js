export class TenantEnvError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'TenantEnvError';
    this.statusCode = 401;
  }
}
