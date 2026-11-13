import crypto from 'node:crypto';

export class SessionStore {
  constructor() {
    /** @type {Map<string, { sessionId: string, serverName: string, instanceKey: string, createdAt: number, lastUsedAt: number }>} */
    this.sessions = new Map();
    /** @type {Map<string, Set<string>>} instanceKey -> sessionIds */
    this.sessionsByInstance = new Map();
  }

  create(serverName, instanceKey) {
    const sessionId = crypto.randomUUID();
    const now = Date.now();
    const record = { sessionId, serverName, instanceKey, createdAt: now, lastUsedAt: now };
    this.sessions.set(sessionId, record);

    if (!this.sessionsByInstance.has(instanceKey)) {
      this.sessionsByInstance.set(instanceKey, new Set());
    }
    this.sessionsByInstance.get(instanceKey).add(sessionId);
    return sessionId;
  }

  /** @param {string} sessionId */
  get(sessionId) {
    return this.sessions.get(sessionId);
  }

  touch(sessionId) {
    const s = this.sessions.get(sessionId);
    if (s) s.lastUsedAt = Date.now();
  }

  /** @param {string} instanceKey */
  invalidateByInstanceKey(instanceKey) {
    const ids = this.sessionsByInstance.get(instanceKey);
    if (!ids) return;
    for (const id of ids) {
      this.sessions.delete(id);
    }
    this.sessionsByInstance.delete(instanceKey);
  }

  delete(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    const set = this.sessionsByInstance.get(s.instanceKey);
    set?.delete(sessionId);
    if (set?.size === 0) this.sessionsByInstance.delete(s.instanceKey);
  }
}
