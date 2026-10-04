export class ModuleRegistry {
  private references = new Map<string, { reference: unknown; sourceHash: string }>();
  register(name: string, reference: unknown, sourceHash: string) {
    if (name !== "ScreenShareSettings" || typeof (reference as any)?.snapshot !== "function") return;
    this.references.set(name, { reference, sourceHash });
  }
  get<T>(name: string): T | undefined { return this.references.get(name)?.reference as T | undefined; }
  diagnostics() { return [...this.references].map(([name, value]) => ({ name, sourceHash: value.sourceHash })); }
}
