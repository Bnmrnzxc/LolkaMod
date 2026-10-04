import type { StreamProfile } from "./streams";
export const VERSION = "0.4.0";
export const MAX_CSS_LENGTH = 128 * 1024;
export interface Settings { enabled: boolean; customCss: string; qualityEnabled: boolean; profile: StreamProfile }
export const DEFAULT_SETTINGS: Settings = { enabled: false, customCss: "", qualityEnabled: false,
  profile: { resolution: "1440p", fps: 30, codec: "auto", bitrateMbps: 16 } };
export function validateProfile(value: unknown): StreamProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid stream profile");
  const p = value as Record<string, unknown>;
  if (Object.keys(p).some(key => !["resolution", "fps", "codec", "bitrateMbps"].includes(key)) ||
    typeof p.resolution !== "string" || typeof p.codec !== "string" ||
    !["480p", "720p", "1080p", "1440p"].includes(String(p.resolution)) ||
    ![15, 30, 60].includes(p.fps as number) || !["auto", "VP8", "VP9", "H264", "AV1"].includes(String(p.codec)) ||
    typeof p.bitrateMbps !== "number" || !Number.isFinite(p.bitrateMbps) || p.bitrateMbps < 1 || p.bitrateMbps > 50) {
    throw new Error("Invalid stream profile");
  }
  return { resolution: p.resolution as string, fps: p.fps as number, codec: p.codec as string, bitrateMbps: p.bitrateMbps };
}

export function validateSettings(value: unknown): Settings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid settings");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !["enabled", "customCss", "qualityEnabled", "profile"].includes(key)) ||
      typeof v.enabled !== "boolean" || typeof v.customCss !== "string" || v.customCss.length > MAX_CSS_LENGTH) {
    throw new Error("Invalid settings");
  }
  if (v.qualityEnabled !== undefined && typeof v.qualityEnabled !== "boolean") throw new Error("Invalid quality toggle");
  return { enabled: v.enabled, customCss: v.customCss, qualityEnabled: v.qualityEnabled === true,
    profile: validateProfile(v.profile ?? DEFAULT_SETTINGS.profile) };
}
