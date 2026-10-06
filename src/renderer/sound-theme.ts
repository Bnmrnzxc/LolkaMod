import { SOUND_ACTIONS, type SoundActionId, type SoundEffects, type SoundPack, type SoundThemeStatus } from "../shared/sounds";
import type { SoundPackDownloadStatus } from "../main/sound-pack-service";

interface SoundAsset { key: string; bytes: number; sha256: string; mimeType: "audio/mpeg" }
interface SoundThemeOptions {
  adapter(): SoundEffects | undefined;
  load(): Promise<SoundPack>;
  assets: readonly SoundAsset[];
  mapping: Partial<Record<SoundActionId, string>>;
  change(): void;
  downloadStatus?(): SoundPackDownloadStatus;
}

export function createSoundThemeController(options: SoundThemeOptions) {
  let desired = false, stopped = false, attempted = false, generation = 0;
  let adapter: SoundEffects | undefined;
  let urls: string[] = [];
  let model: SoundThemeStatus = { state: "off", available: false, mapped: 0, total: SOUND_ACTIONS.length, message: "" };
  function set(state: SoundThemeStatus["state"], message: string, mapped = 0) {
    model = { state, message, mapped, total: SOUND_ACTIONS.length, available: !!options.adapter() };
    options.change();
  }
  function revoke(values: string[]) { for (const url of values) URL.revokeObjectURL(url); }
  function clear() {
    ++generation;
    try { adapter?.clear(); } catch { /* Unsupported host cleanup cannot stop Lolka. */ }
    revoke(urls); urls = [];
  }
  async function activate(host: SoundEffects, request: number) {
    const created: string[] = [];
    let stage: "load" | "verify" | "overlay" = "load";
    try {
      const pack = await options.load();
      if (stopped || !desired || request !== generation) return;
      stage = "verify";
      if (!pack || pack.id !== "discord" || !Array.isArray(pack.assets) || pack.assets.length !== options.assets.length)
        throw new Error("Invalid sound pack");
      const byKey = new Map<string, string>();
      for (const spec of options.assets) {
        const matches = pack.assets.filter(item => item?.key === spec.key);
        if (matches.length !== 1) throw new Error("Missing sound asset");
        const item = matches[0]!;
        if (item.mimeType !== spec.mimeType || typeof item.base64 !== "string" ||
            item.base64.length > Math.ceil(spec.bytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.base64))
          throw new Error("Invalid sound bytes");
        const raw = atob(item.base64);
        if (raw.length !== spec.bytes) throw new Error("Invalid sound size");
        const bytes = Uint8Array.from(raw, character => character.charCodeAt(0));
        const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
        if (digest !== spec.sha256) throw new Error("Invalid sound checksum");
        if (stopped || !desired || request !== generation) return;
        const url = URL.createObjectURL(new Blob([bytes], { type: spec.mimeType }));
        created.push(url); byKey.set(spec.key, url);
      }
      const resources: Partial<Record<SoundActionId, string>> = {};
      const actions = new Set(host.snapshot().actions.map(item => item.id));
      for (const action of SOUND_ACTIONS) {
        const key = options.mapping[action.id], url = key && byKey.get(key);
        if (url && actions.has(action.id)) resources[action.id] = url;
      }
      if (Object.keys(resources).length !== SOUND_ACTIONS.length) throw new Error("Incomplete sound mapping");
      stage = "overlay";
      await host.overlay(resources);
      if (stopped || !desired || request !== generation) return;
      revoke(urls); urls = created.splice(0);
      set("active", "Звуки Discord включены.", Object.keys(resources).length);
    } catch {
      if (!stopped && desired && request === generation) {
        try { host.clear(); } catch { /* Keep the original sounds usable. */ }
        let download: SoundPackDownloadStatus | undefined;
        try { download = options.downloadStatus?.(); } catch { /* The safe fallback still explains the stage. */ }
        const detail = stage === "verify" ? "Набор звуков не прошёл проверку целостности."
          : stage === "overlay" ? "Lolka не смогла воспроизвести звуки."
          : ["checksum", "size", "type", "format"].includes(download?.code ?? "") ? "Встроенный набор звуков повреждён. Переустанови LolkaMod."
          : "Не удалось открыть встроенный набор звуков. Переустанови LolkaMod.";
        model = { state: "error", available: !!options.adapter(), mapped: 0, total: SOUND_ACTIONS.length,
          message: `${detail} Выключи и снова включи тумблер, чтобы повторить.`, errorStage: stage,
          errorCode: stage === "load" ? download?.code ?? "unknown" : stage };
        options.change();
      }
    } finally { revoke(created); }
  }
  function refresh() {
    if (stopped) return;
    const next = desired ? options.adapter() : undefined;
    if (next !== adapter) { clear(); adapter = next; attempted = false; }
    if (!desired) { if (model.state !== "off" || model.available !== !!options.adapter()) set("off", ""); return; }
    if (!adapter) { if (model.state !== "waiting") set("waiting", "Звуковой модуль недоступен в этой сборке Lolka."); return; }
    if (!attempted) {
      attempted = true;
      const request = ++generation;
      set("loading", "Подготовка звуков Discord…");
      void activate(adapter, request);
    }
  }
  return {
    apply(enabled: boolean) { if (stopped) return; if (desired !== enabled) { desired = enabled; attempted = false; } refresh(); },
    refresh,
    status(): SoundThemeStatus { return { ...model }; },
    preview(id: SoundActionId, volume = 0.5) {
      if (stopped || model.state !== "active" || !adapter) throw new Error("Sound theme is not active");
      adapter.preview(id, volume);
    },
    stop() { if (stopped) return; stopped = true; clear(); adapter = undefined; },
  };
}
