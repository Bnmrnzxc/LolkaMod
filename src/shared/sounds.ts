export const SOUND_ACTIONS = [
  { id: "voiceJoin", title: "Вход в канал" }, { id: "voiceLeave", title: "Выход из канала" },
  { id: "userLeave", title: "Участник вышел" }, { id: "mute", title: "Микрофон выключен" },
  { id: "unmute", title: "Микрофон включён" }, { id: "soundDisable", title: "Звук выключен" },
  { id: "soundEnable", title: "Звук включён" }, { id: "cameraDisable", title: "Камера выключена" },
  { id: "cameraEnable", title: "Камера включена" }, { id: "radioActivation", title: "Начало Push-to-Talk" },
  { id: "radioDeactivation", title: "Конец Push-to-Talk" }, { id: "messageSound", title: "Новое сообщение" },
  { id: "outgoingCall", title: "Исходящий звонок" }, { id: "incomingCall", title: "Входящий звонок" },
  { id: "screenShareStarted", title: "Начало стрима" }, { id: "screenShareStopped", title: "Конец стрима" },
] as const;
export type SoundActionId = typeof SOUND_ACTIONS[number]["id"];
export interface SoundPack { id: "discord"; assets: { key: string; mimeType: "audio/mpeg"; base64: string }[] }
export interface SoundEffects {
  snapshot(): { actions: { id: string; defaultUrl: string; enabled: boolean }[]; allSoundsMuted: boolean; overlayActive: boolean };
  overlay(resources: Partial<Record<SoundActionId, string>>): Promise<void>;
  clear(): void;
  preview(id: SoundActionId, volume?: number): void;
}
export interface SoundThemeStatus {
  state: "off" | "waiting" | "loading" | "active" | "error";
  available: boolean; mapped: number; total: number; message: string;
  errorStage?: "load" | "verify" | "overlay";
  errorCode?: string;
}
