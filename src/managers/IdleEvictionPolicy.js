export class IdleEvictionPolicy {
  idleMs() {
    const minutes = Number(process.env.MCP_WRAPPER_IDLE_MINUTES ?? '15');
    if (minutes === 0) return Infinity;
    if (!Number.isFinite(minutes) || minutes < 0) {
      return 15 * 60 * 1000;
    }
    return minutes * 60 * 1000;
  }
}
