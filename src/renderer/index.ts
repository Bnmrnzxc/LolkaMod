import { mountPanel } from "./panel";
import { PluginManager } from "./lifecycle";
import { ModuleRegistry } from "./modules";
import { installStreamDiagnostics } from "./stream-diagnostics";
import { DEFAULT_SETTINGS, VERSION, validateSettings, type Settings } from "../shared/settings";

interface Bridge {
  readSettings(): Settings;
  writeSettings(settings: Settings): Promise<Settings>;
  diagnostics(): Record<string, unknown>;
}
declare global {
  interface Window {
    LolkaModNative?: Bridge;
    LolkaMod?: {
      version: string;
      bootAt: number;
      ready: boolean;
      modules: ModuleRegistry;
      stop(): void;
      start(): void;
      settings(): Settings;
      saveSettings(patch: Partial<Settings>): Promise<void>;
      diagnostics(): Record<string, unknown>;
      streams: { sample(): Promise<void>; snapshot(): unknown };
    };
  }
}

if (location.origin === "https://lolka.app" && window === window.top && window.LolkaModNative) {
  window.LolkaMod?.stop();
  const native = window.LolkaModNative;
  let settings = validateSettings(DEFAULT_SETTINGS);
  try { settings = validateSettings(native.readSettings()); } catch { /* Corrupt file cannot break host startup. */ }
  const plugins = new PluginManager();
  const modules = new ModuleRegistry();
  let panelDispose: (() => void) | undefined;
  let running = false;
  let persistenceError = false;
  let saveQueue = Promise.resolve();
  let media: ReturnType<typeof installStreamDiagnostics> | undefined;
  plugins.register({ id: "StreamDiagnostics", start(scope) {
    const collector = installStreamDiagnostics(); media = collector;
    scope.add(() => { collector.stop(); if (media === collector) media = undefined; });
  }});
  plugins.register({ id: "CustomCSS", start(scope) {
    const style = document.createElement("style");
    style.id = "lolkamod-custom-css";
    style.textContent = settings.customCss;
    document.documentElement.append(style);
    scope.add(() => style.remove());
  }});
  function applyCss() {
    plugins.stop("CustomCSS");
    if (running && settings.enabled) plugins.start("CustomCSS");
  }
  function diagnostics() {
    return { version: VERSION, ready: running, plugins: plugins.status(), persistenceError,
      desktop: native.diagnostics(), modules: modules.diagnostics(),
      nativeQuality: !!modules.get<{nativeQuality:boolean}>("ScreenShareSettings")?.nativeQuality,
      streams: media?.snapshot(), stream1440p: "not-verified" };
  }
  async function saveSettings(patch: Partial<Settings>) {
    validateSettings({ ...settings, ...patch });
    // Serialize writes; a slow earlier save must not overwrite the most recent settings.
    const operation = saveQueue.then(async () => {
      const next = validateSettings({ ...settings, ...patch });
      const saved = await native.writeSettings(next);
      settings = validateSettings(saved);
      // Legacy 0.2 profile fields remain readable, but native selections govern media.
      persistenceError = false;
      applyCss();
    });
    saveQueue = operation.catch(() => { persistenceError = true; });
    return operation;
  }
  function mountUI() {
    if (!running || panelDispose || !document.body) return;
    applyCss();
    panelDispose = mountPanel({ version: VERSION, settings, showLauncher: false,
      onChange: patch => saveSettings(patch), diagnostics });
    api.ready = true;
  }
  function start() {
    if (running) return;
    running = true;
    plugins.start("StreamDiagnostics");
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountUI, {once:true});
    else mountUI();
  }
  function stop() {
    document.removeEventListener("DOMContentLoaded", mountUI);
    panelDispose?.(); panelDispose = undefined;
    plugins.stopAll(); running = false; api.ready = false;
  }
  const api = { version: VERSION, bootAt: performance.now(), ready: false, modules, start, stop,
    settings: () => validateSettings(settings), saveSettings, diagnostics,
    streams: { sample: async () => { await media?.sample(); }, snapshot: () => ({diagnostics:media?.snapshot(),
      native: modules.get<{snapshot():unknown;active():unknown}>("ScreenShareSettings")?.snapshot(),
      active: modules.get<{active():unknown}>("ScreenShareSettings")?.active()}) } };
  window.LolkaMod = api;
  start();
}
