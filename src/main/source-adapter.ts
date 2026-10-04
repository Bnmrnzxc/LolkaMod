import { createHash } from "node:crypto";
import { applyPatchGroup, nativeQualityPatches, nativeProfileReference } from "./native-quality-patches";
export { applyPatchGroup, nativeQualityPatches, nativeProfileReference } from "./native-quality-patches";
export const ENTRY_HASH = "0e3f6bfad2a2ca4be4a7eb435a54c2c481cfdd9a2cdadb931042a483dd0c10a2";
const ANCHOR = "eo.getState().initTheme()";
export const sourceAdapterReference = nativeProfileReference + `
;globalThis.LolkaMod?.modules.register("ScreenShareSettings", Object.freeze({
  snapshot: () => ({ bitrateMbps: Number(eo.getState().screenShareBitrate) || 0,
    resolution: localStorage.getItem("screenShareResolution"),
    fps: localStorage.getItem("screenShareFps"), codec: localStorage.getItem("screenShareCodecV3") }),
  capabilities: () => {
    const resolutions = $tr(false, false, 0);
    const rates = Btr(false, false, 0).map(Number);
    const profiles = resolutions.flatMap(resolution => rates.map(fps => ({resolution,fps,label:resolution+" / "+fps+" FPS"})));
    const codecs = [...new Set((RTCRtpSender.getCapabilities("video")?.codecs || []).map(c => c.mimeType.split("/")[1].toUpperCase()).filter(c => ["VP8","VP9","H264","AV1"].includes(c)))];
    return {available:true, profiles, codecs, bitrate:{min:1,max:50,default:16}, reason:"Штатное меню Lolka"};
  },
  nativeQuality: true,
  active: () => { const current = Lyt(); return current ? {
    resolution: current.resolution, fps: current.fps, codec: current.codec, bitrate: current.bitrate
  } : null; },
  ...(globalThis.LolkaModNative?.diagnostics().testMode ? {test: Object.freeze({
    profile: __lmStockProfile,
    encoder: V2e,
    constraints: () => { const p = __lmStockProfile(), size = mS[p.resolution]; return {
      width: {max:size.width}, height: {max:size.height}, frameRate: {ideal:p.fps,max:p.fps},
      bitrate: size.freeBitrate
    }; },
    mountPicker: (container, onSelect) => {
      const root = Eje.createRoot(container);
      root.render(s.jsx(vPe, {i18n:At, children:s.jsx(ztr, {
        sources:[{id:"window:lolkamod-test",name:"LolkaMod synthetic source"}], serverLevel:0,
        onSourceSelect:onSelect, onCancel:()=>{},
      })}));
      return () => root.unmount();
    }
  })} : {}),
  setCodec: codec => {
    const value = String(codec).toLowerCase();
    if (value === "auto") return;
    if (!["vp8","vp9","h264","av1"].includes(value)) throw new Error("Unsupported codec");
    const supported = (RTCRtpSender.getCapabilities("video")?.codecs || []).some(c => c.mimeType.toLowerCase() === "video/"+value);
    if (!supported) throw new Error("Codec unavailable");
    localStorage.setItem("screenShareCodecV3", value);
  }
}), "${ENTRY_HASH}");
`;
export function transformEntry(body: string) {
  const hash = createHash("sha256").update(body).digest("hex");
  if (hash !== ENTRY_HASH) return { status: "unsupported-hash", hash, body, changed: false };
  if (body.split(ANCHOR).length !== 2) return { status: "anchor-mismatch", hash, body, changed: false };
  const group = applyPatchGroup(body, nativeQualityPatches);
  if (!group.changed) return { status: "patch-mismatch", hash, body, changed: false, failedPatch: group.failedPatch };
  // The known, complete group is parsed at build time with its exact input hash.
  return { status: "transformed", hash, body: group.body + sourceAdapterReference, changed: true, patches: group.applied };
}

export async function enableSourceAdapter(webContents: any, report: (result: Record<string, unknown>) => void) {
  const debuggerApi = webContents.debugger;
  async function send(method: string, params: unknown) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([
      debuggerApi.sendCommand(method, params),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("CDP timeout")), 5000); })
    ]); } finally { if (timer) clearTimeout(timer); }
  }
  try {
    debuggerApi.attach("1.3");
    debuggerApi.on("message", async (_event: unknown, method: string, params: any) => {
      if (method !== "Fetch.requestPaused") return;
      const requestId = params.requestId;
      let fulfilled = false;
      try {
        const url = new URL(params.request.url);
        if (url.origin !== "https://lolka.app" || !/^\/assets\/index-[\w-]+\.js$/.test(url.pathname) || params.responseStatusCode !== 200) return;
        const response = await send("Fetch.getResponseBody", { requestId });
        const body = response.base64Encoded ? Buffer.from(response.body, "base64").toString("utf8") : response.body;
        const transformed = transformEntry(body);
        report({ status: transformed.status, hash: transformed.hash, patches: transformed.patches });
        if (!transformed.changed) return;
        const responseHeaders = (params.responseHeaders || []).filter((h: { name: string }) =>
          !["content-length", "content-encoding", "etag", "content-md5", "transfer-encoding"].includes(h.name.toLowerCase()));
        await send("Fetch.fulfillRequest", { requestId, responseCode: 200,
          responseHeaders, body: Buffer.from(transformed.body).toString("base64") });
        fulfilled = true;
      } catch { report({ status: "failed-open" }); }
      finally {
        if (!fulfilled) { try { await send("Fetch.continueRequest", { requestId }); } catch { /* Window/navigation ended. */ } }
      }
    });
    debuggerApi.on("detach", () => report({ connection: "detached" }));
    await send("Fetch.enable", { patterns: [{ urlPattern: "https://lolka.app/assets/index-*.js", requestStage: "Response" }] });
    report({ status: "armed", connection: "attached" });
  } catch { report({ status: "unavailable" }); }
}
