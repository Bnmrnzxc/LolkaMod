import { mountPanel } from "./panel";
import { PluginManager } from "./lifecycle";
import { ModuleRegistry } from "./modules";
import { installStreamDiagnostics } from "./stream-diagnostics";
import { DEFAULT_SETTINGS, VERSION, validateSettings, type Settings } from "../shared/settings";
import { createThemeController } from "./theme-manager";
import { createStreamIndicator } from "./stream-indicator";
import { createMiniPlayer } from "./mini-player";
import { mountStreamMenu, type HostStreamControls, type StreamMenuProps } from "./stream-menu";
import type { FeatureSettingsOptions } from "./feature-settings";
import type { UpdateStatus } from "../shared/updates";

interface Bridge {
  readSettings(): Settings;
  writeSettings(settings: Settings): Promise<Settings>;
  diagnostics(): Record<string, unknown>;
  resetSettings(): Promise<Settings>;
  checkUpdates(): Promise<UpdateStatus>;
  openRelease(): Promise<void>;
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
      mountSettings(container: HTMLElement): () => void;
      mountStreamMenu(container: HTMLElement, props: StreamMenuProps): () => void;
      openMini(id: string): Promise<void>;
      checkUpdates(): Promise<UpdateStatus>;
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
  let theme: ReturnType<typeof createThemeController> | undefined;
  let indicator: ReturnType<typeof createStreamIndicator> | undefined;
  let mini: ReturnType<typeof createMiniPlayer> | undefined;
  let ownedHostPip: string | undefined;
  let updateStatus:UpdateStatus={state:"idle",installed:VERSION};
  const listeners=new Set<()=>void>();
  const slots=new Map<HTMLElement,{kind:"settings"|"stream";props?:StreamMenuProps;dispose?:()=>void}>();
  function notify(){for(const listener of listeners)try{listener();}catch{/* Isolate UI listeners. */}}
  function hostControls(){return modules.get<HostStreamControls>("StreamControls");}
  function closeMini(){
    if(ownedHostPip){hostControls()?.closePip(ownedHostPip);ownedHostPip=undefined;}
    void mini?.close();
  }
  async function openMini(id:string){
    if(!running||!settings.miniPlayerEnabled)throw new Error("Мини-плеер выключен");
    const host=hostControls(), item=host?.videos().find(v=>v.id===id);
    if(!host||!item)throw new Error("Видео недоступно");
    if(host.nativePip()){
      // Host native PiP owns stream binding, ended cleanup, and desktop window lifecycle.
      const request=host.pip(id);ownedHostPip=id;await request;
    }else{
      const request=mini?.open(item.video);if(!(await request)?.ok)throw new Error("Мини-плеер недоступен");
    }
  }
  async function checkUpdates(){updateStatus={state:"checking",installed:VERSION};notify();try{updateStatus=await native.checkUpdates();}catch{updateStatus={state:"error",installed:VERSION,message:"Не удалось проверить обновления."};}notify();return {...updateStatus};}
  const features:FeatureSettingsOptions={
    settings:()=>validateSettings(settings),save:saveSettings,
    subscribe:callback=>{listeners.add(callback);return()=>{listeners.delete(callback);};},
    reset:async()=>{await saveQueue;settings=validateSettings(await native.resetSettings());persistenceError=false;applyFeatures();notify();},
    checkUpdates,updateStatus:()=>({...updateStatus}),openRelease:()=>native.openRelease(),
    capabilities:()=>({settings:!!modules.get("HostSettings"),controls:!!hostControls(),pip:hostControls()?.pipAvailable()??Boolean(document.pictureInPictureEnabled)}),
  };
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
  plugins.register({id:"ClientFeatures",start(scope){
    scope.add(()=>{closeMini();theme?.stop();indicator?.stop();mini?.stop();theme=undefined;indicator=undefined;mini=undefined;});
    theme=createThemeController();theme.apply(settings.themeId);
    indicator=createStreamIndicator({enabled:settings.indicatorEnabled,detailed:settings.indicatorDetailed});
    mini=createMiniPlayer();
    const timer=setInterval(()=>{refreshIndicator();notify();},2000);
    scope.add(()=>{clearInterval(timer);});
  }});
  function applyFeatures(){
    if(!running)return;
    theme?.apply(settings.themeId);
    indicator?.setEnabled(settings.indicatorEnabled);indicator?.setDetailed(settings.indicatorDetailed);
    if(!settings.miniPlayerEnabled)closeMini();
    applyCss();
  }
  function refreshIndicator(){
    const snapshot=media?.snapshot();
    if(snapshot)indicator?.update({...snapshot,nativeActive:!!hostControls()?.active()});
  }
  function applyCss() {
    plugins.stop("CustomCSS");
    if (running && settings.enabled) plugins.start("CustomCSS");
  }
  function diagnostics() {
    return { version: VERSION, ready: running, plugins: plugins.status(), persistenceError,
      desktop: native.diagnostics(), modules: modules.diagnostics(),
      nativeQuality: !!modules.get<{nativeQuality:boolean}>("ScreenShareSettings")?.nativeQuality,
      features:features.capabilities(),update:{...updateStatus},mini:mini?.state(),
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
      applyFeatures();notify();
    });
    saveQueue = operation.catch(() => { persistenceError = true; });
    return operation;
  }
  function mountUI() {
    if (!running || panelDispose || !document.body) return;
    plugins.start("ClientFeatures");
    applyFeatures();
    panelDispose = mountPanel({ version: VERSION, settings, showLauncher: false,
      features,onChange: patch => saveSettings(patch), diagnostics });
    api.ready = true;
  }
  function start() {
    if (running) return;
    running = true;
    plugins.start("StreamDiagnostics");
    for(const [container,slot]of slots)renderSlot(container,slot);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountUI, {once:true});
    else mountUI();
  }
  function stop() {
    document.removeEventListener("DOMContentLoaded", mountUI);
    panelDispose?.(); panelDispose = undefined;
    for(const slot of slots.values()){slot.dispose?.();slot.dispose=undefined;}
    plugins.stopAll(); running = false; api.ready = false;
  }
  function renderSlot(container:HTMLElement,slot:{kind:"settings"|"stream";props?:StreamMenuProps;dispose?:()=>void}){
    if(!running||!container)return;
    slot.dispose?.();
    slot.dispose=slot.kind==="settings"?mountPanel({version:VERSION,settings,container,features,onChange:patch=>saveSettings(patch),diagnostics}):mountStreamMenu(container,slot.props!,{features,adapter:hostControls,openMini});
  }
  function mountSlot(container:HTMLElement,kind:"settings"|"stream",props?:StreamMenuProps){
    if(!container)return()=>{};
    const prior=slots.get(container);prior?.dispose?.();
    const slot={kind,props,dispose:undefined as (()=>void)|undefined};slots.set(container,slot);renderSlot(container,slot);
    return()=>{slot.dispose?.();if(slots.get(container)===slot)slots.delete(container);};
  }
  const api = { version: VERSION, bootAt: performance.now(), ready: false, modules, start, stop,
    mountSettings:(container:HTMLElement)=>mountSlot(container,"settings"),
    mountStreamMenu:(container:HTMLElement,props:StreamMenuProps)=>mountSlot(container,"stream",props),openMini,checkUpdates,
    settings: () => validateSettings(settings), saveSettings, diagnostics,
    streams: { sample: async () => { await media?.sample();refreshIndicator(); }, snapshot: () => ({diagnostics:media?.snapshot(),indicator:indicator?.model(),
      native: modules.get<{snapshot():unknown;active():unknown}>("ScreenShareSettings")?.snapshot(),
      active: modules.get<{active():unknown}>("ScreenShareSettings")?.active()}) } };
  window.LolkaMod = api;
  start();
}
