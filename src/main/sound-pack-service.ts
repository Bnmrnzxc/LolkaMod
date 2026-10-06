import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

export interface SoundAssetSpec {
  key: string;
  url: string;
  sha256: string;
  bytes: number;
  mimeType: "audio/mpeg";
}

export interface SoundPackServiceOptions {
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

export interface SoundPackDownloadStatus {
  state: "idle" | "loading" | "ready" | "error";
  stage?: "cache" | "download" | "verify" | "write";
  asset?: string;
  code?: "timeout" | "network" | "http" | "redirect" | "type" | "size" | "checksum" | "format" | "cache-write" | "cancelled" | "unknown";
  httpStatus?: number;
}

export type SoundPackStatus = SoundPackDownloadStatus;

type SoundPackFailureDetails = Omit<SoundPackStatus, "state">;

class SoundPackFailure extends Error {
  constructor(readonly details: SoundPackFailureDetails, message: string) {
    super(message);
    this.name = "SoundPackFailure";
  }
}

function soundFailure(details: SoundPackFailureDetails, message: string): SoundPackFailure {
  return new SoundPackFailure(details, message);
}

const MAX_ASSETS = 32;
const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const MAX_PACK_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const ALLOWED_HOSTS = new Set(["discord.com", "cdn.discordapp.com"]);
const KEY_PATTERN = /^[a-z][a-z0-9_-]{0,79}$/;
const PATH_PATTERN = /^\/assets\/[A-Za-z0-9_.-]+\.mp3$/;

function validAssetUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid sound asset URL");
  }
  if (
    url.protocol !== "https:" ||
    !ALLOWED_HOSTS.has(url.hostname) ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !PATH_PATTERN.test(url.pathname)
  ) {
    throw new Error("Sound asset URL is outside the approved Discord CDN paths");
  }
  return url;
}

function validateCatalog(assets: readonly SoundAssetSpec[]): SoundAssetSpec[] {
  if (!Array.isArray(assets) || assets.length === 0 || assets.length > MAX_ASSETS) {
    throw new Error("Invalid sound asset catalog size");
  }
  for (let index = 0; index < assets.length; index++) {
    if (!Object.hasOwn(assets, index)) throw new Error("Invalid sparse sound asset catalog");
  }
  let totalBytes = 0;
  const keys = new Set<string>();
  return assets.map((asset) => {
    if (
      !asset ||
      typeof asset !== "object" ||
      typeof asset.key !== "string" ||
      !KEY_PATTERN.test(asset.key) ||
      keys.has(asset.key) ||
      typeof asset.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes <= 0 ||
      asset.bytes > MAX_ASSET_BYTES ||
      asset.mimeType !== "audio/mpeg"
    ) {
      throw new Error("Invalid sound asset catalog entry");
    }
    validAssetUrl(asset.url);
    keys.add(asset.key);
    totalBytes += asset.bytes;
    if (totalBytes > MAX_PACK_BYTES) throw new Error("Sound asset catalog is too large");
    return { key: asset.key, url: asset.url, sha256: asset.sha256, bytes: asset.bytes, mimeType: asset.mimeType };
  });
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isMp3(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 3 &&
    ((bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) ||
      (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))
  );
}

function validateBytes(asset: SoundAssetSpec, bytes: Uint8Array): void {
  if (bytes.byteLength !== asset.bytes) throw soundFailure({ stage: "verify", asset: asset.key, code: "size" }, `Sound asset size mismatch: ${asset.key}`);
  if (digest(bytes) !== asset.sha256) throw soundFailure({ stage: "verify", asset: asset.key, code: "checksum" }, `Sound asset checksum mismatch: ${asset.key}`);
  if (!isMp3(bytes)) throw soundFailure({ stage: "verify", asset: asset.key, code: "format" }, `Sound asset is not an MP3: ${asset.key}`);
}

async function boundedBody(response: Response, asset: SoundAssetSpec): Promise<Uint8Array> {
  const type = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  if (type !== "audio/mpeg" && type !== "application/octet-stream") {
    throw soundFailure({ stage: "verify", asset: asset.key, code: "type" }, `Unexpected sound asset content type: ${asset.key}`);
  }
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) !== asset.bytes || Number(length) > MAX_ASSET_BYTES)) {
    throw soundFailure({ stage: "verify", asset: asset.key, code: "size" }, `Invalid sound asset content length: ${asset.key}`);
  }
  if (!response.body) throw soundFailure({ stage: "verify", asset: asset.key, code: "size" }, `Empty sound asset response: ${asset.key}`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > asset.bytes || size > MAX_ASSET_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw soundFailure({ stage: "verify", asset: asset.key, code: "size" }, `Sound asset body exceeds expected size: ${asset.key}`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof SoundPackFailure) throw error;
    throw soundFailure({ stage: "download", asset: asset.key, code: "network" }, `Sound asset response failed: ${asset.key}`);
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  validateBytes(asset, bytes);
  return bytes;
}

export function createSoundPackService(
  directory: string,
  assets: readonly SoundAssetSpec[],
  options: SoundPackServiceOptions = {},
): {
  load(): Promise<{ id: "discord"; assets: { key: string; mimeType: "audio/mpeg"; base64: string }[] }>;
  stop(): void;
  status(): SoundPackStatus;
} {
  // Validate all caller-supplied catalog data before touching the filesystem or network.
  const catalog = validateCatalog(assets);
  if (typeof directory !== "string" || directory.length === 0) throw new Error("Invalid sound cache directory");
  const cacheDirectory = path.resolve(directory);
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid sound fetch timeout");

  let stopped = false;
  let generation = 0;
  let inFlight: Promise<{ id: "discord"; assets: { key: string; mimeType: "audio/mpeg"; base64: string }[] }> | undefined;
  let currentStatus: SoundPackStatus = { state: "idle" };
  const controllers = new Set<AbortController>();

  function progress(stage: NonNullable<SoundPackStatus["stage"]>, asset: string) {
    if (currentStatus.state === "loading") currentStatus = { state: "loading", stage, asset };
  }

  function failed(error: unknown, asset?: string): SoundPackStatus {
    if (error instanceof SoundPackFailure) return { state: "error", ...error.details };
    return { state: "error", stage: "download", ...(asset ? { asset } : {}), code: "unknown" };
  }

  async function cached(asset: SoundAssetSpec): Promise<Uint8Array | undefined> {
    const filename = path.join(cacheDirectory, `${asset.key}-${asset.sha256}.mp3`);
    try {
      const info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_ASSET_BYTES || info.size !== asset.bytes) return undefined;
      const bytes = await readFile(filename);
      validateBytes(asset, bytes);
      return bytes;
    } catch {
      return undefined;
    }
  }

  async function download(asset: SoundAssetSpec, expectedGeneration: number): Promise<Uint8Array> {
    if (stopped || generation !== expectedGeneration) throw soundFailure({ stage: "download", asset: asset.key, code: "cancelled" }, "Sound pack service stopped");
    const controller = new AbortController();
    controllers.add(controller);
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(new Error("Sound download timed out")); }, timeoutMs);
    try {
      let url = validAssetUrl(asset.url);
      let response: Response | undefined;
      for (let redirects = 0; redirects <= 3; redirects++) {
        progress("download", asset.key);
        try {
          response = await fetcher(url, { method: "GET", redirect: "manual", credentials: "omit", signal: controller.signal });
        } catch (error) {
          const code = timedOut ? "timeout" : stopped || generation !== expectedGeneration ? "cancelled" : "network";
          const message = code === "timeout" ? "Sound download timed out" : error instanceof Error ? error.message : "Sound download request failed";
          throw soundFailure({ stage: "download", asset: asset.key, code }, message);
        }
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location || redirects === 3) throw soundFailure({ stage: "download", asset: asset.key, code: "redirect", httpStatus: response.status }, `Rejected sound CDN redirect: ${asset.key}`);
          await response.body?.cancel().catch(() => undefined);
          try {
            url = validAssetUrl(new URL(location, url).toString());
          } catch {
            throw soundFailure({ stage: "download", asset: asset.key, code: "redirect", httpStatus: response.status }, "Sound asset URL is outside the approved Discord CDN paths");
          }
          continue;
        }
        break;
      }
      if (!response?.ok) throw soundFailure({ stage: "download", asset: asset.key, code: "http", ...(response && Number.isInteger(response.status) ? { httpStatus: response.status } : {}) }, `Sound download failed with status ${response?.status ?? "unknown"}: ${asset.key}`);
      progress("verify", asset.key);
      let bytes: Uint8Array;
      try {
        bytes = await boundedBody(response, asset);
      } catch (error) {
        if (timedOut) throw soundFailure({ stage: "download", asset: asset.key, code: "timeout" }, "Sound download timed out");
        if (stopped || generation !== expectedGeneration) throw soundFailure({ stage: "download", asset: asset.key, code: "cancelled" }, "Sound pack service stopped");
        throw error;
      }
      if (stopped || generation !== expectedGeneration || controller.signal.aborted) throw soundFailure({ stage: "download", asset: asset.key, code: "cancelled" }, "Sound pack service stopped");
      progress("write", asset.key);
      try {
        await mkdir(cacheDirectory, { recursive: true });
        if (stopped || generation !== expectedGeneration) throw soundFailure({ stage: "write", asset: asset.key, code: "cancelled" }, "Sound pack service stopped");
        const filename = path.join(cacheDirectory, `${asset.key}-${asset.sha256}.mp3`);
        const temporary = path.join(cacheDirectory, `.${asset.key}-${asset.sha256}-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`);
        try {
          const file = await open(temporary, "wx", 0o600);
          try {
            await file.writeFile(bytes);
            await file.sync();
          } finally {
            await file.close();
          }
          if (stopped || generation !== expectedGeneration) throw new Error("Sound pack service stopped");
          await rename(temporary, filename);
        } finally {
          await rm(temporary, { force: true }).catch(() => undefined);
        }
      } catch (error) {
        if (error instanceof SoundPackFailure) throw error;
        throw soundFailure({ stage: "write", asset: asset.key, code: "cache-write" }, "Sound cache write failed");
      }
      return bytes;
    } finally {
      clearTimeout(timeout);
      controllers.delete(controller);
    }
  }

  async function loadOnce(expectedGeneration: number) {
    const loaded = await Promise.all(catalog.map(async (asset) => {
      if (stopped || generation !== expectedGeneration) throw soundFailure({ stage: "cache", asset: asset.key, code: "cancelled" }, "Sound pack service stopped");
      progress("cache", asset.key);
      const cachedBytes = await cached(asset);
      return cachedBytes ?? (await download(asset, expectedGeneration));
    }));
    if (stopped || generation !== expectedGeneration) throw soundFailure({ stage: "cache", code: "cancelled" }, "Sound pack service stopped");
    return {
      id: "discord" as const,
      assets: catalog.map((asset, index) => ({ key: asset.key, mimeType: "audio/mpeg" as const, base64: Buffer.from(loaded[index]).toString("base64") })),
    };
  }

  return {
    load() {
      if (stopped) {
        currentStatus = { state: "error", stage: "cache", code: "cancelled" };
        return Promise.reject(new Error("Sound pack service stopped"));
      }
      if (!inFlight) {
        const expectedGeneration = generation;
        currentStatus = { state: "loading", stage: "cache", asset: catalog[0]!.key };
        const pending = loadOnce(expectedGeneration).then((pack) => {
          currentStatus = { state: "ready" };
          return pack;
        }, (error) => {
          currentStatus = failed(error);
          throw error;
        });
        inFlight = pending;
        void pending.finally(() => { if (inFlight === pending) inFlight = undefined; }).catch(() => undefined);
      }
      return inFlight;
    },
    status() { return { ...currentStatus }; },
    stop() {
      if (stopped) return;
      stopped = true;
      generation++;
      if (currentStatus.state === "loading") currentStatus = { state: "error", stage: currentStatus.stage, asset: currentStatus.asset, code: "cancelled" };
      for (const controller of controllers) controller.abort(new Error("Sound pack service stopped"));
      controllers.clear();
    },
  };
}
