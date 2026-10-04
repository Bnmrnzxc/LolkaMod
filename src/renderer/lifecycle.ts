export class Scope {
  private cleanups: Array<() => void> = [];
  private closed = false;
  add(cleanup: () => void) {
    if (this.closed) cleanup(); else this.cleanups.push(cleanup);
    return cleanup;
  }
  dispose() {
    if (this.closed) return;
    this.closed = true;
    for (const cleanup of this.cleanups.reverse()) {
      try { cleanup(); } catch { /* Remaining resources still need disposal. */ }
    }
    this.cleanups = [];
  }
  get size() { return this.cleanups.length; }
}

export interface Plugin {
  id: string;
  start(scope: Scope): void;
}

export class PluginManager {
  private definitions = new Map<string, Plugin>();
  private active = new Map<string, Scope>();
  private failures = new Set<string>();
  register(plugin: Plugin) {
    if (this.definitions.has(plugin.id)) throw new Error("Duplicate plugin id");
    this.definitions.set(plugin.id, plugin);
  }
  start(id: string) {
    if (this.active.has(id)) return;
    const plugin = this.definitions.get(id);
    if (!plugin) throw new Error("Unknown plugin");
    const scope = new Scope();
    try {
      plugin.start(scope);
      this.active.set(id, scope);
      this.failures.delete(id);
    } catch {
      scope.dispose();
      this.failures.add(id);
    }
  }
  stop(id: string) { this.active.get(id)?.dispose(); this.active.delete(id); }
  stopAll() { for (const id of [...this.active.keys()].reverse()) this.stop(id); }
  status() { return { registered: [...this.definitions.keys()], active: [...this.active.keys()], failed: [...this.failures] }; }
}
