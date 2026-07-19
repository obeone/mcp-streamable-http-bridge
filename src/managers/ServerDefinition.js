export class ServerDefinition {
  /**
   * @param {object} params
   * @param {string} params.name
   * @param {string} params.command
   * @param {string[]} params.args
   * @param {string[]} params.envKeys
   * @param {Record<string, string>} params.staticEnv
   */
  constructor({ name, command, args, envKeys, staticEnv }) {
    this.name = name;
    this.command = command;
    this.args = args;
    this.envKeys = envKeys;
    this.staticEnv = staticEnv;
  }

  /**
   * @param {string} name
   * @param {object} raw
   * @param {string} raw.command
   * @param {string[]} [raw.args]
   * @param {Record<string, string>} [raw.env]
   */
  static fromConfigEntry(name, raw) {
    if (!raw || typeof raw.command !== 'string' || !raw.command.trim()) {
      throw new Error(`Server "${name}": "command" must be a non-empty string`);
    }
    const args = Array.isArray(raw.args) ? raw.args.map(String) : [];
    const env = raw.env && typeof raw.env === 'object' ? raw.env : {};
    const envKeys = Object.keys(env);
    /** @type {Record<string, string>} */
    const staticEnv = {};
    for (const key of envKeys) {
      const v = env[key];
      staticEnv[key] = v === undefined || v === null ? '' : String(v);
    }
    return new ServerDefinition({
      name,
      command: raw.command,
      args,
      envKeys,
      staticEnv,
    });
  }
}
