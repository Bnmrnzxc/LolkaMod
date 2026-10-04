import type { StreamProfile } from "./streams";
export const VERSION = "0.5.2";
export const MAX_CSS_LENGTH = 128 * 1024;
export type ThemeId = "native" | "graphite" | "amoled" | "contrast";
export interface Settings { schemaVersion: 1; enabled: boolean; customCss: string; qualityEnabled: boolean; profile: StreamProfile;
  themeId: ThemeId; indicatorEnabled: boolean; indicatorDetailed: boolean; streamMenuEnabled: boolean }
export const DEFAULT_SETTINGS: Settings = { schemaVersion: 1, enabled: false, customCss: "", qualityEnabled: false,
    themeId: "native", indicatorEnabled: false, indicatorDetailed: false, streamMenuEnabled: true,
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
  if (v.schemaVersion !== undefined && v.schemaVersion !== 1) throw new Error("Unsupported settings schema");
  if (Object.keys(v).some(key => !["schemaVersion", "enabled", "customCss", "qualityEnabled", "profile", "themeId", "indicatorEnabled", "indicatorDetailed", "miniPlayerEnabled", "miniPlayerDock", "streamMenuEnabled"].includes(key)) ||
      typeof v.enabled !== "boolean" || typeof v.customCss !== "string" || v.customCss.length > MAX_CSS_LENGTH) {
    throw new Error("Invalid settings");
  }
  if (v.qualityEnabled !== undefined && typeof v.qualityEnabled !== "boolean") throw new Error("Invalid quality toggle");
  // Read old 0.5 profiles without exposing or writing removed mini-player fields.
  for (const key of ["indicatorEnabled", "indicatorDetailed", "miniPlayerEnabled", "streamMenuEnabled"])
    if (v[key] !== undefined && typeof v[key] !== "boolean") throw new Error("Invalid feature toggle");
  if (v.themeId !== undefined && (typeof v.themeId !== "string" || !["native", "graphite", "amoled", "contrast"].includes(v.themeId))) throw new Error("Invalid theme");
  if(v.miniPlayerDock!==undefined&&(typeof v.miniPlayerDock!=="string"||!["top-left","top-right","bottom-left","bottom-right"].includes(v.miniPlayerDock)))throw new Error("Invalid mini-player dock");
  return { schemaVersion: 1, enabled: v.enabled, customCss: v.customCss, qualityEnabled: v.qualityEnabled === true,
    themeId: (v.themeId ?? "native") as ThemeId, indicatorEnabled: v.indicatorEnabled === true,
    indicatorDetailed: v.indicatorDetailed === true, streamMenuEnabled: v.streamMenuEnabled !== false,
    profile: validateProfile(v.profile ?? DEFAULT_SETTINGS.profile) };
}
