import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_SETTINGS, validateSettings, type Settings } from "../shared/settings";
export function createSettingsStore(directory: string) {
  const file = path.join(directory, "settings.json");
  let status = "missing";
  function read(): Settings {
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      const next = validateSettings(value); status = value.schemaVersion === 1 ? "ready" : "migrated"; return next;
    } catch (error: any) { status = error?.code === "ENOENT" ? "missing" : String(error?.message).includes("Unsupported settings schema") ? "future-schema" : "invalid";
      return validateSettings(DEFAULT_SETTINGS); }
  }
  function write(value: unknown, reset = false): Settings {
    const next = validateSettings(value); read();
    if (!reset && (status === "future-schema" || status === "invalid")) throw new Error("Настройки мода повреждены или созданы новой версией. Используйте явный сброс с резервной копией.");
    fs.mkdirSync(directory, { recursive: true });
    if (fs.existsSync(file) && (reset || status === "migrated")) {
      const backup = path.join(directory, `settings-backup-${Date.now()}-${randomUUID()}.json`);
      fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
    }
    const temp = file + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(next), { encoding: "utf8", mode: 0o600 }); fs.renameSync(temp, file);
    status = "ready"; return next;
  }
  return { read, write, reset: () => write(DEFAULT_SETTINGS, true), status: () => status };
}
