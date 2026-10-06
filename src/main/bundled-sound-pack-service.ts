import { createHash } from "node:crypto";
import type { SoundAssetSpec, SoundPackDownloadStatus } from "./sound-pack-service.js";
import type { SoundPack } from "../shared/sounds.js";

type BundledSpec = Pick<SoundAssetSpec, "key" | "sha256" | "bytes" | "mimeType">;

const MAX_ASSETS = 32;
const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const MAX_PACK_BYTES = 32 * 1024 * 1024;
const KEY_PATTERN = /^[a-z][a-z0-9_-]{0,79}$/;
type FailureCode = "checksum" | "size" | "type" | "format" | "unknown" | "cancelled";

class PackFailure extends Error {
  constructor(readonly code: FailureCode, readonly asset?: string) { super(code); }
}

function fail(code: FailureCode, asset?: string): never { throw new PackFailure(code, asset); }

function cloneInput<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function isMp3(bytes: Buffer): boolean {
  if (bytes.length >= 10 && bytes.toString("ascii", 0, 3) === "ID3") return true;
  if (bytes.length < 4 || bytes[0] !== 0xff || (bytes[1]! & 0xe0) !== 0xe0) return false;
  const layer = (bytes[1]! >> 1) & 0x03;
  const bitrate = (bytes[2]! >> 4) & 0x0f;
  const sampleRate = (bytes[2]! >> 2) & 0x03;
  return layer !== 0 && bitrate !== 0 && bitrate !== 0x0f && sampleRate !== 0x03;
}

function copyPack(assets: SoundPack["assets"]): SoundPack {
  return { id: "discord", assets: assets.map(({ key, mimeType, base64 }) => ({ key, mimeType, base64 })) };
}

export function createBundledSoundPackService(
  specs: readonly BundledSpec[],
  pack: unknown,
): {
  load(): Promise<SoundPack>;
  status(): SoundPackDownloadStatus;
  stop(): void;
} {
  // Capture caller-owned data now; catalog and payload validation stays deferred until load().
  let sourceSpecs: readonly BundledSpec[] = [];
  let sourcePack: unknown;
  let captureFailed = false;
  try {
    sourceSpecs = cloneInput(specs);
    sourcePack = cloneInput(pack);
  } catch {
    captureFailed = true;
  }
  let stopped = false;
  let snapshot: SoundPack | undefined;
  let currentStatus: SoundPackDownloadStatus = { state: "idle" };

  function validate(): SoundPack {
    if (captureFailed) fail("unknown");
    if (!Array.isArray(sourceSpecs) || sourceSpecs.length === 0 || sourceSpecs.length > MAX_ASSETS) fail("unknown");
    let catalogBytes = 0;
    const catalog = new Map<string, BundledSpec>();
    for (let i = 0; i < sourceSpecs.length; i++) {
      if (!Object.hasOwn(sourceSpecs, i)) fail("unknown");
      const spec = sourceSpecs[i];
      if (!spec || typeof spec !== "object" || typeof spec.key !== "string" || !KEY_PATTERN.test(spec.key) ||
          typeof spec.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(spec.sha256)) fail("unknown");
      if (!Number.isSafeInteger(spec.bytes) || spec.bytes <= 0 || spec.bytes > MAX_ASSET_BYTES) fail("size", spec.key);
      if (spec.mimeType !== "audio/mpeg") fail("type", spec.key);
      if (catalog.has(spec.key)) fail("unknown", spec.key);
      catalogBytes += spec.bytes;
      if (catalogBytes > MAX_PACK_BYTES) fail("size", spec.key);
      catalog.set(spec.key, { key: spec.key, sha256: spec.sha256, bytes: spec.bytes, mimeType: spec.mimeType });
    }

    if (!sourcePack || typeof sourcePack !== "object" || (sourcePack as any).id !== "discord" || !Array.isArray((sourcePack as any).assets)) fail("unknown");
    const items = (sourcePack as any).assets as unknown[];
    if (items.length !== catalog.size) fail("unknown");
    for (let i = 0; i < items.length; i++) if (!Object.hasOwn(items, i)) fail("unknown");
    const seen = new Set<string>();
    let payloadBytes = 0;
    const verified: SoundPack["assets"] = [];
    for (const item of items) {
      if (!item || typeof item !== "object" || Array.isArray(item)) fail("unknown");
      const record = item as Record<string, unknown>;
      if (typeof record.key !== "string") fail("unknown");
      const key = record.key;
      const spec = catalog.get(key);
      if (!spec || seen.has(key)) fail("unknown", spec ? key : undefined);
      seen.add(key);
      if (record.mimeType !== "audio/mpeg") fail("type", key);
      if (typeof record.base64 !== "string") fail("format", key);
      const base64 = record.base64;
      if (base64.length !== Math.ceil(spec.bytes / 3) * 4) fail("size", key);
      if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) fail("format", key);
      const bytes = Buffer.from(base64, "base64");
      if (bytes.toString("base64") !== base64) fail("format", key);
      if (bytes.byteLength !== spec.bytes) fail("size", key);
      payloadBytes += bytes.byteLength;
      if (payloadBytes > MAX_PACK_BYTES) fail("size", key);
      if (createHash("sha256").update(bytes).digest("hex") !== spec.sha256) fail("checksum", key);
      if (!isMp3(bytes)) fail("format", key);
      verified.push({ key: spec.key, mimeType: "audio/mpeg", base64 });
    }
    if (seen.size !== catalog.size) fail("unknown");
    return { id: "discord", assets: verified };
  }

  return {
    async load() {
      if (stopped) {
        currentStatus = { state: "error", stage: "verify", code: "cancelled" };
        fail("cancelled");
      }
      if (!snapshot) {
        currentStatus = { state: "loading", stage: "verify" };
        try {
          // Defer verification until the first toggle and let stop() cancel before it begins.
          await Promise.resolve();
          if (stopped) fail("cancelled");
          if (!snapshot) {
            snapshot = validate();
            currentStatus = { state: "ready" };
          }
        } catch (error) {
          const known = error instanceof PackFailure ? error : undefined;
          currentStatus = {
            state: "error",
            stage: "verify",
            ...(known?.asset ? { asset: known.asset } : {}),
            code: stopped ? "cancelled" : known?.code ?? "unknown",
          };
          throw new Error("Bundled sound pack validation failed");
        }
      }
      return copyPack(snapshot.assets);
    },
    status() { return { ...currentStatus }; },
    stop() {
      if (stopped) return;
      stopped = true;
      currentStatus = { state: "error", stage: "verify", code: "cancelled" };
      snapshot = undefined;
    },
  };
}
