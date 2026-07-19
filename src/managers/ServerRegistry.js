/**
 * @typedef {import('./ServerDefinition.js').ServerDefinition} ServerDefinition
 */

export class ServerRegistry {
  /** @param {ServerDefinition[]} definitions */
  constructor(definitions) {
    /** @type {Map<string, ServerDefinition>} */
    this.byName = new Map(definitions.map((d) => [d.name, d]));
  }
  /** @param {string} name */
  get(name) {
    return this.byName.get(name);
  }

  names() {
    return [...this.byName.keys()];
  }

  size() {
    return this.byName.size;
  }
}
