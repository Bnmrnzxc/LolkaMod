import { createHash } from "node:crypto";
import { applyPatchGroup, nativeQualityPatches, nativeProfileReference } from "./native-quality-patches";
import { compatibleQuality, validateModule } from "./compatible-quality";
export { applyPatchGroup, nativeQualityPatches, nativeProfileReference } from "./native-quality-patches";
export const ENTRY_HASH = "0e3f6bfad2a2ca4be4a7eb435a54c2c481cfdd9a2cdadb931042a483dd0c10a2";
function adapterReference(binding: Record<string, string>, hash: string, known: boolean) {
  const active = binding.Lyt ? `${binding.Lyt}()` : "null";
  const pickerTest = known ? `mountPicker: (container, onSelect) => {
      const root = Eje.createRoot(container);
      root.render(s.jsx(vPe, {i18n:At, children:s.jsx(ztr, {
        sources:[{id:"window:lolkamod-test",name:"LolkaMod synthetic source"}], serverLevel:0,
        onSourceSelect:onSelect, onCancel:()=>{},
      })}));
      return () => root.unmount();
    },` : "";
  return nativeProfileReference + `
;globalThis.LolkaMod?.modules.register("ScreenShareSettings", Object.freeze({
  snapshot: () => ({ bitrateMbps: Number((${active})?.bitrate || 0) / 1e6,
    resolution: localStorage.getItem("screenShareResolution"),
    fps: localStorage.getItem("screenShareFps"), codec: localStorage.getItem("screenShareCodecV3") }),
  capabilities: () => {
    const resolutions = ["720p", "1080p", "1440p"];
    const rates = [30, 60];
    const profiles = resolutions.flatMap(resolution => rates.map(fps => ({resolution,fps,label:resolution+" / "+fps+" FPS"})));
    const codecs = [...new Set((RTCRtpSender.getCapabilities("video")?.codecs || []).map(c => c.mimeType.split("/")[1].toUpperCase()).filter(c => ["VP8","VP9","H264","AV1"].includes(c)))];
    return {available:true, profiles, codecs, bitrate:{min:1,max:50,default:16}, reason:"Штатное меню Lolka"};
  },
  nativeQuality: true,
  active: () => { const current = ${active}; return current ? {
    resolution: current.resolution, fps: current.fps, codec: current.codec, bitrate: current.bitrate
  } : null; },
  ...(globalThis.LolkaModNative?.diagnostics().testMode ? {test: Object.freeze({
    profile: __lmStockProfile,
    encoder: ${binding.V2e},
    constraints: () => { const p = __lmStockProfile(), size = ${binding.mS}[p.resolution]; return {
      width: {max:size.width}, height: {max:size.height}, frameRate: {ideal:p.fps,max:p.fps},
      bitrate: size.freeBitrate
    }; },
    ${pickerTest}
  })} : {}),
  setCodec: codec => {
    const value = String(codec).toLowerCase();
    if (value === "auto") return;
    if (!["vp8","vp9","h264","av1"].includes(value)) throw new Error("Unsupported codec");
    const supported = (RTCRtpSender.getCapabilities("video")?.codecs || []).some(c => c.mimeType.toLowerCase() === "video/"+value);
    if (!supported) throw new Error("Codec unavailable");
    localStorage.setItem("screenShareCodecV3", value);
  }
}), "${hash}");
`;
}
export const sourceAdapterReference = adapterReference({ Lyt: "Lyt", V2e: "V2e", mS: "mS" }, ENTRY_HASH, true);
let cachedStructural: { hash: string; body: string; changed: true; status: string; patches: string[]; compatibility: string; reason: string; binding: Record<string, string> } | undefined;
export function transformEntry(body: string) {
  const hash = createHash("sha256").update(body).digest("hex");
  // The exact known output is syntax-checked against its fixture during build.
  if (hash === ENTRY_HASH) {
    const known = applyPatchGroup(body, nativeQualityPatches);
    if (known.changed) return { status: "transformed", hash, body: known.body + sourceAdapterReference, changed: true,
      patches: known.applied, compatibility: "known", reason: "Проверенная сборка интерфейса" };
  }
  if (cachedStructural?.hash === hash) return cachedStructural;
  const group = compatibleQuality(body);
  if (!group.changed) return { ...group, hash };
  const result = group.body + adapterReference(group.binding, hash, hash === ENTRY_HASH);
  try { validateModule(result); }
  catch { return { status: "syntax-error", reason: "Изменённый интерфейс не проходит проверку синтаксиса", hash, body, changed: false, patches: [] as string[] }; }
  const transformed = { status: "transformed", hash, body: result, changed: true as const, patches: group.patches,
    compatibility: hash === ENTRY_HASH ? "known" : "structural", reason: group.reason, binding: group.binding };
  cachedStructural = transformed;
  return transformed;
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
        if (url.origin !== "https://lolka.app" || !/^\/assets\/[\w.-]+\.js$/.test(url.pathname) || params.responseStatusCode !== 200) return;
        const response = await send("Fetch.getResponseBody", { requestId });
        const body = response.base64Encoded ? Buffer.from(response.body, "base64").toString("utf8") : response.body;
        if (!/\/index[-.]/.test(url.pathname) && !(body.includes("getDisplayMedia") && body.includes("screenShareResolution"))) return;
        const transformed = transformEntry(body);
        report({ status: transformed.status, hash: transformed.hash, patches: transformed.patches,
          compatibility: "compatibility" in transformed ? transformed.compatibility : undefined,
          reason: transformed.reason, checkedAt: new Date().toISOString() });
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
    await send("Fetch.enable", { patterns: [{ urlPattern: "https://lolka.app/assets/*.js", requestStage: "Response" }] });
    report({ status: "armed", connection: "attached" });
  } catch { report({ status: "unavailable" }); }
}
