import { compareVersions, releaseURL, type UpdateStatus } from "../shared/updates";
const API = "https://api.github.com/repos/Bnmrnzxc/LolkaMod/releases/latest";
const MAX_RESPONSE = 512 * 1024;
export function createUpdateService(installed: string, fetcher: typeof fetch = fetch, now: () => number = Date.now) {
  compareVersions(installed, installed);
  let status: UpdateStatus = { state: "idle", installed }, inflight: Promise<UpdateStatus> | undefined;
  let etag: string | undefined, cached: UpdateStatus | undefined, cooldown = 0, controller: AbortController | undefined;
  async function run(): Promise<UpdateStatus> {
    let response:Response|undefined;
    const checkedAt = now(); controller = new AbortController();
    const timer = setTimeout(() => controller?.abort(), 10000);
    try {
      response = await fetcher(API, { method: "GET", redirect: "error", signal: controller.signal,
        headers: { Accept: "application/vnd.github+json", "User-Agent": "LolkaMod-Update-Check", ...(etag ? { "If-None-Match": etag } : {}) } });
      if (response.status === 304 && cached) { status = { ...cached, checkedAt }; cooldown = checkedAt + 60000; return { ...status }; }
      if (response.status === 403 || response.status === 429) {
        const retry = response.headers.get("retry-after"), reset = Number(response.headers.get("x-ratelimit-reset"));
        const delay = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : retry ? Date.parse(retry) - checkedAt : 0;
        cooldown = Math.max(checkedAt + 60000, Number.isFinite(delay) ? checkedAt + Math.min(Math.max(delay, 0), 86400000) : 0,
          Number.isFinite(reset) && reset > 0 ? Math.min(reset * 1000, checkedAt + 86400000) : 0);
        status = { state: "rate-limited", installed, checkedAt, retryAt: cooldown, message: "GitHub временно ограничил запросы. Повторите позже." }; return { ...status };
      }
      if (!response.ok) throw new Error("HTTP");
      const declared = Number(response.headers.get("content-length"));
      if (declared > MAX_RESPONSE) throw new Error("Size");
      const reader = response.body?.getReader(); if (!reader) throw new Error("Body");
      const chunks: Uint8Array[] = []; let length = 0;
      try { for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length;
        if (length > MAX_RESPONSE) { await reader.cancel(); throw new Error("Size"); } chunks.push(part.value); } }
      finally { reader.releaseLock(); }
      const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const value = JSON.parse(new TextDecoder().decode(bytes));
      const url = releaseURL(value?.tag_name, value?.html_url);
      if (value?.draft !== false || value?.prerelease !== false || !url) throw new Error("Release");
      const latest = value.tag_name.replace(/^v/, ""), comparison = compareVersions(latest, installed);
      status = { state: comparison > 0 ? "available" : comparison < 0 ? "ahead" : "current", installed, latest, url, checkedAt };
      etag = response.headers.get("etag")?.slice(0, 256); cached = { ...status }; cooldown = checkedAt + 60000;
    } catch {
      status = { state: "error", installed, checkedAt, message: "Не удалось проверить обновления. Проверьте подключение и повторите позже." };
      cooldown = checkedAt + 10000;
    } finally {
      clearTimeout(timer); controller?.abort(); controller = undefined;
      if(response?.body&&!response.bodyUsed)try{await response.body.cancel();}catch{/* Already aborted. */}
    }
    return { ...status };
  }
  return {
    status: () => ({ ...status }),
    check(): Promise<UpdateStatus> {
      if (inflight) return inflight;
      if (now() < cooldown) return Promise.resolve({ ...status });
      status = { state: "checking", installed };
      inflight = run().finally(() => { inflight = undefined; }); return inflight;
    },
    stop() { controller?.abort(); }
  };
}
