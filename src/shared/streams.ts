export interface StreamProfile {
  resolution: string;
  fps: number;
  codec: string;
  bitrateMbps: number;
}
export interface StreamCapabilities {
  available: boolean;
  profiles: Array<{ resolution: string; fps: number; label: string }>;
  codecs: string[];
  bitrate: { min: number; max: number; default: number };
  reason: string;
}
export interface StreamSettingsAdapter {
  snapshot(): StreamProfile;
  capabilities(): StreamCapabilities;
  setProfile(profile: StreamProfile): void;
}
