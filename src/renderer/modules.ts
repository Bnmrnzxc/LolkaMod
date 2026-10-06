export class ModuleRegistry {
  private references = new Map<string, { reference: unknown; sourceHash: string }>();
  register(name: string, reference: unknown, sourceHash: string) {
    const required = name === "ScreenShareSettings" || name === "SoundEffects" ? "snapshot" : name === "HostSettings" ? "open" : name === "StreamControls" ? "active" : undefined;
    if (!required || typeof (reference as any)?.[required] !== "function") return;
    if (name === "SoundEffects" && ["overlay", "clear", "preview"].some(key => typeof (reference as any)?.[key] !== "function")) return;
    this.references.set(name, { reference, sourceHash });
  }
  get<T>(name: string): T | undefined { return this.references.get(name)?.reference as T | undefined; }
  diagnostics() { return [...this.references].map(([name, value]) => ({ name, sourceHash: value.sourceHash })); }
}
