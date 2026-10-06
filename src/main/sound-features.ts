import { optionalContracts, validateModule } from "./compatible-quality";

const actionTable = '$a={voiceJoin:"/sounds/space/voice_join_2.mp3",voiceLeave:"/sounds/space/voice_leave_2.mp3",userLeave:"/sounds/space/voice_another_leave_2.mp3",mute:"/sounds/space/mute_3.mp3",unmute:"/sounds/space/unmute_3.mp3",soundDisable:"/sounds/space/sound_disable_3.mp3",soundEnable:"/sounds/space/sound_enable_2.mp3",cameraDisable:"/sounds/space/camera_disable.mp3",cameraEnable:"/sounds/space/camera_enable.mp3",radioActivation:"/sounds/space/radio_activation.mp3",radioDeactivation:"/sounds/space/radio_deactivation.mp3",messageSound:"/sounds/space/message.mp3",outgoingCall:"/sounds/space/outcoming_call_3.mp3",incomingCall:"/sounds/space/incoming_call_3.mp3",screenShareStarted:"/sounds/space/screenshare_started.mp3",screenShareStopped:"/sounds/space/screenshare_stopped_2.mp3"}';

const soundSpecs = [
  { find: actionTable },
  { find: 'class spt{sounds=new Map;soundUrls=new Map;objectUrls=new Map;preloaded=!1;throttledPlayers=new Map;playingLoopSounds=new Map;previewAudio=null;' },
  { find: 'const Hl=new spt;typeof window<"u"&&(Hl.preloadSounds(),window.addEventListener("speakerChanged"' },
  { find: 'const Qh=e=>Sg.getState().isSoundEnabled(e)' },
  { find: 'play(t,n=.5,r=!1){const o=this.sounds.get(t);if(!o){console.warn(`Sound not found: ${t}`);return}try{' },
  { find: 'playThrottled(t,n=.5,r=100){if(!this.throttledPlayers.has(t)){const a=y2e(()=>{this.play(t,n)},r);' },
  { find: 'preview(t,n=.5,r){this.stopPreview();const o=this.soundUrls.get(t)||t,a=new Audio(o);a.volume=n;const l=this.getCurrentOutputDevice();' },
  { find: 'stopPreview(){this.previewAudio&&(this.previewAudio.pause(),this.previewAudio=null)}' },
  { find: 'stop(t){const n=this.playingLoopSounds.get(t);if(n){n.pause(),n.currentTime=0,this.playingLoopSounds.delete(t);return}' },
];

const reference = `
;(() => {
  const __lmSoundActions = $a;
  const __lmSoundManager = Hl;
  const __lmSoundEnabled = Qh;
  const __lmSoundStore = Sg;
  const __lmSoundIds = Object.freeze(Object.keys(__lmSoundActions));
  const __lmSoundPaths = new Map(__lmSoundIds.map(id => [__lmSoundActions[id], id]));
  const __lmSoundPrepared = new Map();
  const __lmSoundCancelLoads = new Set();
  let __lmSoundGeneration = 0;
  let __lmSoundActive = false;
  let __lmSoundOriginals;

  function __lmSoundDispose(audio) {
    try { audio.pause(); audio.removeAttribute("src"); audio.load(); } catch {}
  }
  function __lmSoundLoad(url, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const audio = new Audio();
      audio.preload = "auto";
      let settled = false;
      let cancel = () => {};
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        audio.removeEventListener("canplaythrough", ready);
        audio.removeEventListener("error", failed);
        __lmSoundCancelLoads.delete(cancel);
        if (error) { __lmSoundDispose(audio); reject(error); }
        else resolve(audio);
      };
      const ready = () => finish();
      const failed = () => finish(new Error("Sound asset could not be decoded"));
      cancel = () => finish(new Error("Sound overlay request was superseded"));
      __lmSoundCancelLoads.add(cancel);
      const timer = setTimeout(() => finish(new Error("Sound asset loading timed out")), timeoutMs);
      audio.addEventListener("canplaythrough", ready, { once: true });
      audio.addEventListener("error", failed, { once: true });
      const device = __lmSoundManager.getCurrentOutputDevice();
      if (typeof audio.setSinkId === "function") audio.setSinkId(device).catch(() => {});
      audio.src = url;
      audio.load();
    });
  }
  function __lmSoundTemporaryMaps(receiver, original, args) {
    const key = args[0], id = __lmSoundPaths.get(key), item = id && __lmSoundPrepared.get(id);
    if (!__lmSoundActive || !item || receiver !== __lmSoundManager) return original.apply(receiver, args);
    const sounds = receiver.sounds, soundUrls = receiver.soundUrls;
    const overlaySounds = new Map(sounds), overlayUrls = new Map(soundUrls);
    overlaySounds.set(key, item.audio); overlayUrls.set(key, item.url);
    receiver.sounds = overlaySounds; receiver.soundUrls = overlayUrls;
    try {
      const device = receiver.getCurrentOutputDevice();
      if (typeof item.audio.setSinkId === "function") item.audio.setSinkId(device).catch(() => {});
      return original.apply(receiver, args);
    } finally {
      receiver.sounds = sounds; receiver.soundUrls = soundUrls;
    }
  }
  function __lmSoundInstall() {
    const names = ["play", "preview"];
    if (!Object.isExtensible(__lmSoundManager)) throw new Error("Sound manager cannot be wrapped");
    const descriptors = names.map(name => {
      const own = Object.getOwnPropertyDescriptor(__lmSoundManager, name);
      const original = __lmSoundManager[name];
      let holder = __lmSoundManager;
      while (holder && !Object.getOwnPropertyDescriptor(holder, name)) holder = Object.getPrototypeOf(holder);
      const descriptor = holder && Object.getOwnPropertyDescriptor(holder, name);
      if (typeof original !== "function" ||
          (own ? own.writable === false && typeof own.set !== "function" :
            !descriptor || descriptor.writable === false && typeof descriptor.set !== "function"))
        throw new Error("Sound manager playback API changed");
      return { name, own, original };
    });
    const installed = [];
    try {
      for (const entry of descriptors) {
        const { name, own, original } = entry;
        const wrapped = function(...args) { return __lmSoundTemporaryMaps(this, original, args); };
        __lmSoundManager[name] = wrapped;
        if (__lmSoundManager[name] !== wrapped) throw new Error("Sound manager method could not be wrapped");
        installed.push({ name, own, wrapped });
      }
    } catch (error) {
      for (const { name, own } of installed.reverse()) {
        if (own) Object.defineProperty(__lmSoundManager, name, own);
        else delete __lmSoundManager[name];
      }
      throw error;
    }
    return () => {
      for (const { name, own, wrapped } of installed) {
        if (__lmSoundManager[name] !== wrapped) continue;
        if (own) Object.defineProperty(__lmSoundManager, name, own);
        else delete __lmSoundManager[name];
      }
    };
  }
  function __lmSoundStopOwnedPreview(items) {
    const preview = __lmSoundManager.previewAudio;
    if (preview && items.some(item => item.url === preview.src)) {
      try { __lmSoundManager.stopPreview(); } catch {}
    }
  }
  function __lmSoundRestartLoops(loops) {
    for (const item of loops) {
      try {
        __lmSoundManager.stop(item.path);
        __lmSoundManager.play(item.path, item.volume, item.loop);
      } catch {}
    }
  }
  function __lmSoundActiveLoops() {
    const loops = [];
    for (const [path, audio] of __lmSoundManager.playingLoopSounds) {
      if (__lmSoundPaths.has(path) && audio && !audio.paused)
        loops.push({ path, volume: audio.volume, loop: audio.loop });
    }
    return loops;
  }
  function __lmSoundCancelPending() {
    for (const cancel of [...__lmSoundCancelLoads]) cancel();
  }
  function __lmSoundValidate(resources) {
    const proto = resources && typeof resources === "object" ? Object.getPrototypeOf(resources) : undefined;
    const constructorValue = proto && Object.getOwnPropertyDescriptor(proto, "constructor")?.value;
    if (!resources || typeof resources !== "object" || Array.isArray(resources) ||
        (proto !== null && (Object.getPrototypeOf(proto) !== null || typeof constructorValue !== "function" || constructorValue.name !== "Object")))
      throw new Error("Invalid sound overlay");
    const origin = globalThis.location?.origin;
    const entries = Object.entries(resources);
    for (const [id, value] of entries) {
      if (!__lmSoundIds.includes(id)) throw new Error("Unknown sound action");
      if (typeof value !== "string") throw new Error("Invalid sound URL");
      const parsed = new URL(value);
      if (parsed.protocol !== "blob:" || !origin || parsed.origin !== origin)
        throw new Error("Sound assets must be local blobs from this app");
    }
    return entries;
  }
  async function __lmSoundOverlay(resources) {
    const entries = __lmSoundValidate(resources);
    if (entries.length === 0) { __lmSoundClear(); return; }
    const generation = ++__lmSoundGeneration;
    __lmSoundCancelPending();
    const prepared = new Map();
    try {
      const loaded = await Promise.allSettled(entries.map(async ([id, url]) => ({ id, url, audio: await __lmSoundLoad(url) })));
      for (const result of loaded) if (result.status === "fulfilled")
        prepared.set(result.value.id, { url: result.value.url, audio: result.value.audio });
      if (generation !== __lmSoundGeneration) throw new Error("Sound overlay request was superseded");
      if (loaded.some(result => result.status === "rejected")) throw new Error("One or more sound assets could not be loaded");
      if (generation !== __lmSoundGeneration) throw new Error("Sound overlay request was superseded");
      const loops = __lmSoundActiveLoops();
      if (!__lmSoundActive) __lmSoundOriginals = __lmSoundInstall();
      const old = [...__lmSoundPrepared.values()];
      __lmSoundStopOwnedPreview(old);
      __lmSoundPrepared.clear();
      for (const [id, value] of prepared) __lmSoundPrepared.set(id, value);
      __lmSoundActive = __lmSoundPrepared.size > 0;
      __lmSoundRestartLoops(loops);
      for (const value of old) __lmSoundDispose(value.audio);
    } catch (error) {
      for (const value of prepared.values()) __lmSoundDispose(value.audio);
      throw error;
    }
  }
  function __lmSoundClear() {
    ++__lmSoundGeneration;
    __lmSoundCancelPending();
    if (!__lmSoundActive) return;
    const loops = __lmSoundActiveLoops();
    const old = [...__lmSoundPrepared.values()];
    __lmSoundStopOwnedPreview(old);
    __lmSoundPrepared.clear();
    __lmSoundActive = false;
    __lmSoundOriginals?.();
    __lmSoundOriginals = undefined;
    __lmSoundRestartLoops(loops);
    for (const value of old) __lmSoundDispose(value.audio);
  }
  globalThis.LolkaMod?.modules.register("SoundEffects", Object.freeze({
    snapshot: () => ({ actions: __lmSoundIds.map(id => ({ id, defaultUrl: __lmSoundActions[id], enabled: !!__lmSoundEnabled(id) })),
      allSoundsMuted: !!__lmSoundStore.getState().allSoundsMuted, overlayActive: __lmSoundActive }),
    overlay: __lmSoundOverlay,
    clear: __lmSoundClear,
    preview: (id, volume = 0.5) => {
      if (!__lmSoundIds.includes(id)) throw new Error("Unknown sound action");
      if (typeof volume !== "number" || !Number.isFinite(volume) || volume < 0 || volume > 1)
        throw new Error("Preview volume must be between 0 and 1");
      __lmSoundManager.preview(__lmSoundActions[id], volume);
    }
  }), __LM_SOUND_HASH__);
})();
`;

export function transformSoundFeatures(source: string, hash: string) {
  const unsupported = { body: source, changed: false as const, features: { sounds: "unsupported" as const }, reason: "Звуковой сервис не поддерживается этой сборкой" };
  if (Buffer.byteLength(source, "utf8") > 16 * 1024 * 1024 || /\b__lmSoundManager\b/.test(source)) return unsupported;
  const contract = optionalContracts(source, soundSpecs, ["$a", "spt", "Hl", "Sg", "Qh"]);
  if (!contract) return unsupported;
  const body = source + contract.rebind(reference.replace("__LM_SOUND_HASH__", JSON.stringify(hash)));
  try { validateModule(body); } catch (error) { return { ...unsupported, reason: error instanceof Error ? `Звуковой адаптер не проходит проверку синтаксиса: ${error.message}` : unsupported.reason }; }
  return { body, changed: true as const, features: { sounds: "available" as const }, reason: "Найден штатный звуковой сервис" };
}
