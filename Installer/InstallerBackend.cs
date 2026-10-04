using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace LolkaModInstaller
{
    public static class InstallerBackend
    {
        public const string ModVersion = "0.5.2";
        // Migration hint only; schema 2 stores the exact hash of each validated host.
        private const string OriginalHash = "fd94ecec264d7d7a56a0b5d1bb5ac1e416b6c9a4ee2d171b3704b0b72f0260a8";
        private const string HostMain = "dist-js/main.js", HostPreload = "dist-js/preload.js";
        private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
        private static readonly Regex ShaPattern = new Regex("^[a-f0-9]{64}$"), VersionPattern = new Regex(@"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$");
        public static string DefaultInstallation { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Lolka"); } }
        private sealed class Layout
        {
            public string Root, Resources, Archive, Backup, Mod, Journal;
            public Layout(string installation)
            {
                if (String.IsNullOrWhiteSpace(installation)) throw new IOException("Выберите папку Lolka.");
                Root = Path.GetFullPath(installation).TrimEnd(Path.DirectorySeparatorChar);
                Resources = Path.Combine(Root, "resources"); Archive = Path.Combine(Resources, "app.asar");
                Backup = Path.Combine(Resources, "_app.asar"); Mod = Path.Combine(Resources, "lolkamod"); Journal = Path.Combine(Resources, ".lolkamod-transaction.json");
                if (!Directory.Exists(Resources) || !File.Exists(Archive)) throw new IOException("В папке нет resources/app.asar. Установите Lolka и выберите её папку.");
                for (var folder = new DirectoryInfo(Root); folder != null; folder = folder.Parent) NoLink(folder.FullName);
                NoLink(Resources); NoLink(Archive);
                foreach (string file in new[] { Backup, Mod, Journal }) if (File.Exists(file) || Directory.Exists(file)) NoLink(file);
                if (Directory.Exists(Mod)) CheckTree(Mod);
            }
        }
        private sealed class Host
        {
            public string Version, Hash, Preload;
        }
        private static Dictionary<string, object> Json(string text)
        {
            var serializer = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024, RecursionLimit = 128 };
            var value = serializer.DeserializeObject(text) as Dictionary<string, object>;
            if (value == null) throw new IOException("Некорректный JSON."); return value;
        }
        private static string StringValue(Dictionary<string, object> data, string key) { object value; return data.TryGetValue(key, out value) ? value as string : null; }
        private static string Hash(byte[] bytes) { using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); }
        private static string FileHash(string path) { return Hash(File.ReadAllBytes(path)); }
        private static bool IsHash(string value) { return value != null && ShaPattern.IsMatch(value); }
        private static void NoLink(string path) { if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new IOException("Путь через symbolic link/junction не поддерживается: " + path); }
        private static void CheckTree(string path)
        {
            NoLink(path);
            foreach (var child in Directory.GetFileSystemEntries(path)) { NoLink(child); if (Directory.Exists(child)) CheckTree(child); }
        }
        private static void SafeDeleteTree(string path, string expectedParent)
        {
            if (!String.Equals(Path.GetDirectoryName(Path.GetFullPath(path)), Path.GetFullPath(expectedParent), StringComparison.OrdinalIgnoreCase)) throw new IOException("Небезопасный путь удаления.");
            if (Directory.Exists(path)) { CheckTree(path); Directory.Delete(path, true); }
        }
        private static void CopyTree(string source, string target)
        {
            CheckTree(source); Directory.CreateDirectory(target);
            foreach (string child in Directory.GetFileSystemEntries(source))
            {
                string destination = Path.Combine(target, Path.GetFileName(child));
                if (Directory.Exists(child)) CopyTree(child, destination); else DurableWrite(destination, File.ReadAllBytes(child));
            }
        }
        private static void TreeItems(string folder, string prefix, StringBuilder items)
        {
            string[] children = Directory.GetFileSystemEntries(folder); Array.Sort(children, StringComparer.Ordinal);
            foreach (string child in children)
            {
                NoLink(child); string relative = prefix + Path.GetFileName(child);
                if (Directory.Exists(child)) { items.Append("d:").Append(relative).Append('\n'); TreeItems(child, relative + "/", items); }
                else items.Append("f:").Append(relative).Append(':').Append(FileHash(child)).Append('\n');
            }
        }
        private static string TreeHash(string folder) { var items = new StringBuilder(); TreeItems(folder, "", items); return Hash(Utf8.GetBytes(items.ToString())); }
        private static void DurableWrite(string path, byte[] bytes)
        {
            using (var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { stream.Write(bytes, 0, bytes.Length); stream.Flush(true); }
        }
        private static void AtomicWrite(string path, byte[] bytes)
        {
            string temp = Path.Combine(Path.GetDirectoryName(path), ".lolkamod-entry-" + Guid.NewGuid().ToString("N") + ".tmp");
            DurableWrite(temp, bytes);
            try { if (File.Exists(path)) { NoLink(path); File.Replace(temp, path, null); } else File.Move(temp, path); }
            finally { if (File.Exists(temp)) File.Delete(temp); }
        }
        private static void WriteJson(string path, object value) { DurableWrite(path, Utf8.GetBytes(new JavaScriptSerializer().Serialize(value))); }
        private static FileStream Lock(Layout layout)
        {
            string path = Path.Combine(layout.Resources, ".lolkamod-install.lock");
            if (File.Exists(path))
            {
                NoLink(path);
                var previous = Json(File.ReadAllText(path, Utf8)); object pidValue;
                if (!previous.TryGetValue("pid", out pidValue) || Convert.ToInt32(pidValue) < 1) throw new IOException("Неизвестная блокировка установщика. Файлы сохранены.");
                bool alive = true;
                try { using (var process = Process.GetProcessById(Convert.ToInt32(pidValue))) alive = !process.HasExited; }
                catch (ArgumentException) { alive = false; }
                if (alive) throw new IOException("Другой установщик уже работает.");
                File.Delete(path);
            }
            var handle = new FileStream(path, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None, 1, FileOptions.DeleteOnClose);
            byte[] owner = Utf8.GetBytes(new JavaScriptSerializer().Serialize(new { pid = Process.GetCurrentProcess().Id })); handle.Write(owner, 0, owner.Length); handle.Flush(true); return handle;
        }
        private static void EnsureStopped(Layout layout)
        {
            string executable = Path.Combine(layout.Root, "Lolka.exe");
            foreach (var process in Process.GetProcessesByName("Lolka")) using (process)
            {
                try { if (!process.HasExited && String.Equals(process.MainModule.FileName, executable, StringComparison.OrdinalIgnoreCase)) throw new IOException("Закройте Lolka, включая значок в трее, и повторите операцию."); }
                catch (System.ComponentModel.Win32Exception) { if (!process.HasExited) throw new IOException("Не удалось проверить запущенный процесс Lolka. Закройте клиент и повторите."); }
                catch (InvalidOperationException) { }
            }
        }
        private static void ReplaceArchive(Layout layout, byte[] bytes, string expectedHash)
        {
            if (Hash(bytes) != expectedHash) throw new IOException("Replacement ASAR hash mismatch.");
            EnsureStopped(layout); AtomicWrite(layout.Archive, bytes);
            if (FileHash(layout.Archive) != expectedHash) throw new IOException("ASAR verification failed.");
        }
        private static byte[] ReadAsar(byte[] archive, string file)
        {
            if (archive.Length < 16 || BitConverter.ToUInt32(archive, 0) != 4) throw new IOException("Некорректный ASAR.");
            uint headerSize = BitConverter.ToUInt32(archive, 4), jsonSize = BitConverter.ToUInt32(archive, 12); long start = 8L + headerSize;
            if (headerSize < 8 || jsonSize > headerSize - 8 || start > archive.LongLength || jsonSize > 16 * 1024 * 1024) throw new IOException("Некорректный ASAR header.");
            var current = Json(Utf8.GetString(archive, 16, checked((int)jsonSize)));
            foreach (string component in file.Split('/'))
            {
                object filesValue, node;
                if (current.ContainsKey("link") || current.ContainsKey("unpacked") || !current.TryGetValue("files", out filesValue)) throw new IOException("Unsupported ASAR entry.");
                var files = filesValue as Dictionary<string, object>;
                if (files == null || !files.TryGetValue(component, out node)) throw new IOException("ASAR entry missing: " + file);
                current = node as Dictionary<string, object>; if (current == null) throw new IOException("Некорректная ASAR entry.");
            }
            long offset; object sizeValue;
            if (current.ContainsKey("link") || current.ContainsKey("unpacked") || !Int64.TryParse(StringValue(current, "offset"), out offset) || !current.TryGetValue("size", out sizeValue)) throw new IOException("Unsupported ASAR entry.");
            long size = Convert.ToInt64(sizeValue);
            if (offset < 0 || size < 0 || size > 16 * 1024 * 1024 || offset > archive.LongLength - start || size > archive.LongLength - start - offset) throw new IOException("ASAR entry out of bounds.");
            byte[] result = new byte[checked((int)size)]; Buffer.BlockCopy(archive, checked((int)(start + offset)), result, 0, result.Length); return result;
        }
        private static Host InspectHost(byte[] archive)
        {
            var package = Json(Utf8.GetString(ReadAsar(archive, "package.json"))); string version = StringValue(package, "version");
            if (StringValue(package, "name") != "Lolka" || StringValue(package, "homepage") != "https://lolka.app" || version == null || !VersionPattern.IsMatch(version) || StringValue(package, "main") != HostMain || StringValue(package, "type") == "module") throw new IOException("Неподдерживаемая структура Lolka package.json.");
            string main = Utf8.GetString(ReadAsar(archive, HostMain)), preload = Utf8.GetString(ReadAsar(archive, HostPreload));
            const string electron = "\\brequire\\s*\\(\\s*[\"']electron[\"']\\s*\\)";
            if (!Regex.IsMatch(main, electron)) throw new IOException("Неподдерживаемый Lolka main bridge.");
            foreach (string anchor in new[] { "BrowserWindow", "ipcMain", "https://lolka.app", "get-desktop-sources", "set-display-media-selected-source" }) if (!main.Contains(anchor)) throw new IOException("Неподдерживаемый Lolka main bridge.");
            if (!Regex.IsMatch(preload, electron) || !Regex.IsMatch(preload, "exposeInMainWorld\\s*\\(\\s*[\"']electronAPI[\"']\\s*,")) throw new IOException("Неподдерживаемый Lolka preload bridge.");
            foreach (string anchor in new[] { "get-desktop-sources", "set-display-media-selected-source" }) if (!preload.Contains(anchor)) throw new IOException("Неподдерживаемый Lolka preload bridge.");
            return new Host { Version = version, Hash = Hash(archive), Preload = preload };
        }
        private static Host TryHost(byte[] archive) { try { return InspectHost(archive); } catch (Exception error) { if (error is OutOfMemoryException) throw; return null; } }
        private static Dictionary<string, object> Manifest(Layout layout)
        {
            if (!Directory.Exists(layout.Mod)) return null;
            string path = Path.Combine(layout.Mod, "install.json"); if (!File.Exists(path)) return null; NoLink(path);
            try
            {
                var data = Json(File.ReadAllText(path, Utf8)); string version = StringValue(data, "hostVersion");
                if (!IsHash(StringValue(data, "originalHash")) || !IsHash(StringValue(data, "shimHash")) || version == null || !VersionPattern.IsMatch(version) || StringValue(data, "modVersion") == null) return null;
                object schema; int schemaVersion = data.TryGetValue("schemaVersion", out schema) ? Convert.ToInt32(schema) : 1;
                if (schemaVersion == 2) { if (StringValue(data, "hostMain") != HostMain || StringValue(data, "hostPreload") != HostPreload) return null; }
                else if (schemaVersion != 1 || StringValue(data, "originalHash") != OriginalHash) return null;
                return data;
            }
            catch (Exception error) { if (error is OutOfMemoryException) throw; return null; }
        }
        private static byte[] VerifyBackup(Layout layout, Dictionary<string, object> manifest)
        {
            if (manifest == null || !File.Exists(layout.Backup)) throw new IOException("Резервная копия отсутствует или manifest установки повреждён. Переустановите Lolka.");
            byte[] bytes = File.ReadAllBytes(layout.Backup);
            if (Hash(bytes) != StringValue(manifest, "originalHash")) throw new IOException("Резервная копия original ASAR повреждена. Переустановите Lolka.");
            if (InspectHost(bytes).Version != StringValue(manifest, "hostVersion")) throw new IOException("Backup host version mismatch."); return bytes;
        }
        private static Dictionary<string, byte[]> Payload()
        {
            byte[] bytes;
            using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("LolkaMod.Payload.zip"))
            {
                if (stream == null) throw new IOException("Installer payload missing.");
                using (var output = new MemoryStream()) { stream.CopyTo(output); bytes = output.ToArray(); }
            }
            if (Hash(bytes) != PayloadIntegrity.Sha256) throw new IOException("Installer payload hash mismatch.");
            var files = new Dictionary<string, byte[]>();
            using (var archive = new ZipArchive(new MemoryStream(bytes), ZipArchiveMode.Read)) foreach (string name in new[] { "main.cjs", "preload.js", "build.json", "shim.asar" })
            {
                var entry = archive.GetEntry(name); if (entry == null || entry.Length > 16 * 1024 * 1024) throw new IOException("Installer entry missing/too large: " + name);
                using (var stream = entry.Open()) using (var output = new MemoryStream()) { stream.CopyTo(output); files.Add(name, output.ToArray()); }
            }
            if (StringValue(Json(Utf8.GetString(files["build.json"])), "version") != ModVersion) throw new IOException("Installer/mod version mismatch."); return files;
        }
        private static bool Recover(Layout layout)
        {
            if (!File.Exists(layout.Journal)) return false;
            var journal = Json(File.ReadAllText(layout.Journal, Utf8)); object schema;
            string stageName = StringValue(journal, "stage"), beforeHash = StringValue(journal, "archiveBeforeHash"), afterHash = StringValue(journal, "archiveAfterHash");
            if (!journal.TryGetValue("schemaVersion", out schema) || Convert.ToInt32(schema) != 1 || stageName == null || !Regex.IsMatch(stageName, "^\\.lolkamod-stage-[a-f0-9-]+$") || !IsHash(beforeHash) || !IsHash(afterHash)) throw new IOException("Некорректный recovery journal. Файлы сохранены.");
            foreach (string key in new[] { "backupBeforeHash", "backupAfterHash", "beforeModHash", "afterModHash" }) { object value; if (!journal.TryGetValue(key, out value) || (value != null && !IsHash(value as string))) throw new IOException("Некорректный recovery journal."); }
            string stage = Path.Combine(layout.Resources, stageName); CheckTree(stage);
            byte[] entry = File.ReadAllBytes(Path.Combine(stage, "entry.before")); if (Hash(entry) != beforeHash) throw new IOException("Recovery snapshot integrity mismatch.");
            string oldBackupHash = StringValue(journal, "backupBeforeHash"), newBackupHash = StringValue(journal, "backupAfterHash"), oldModHash = StringValue(journal, "beforeModHash"), newModHash = StringValue(journal, "afterModHash");
            byte[] backup = oldBackupHash == null ? null : File.ReadAllBytes(Path.Combine(stage, "backup.before"));
            if (backup != null && Hash(backup) != oldBackupHash) throw new IOException("Recovery backup integrity mismatch.");
            if (oldModHash != null && TreeHash(Path.Combine(stage, "mod.before")) != oldModHash) throw new IOException("Recovery mod snapshot integrity mismatch.");
            string currentHash = FileHash(layout.Archive);
            if (currentHash != beforeHash && currentHash != afterHash) throw new IOException("ASAR изменён во время незавершённой операции. Текущие файлы сохранены.");
            if (File.Exists(layout.Backup) && FileHash(layout.Backup) != oldBackupHash && FileHash(layout.Backup) != newBackupHash) throw new IOException("Backup изменён во время незавершённой операции. Файлы сохранены.");
            if (Directory.Exists(layout.Mod) && TreeHash(layout.Mod) != oldModHash && TreeHash(layout.Mod) != newModHash) throw new IOException("Файлы мода изменены во время незавершённой операции. Файлы сохранены.");
            ReplaceArchive(layout, entry, beforeHash);
            if (backup != null) AtomicWrite(layout.Backup, backup); else if (File.Exists(layout.Backup)) File.Delete(layout.Backup);
            // Atomic directory moves keep every crash point recoverable.
            if (Directory.Exists(layout.Mod)) Directory.Move(layout.Mod, Path.Combine(stage, "mod.discarded-" + Guid.NewGuid().ToString("N")));
            if (oldModHash != null)
            {
                string restored = Path.Combine(stage, "restore-mod"); SafeDeleteTree(restored, stage); CopyTree(Path.Combine(stage, "mod.before"), restored); Directory.Move(restored, layout.Mod);
            }
            File.Delete(layout.Journal); SafeDeleteTree(stage, layout.Resources); return true;
        }
        private static void Transaction(Layout layout, byte[] entry, byte[] backup, string nextMod, bool preserveBackup, string expectedArchiveHash, string expectedBackupHash)
        {
            string stage = Path.Combine(layout.Resources, ".lolkamod-stage-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(stage);
            bool journalWritten = false, committed = false;
            try
            {
                byte[] beforeEntry = File.ReadAllBytes(layout.Archive), beforeBackup = File.Exists(layout.Backup) ? File.ReadAllBytes(layout.Backup) : null;
                if (Hash(beforeEntry) != expectedArchiveHash || (expectedBackupHash != null && (beforeBackup == null || Hash(beforeBackup) != expectedBackupHash))) throw new IOException("ASAR or backup changed during staging. Current files preserved.");
                DurableWrite(Path.Combine(stage, "entry.before"), beforeEntry); if (beforeBackup != null) DurableWrite(Path.Combine(stage, "backup.before"), beforeBackup);
                string oldModHash = Directory.Exists(layout.Mod) ? TreeHash(layout.Mod) : null;
                if (oldModHash != null) CopyTree(layout.Mod, Path.Combine(stage, "mod.before"));
                if (oldModHash != null && TreeHash(Path.Combine(stage, "mod.before")) != oldModHash) throw new IOException("Mod snapshot changed during staging.");
                if (nextMod != null) CopyTree(nextMod, Path.Combine(stage, "mod.next"));
                string newModHash = nextMod != null ? TreeHash(Path.Combine(stage, "mod.next")) : null;
                var journal = new Dictionary<string, object> { { "schemaVersion", 1 }, { "stage", Path.GetFileName(stage) }, { "archiveBeforeHash", Hash(beforeEntry) }, { "archiveAfterHash", Hash(entry) }, { "backupBeforeHash", beforeBackup == null ? null : Hash(beforeBackup) }, { "backupAfterHash", backup == null ? null : Hash(backup) }, { "beforeModHash", oldModHash }, { "afterModHash", newModHash } };
                EnsureStopped(layout); if (FileHash(layout.Archive) != Hash(beforeEntry) || (oldModHash != null && TreeHash(layout.Mod) != oldModHash)) throw new IOException("ASAR or mod changed during staging.");
                AtomicWrite(layout.Journal, Utf8.GetBytes(new JavaScriptSerializer().Serialize(journal))); journalWritten = true;
                if (backup != null) AtomicWrite(layout.Backup, backup); else if (File.Exists(layout.Backup)) File.Delete(layout.Backup);
                if (Directory.Exists(layout.Mod)) Directory.Move(layout.Mod, Path.Combine(stage, "mod.removed"));
                if (nextMod != null) Directory.Move(Path.Combine(stage, "mod.next"), layout.Mod);
                ReplaceArchive(layout, entry, Hash(entry));
                if ((backup != null && FileHash(layout.Backup) != Hash(backup)) || (nextMod != null && TreeHash(layout.Mod) != newModHash)) throw new IOException("Post-transaction integrity mismatch.");
                if (preserveBackup && beforeBackup != null) DurableWrite(Path.Combine(layout.Resources, "lolkamod-backup-" + Hash(beforeBackup) + "-" + Guid.NewGuid().ToString("N") + ".asar"), beforeBackup);
                File.Delete(layout.Journal); committed = true;
            }
            catch { if (journalWritten) Recover(layout); throw; }
            finally
            {
                if (committed || !journalWritten)
                {
                    try { SafeDeleteTree(stage, layout.Resources); }
                    catch (IOException) { if (!committed) throw; }
                    catch (UnauthorizedAccessException) { if (!committed) throw; }
                }
            }
        }
        private static string CompatibilityStatus(Layout layout)
        {
            string report = Path.Combine(layout.Mod, "compatibility.json");
            if (!File.Exists(report)) return "Запустите Lolka для проверки совместимости интерфейса.";
            try
            {
                NoLink(report); var data = Json(File.ReadAllText(report, Utf8)); string status = StringValue(data, "status");
                if (status == "transformed") return "Патчи качества работают для последней проверенной сборки интерфейса.";
                if (status == "armed") return "Запустите Lolka для проверки совместимости интерфейса.";
                return "Интерфейс изменился: нужна совместимая версия LolkaMod. Штатный интерфейс сохранён.";
            }
            catch { return "Отчёт интерфейса недоступен. Запустите Lolka для новой проверки."; }
        }
        public sealed class InstallStatus
        {
            public bool ClientFound { get; internal set; }
            public bool ModInstalled { get; internal set; }
            public bool BackupVerified { get; internal set; }
            public bool NeedsRepatch { get; internal set; }
            public bool RecoveryPending { get; internal set; }
            public string HostVersion { get; internal set; }
            public string InstalledModVersion { get; internal set; }
            public string Message { get; internal set; }
        }
        // Inspect once for both the CLI and UI. Card states must never be inferred from display text.
        public static InstallStatus InspectStatus(string installation)
        {
            var layout = new Layout(installation);
            if (File.Exists(layout.Journal)) return new InstallStatus { RecoveryPending = true,
                Message = "Предыдущая операция прервана. Закройте Lolka и повторите установку: будет выполнен откат незавершённой операции." };
            byte[] current = File.ReadAllBytes(layout.Archive); var host = TryHost(current); var manifest = Manifest(layout);
            if (host != null)
            {
                bool needsRepatch = Directory.Exists(layout.Mod) || File.Exists(layout.Backup);
                string action = needsRepatch ? "Lolka обновлена или мод снят. Нажмите «Установить / обновить»." : "Мод не установлен.";
                return new InstallStatus { ClientFound = true, HostVersion = host.Version, NeedsRepatch = needsRepatch,
                    Message = "Lolka " + host.Version + ": desktop-структура совместима. " + action + "\r\nСовместимость интерфейса проверяется при запуске." };
            }
            if (manifest == null || Hash(current) != StringValue(manifest, "shimHash")) throw new IOException("ASAR или manifest изменены. Неизвестные файлы сохранены; переустановите Lolka.");
            VerifyBackup(layout, manifest);
            return new InstallStatus { ClientFound = true, ModInstalled = true, BackupVerified = true,
                HostVersion = StringValue(manifest, "hostVersion"), InstalledModVersion = StringValue(manifest, "modVersion"),
                Message = "Установлен LolkaMod " + StringValue(manifest, "modVersion") + " для Lolka " + StringValue(manifest, "hostVersion") + ". Backup проверен.\r\n" + CompatibilityStatus(layout) };
        }
        public static string Status(string installation) { return InspectStatus(installation).Message; }
        public static string Install(string installation) { return Install(installation, null); }
        public static string Install(string installation, string testUserData)
        {
            var layout = new Layout(installation);
            using (Lock(layout))
            {
                EnsureStopped(layout); Recover(layout);
                byte[] current = File.ReadAllBytes(layout.Archive); var host = TryHost(current); var oldManifest = Manifest(layout); bool liveHost = host != null;
                byte[] original;
                if (liveHost) original = current;
                else
                {
                    if (oldManifest == null || Hash(current) != StringValue(oldManifest, "shimHash")) throw new IOException("Неподдерживаемый или изменённый ASAR. Текущие файлы сохранены.");
                    original = VerifyBackup(layout, oldManifest); host = InspectHost(original);
                }
                var payload = Payload(); string stage = Path.Combine(layout.Resources, ".lolkamod-stage-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(stage);
                try
                {
                    string nextMod = Path.Combine(stage, "next"); Directory.CreateDirectory(nextMod);
                    DurableWrite(Path.Combine(nextMod, "main.cjs"), payload["main.cjs"]); DurableWrite(Path.Combine(nextMod, "build.json"), payload["build.json"]);
                    DurableWrite(Path.Combine(nextMod, "preload.js"), Utf8.GetBytes("// Original preload retained in its own scope.\n(function(){\n" + host.Preload + "\n})();\n" + Utf8.GetString(payload["preload.js"])));
                    var config = new Dictionary<string, object> { { "testMode", testUserData != null }, { "baseline", false }, { "hostMain", HostMain }, { "hostPreload", HostPreload } };
                    if (testUserData != null) config.Add("userData", Path.GetFullPath(testUserData));
                    WriteJson(Path.Combine(nextMod, "config.json"), config);
                    string shimHash = Hash(payload["shim.asar"]);
                    WriteJson(Path.Combine(nextMod, "install.json"), new { schemaVersion = 2, modVersion = ModVersion, hostVersion = host.Version, hostMain = HostMain, hostPreload = HostPreload, originalHash = host.Hash, shimHash = shimHash, installedAt = DateTime.UtcNow.ToString("o"), testMode = testUserData != null });
                    Transaction(layout, payload["shim.asar"], original, nextMod, liveHost && File.Exists(layout.Backup), Hash(current), liveHost ? null : host.Hash);
                    return "Установлен LolkaMod " + ModVersion + " для Lolka " + host.Version + ".\r\nПосле обновления Lolka повторите установку. Совместимость штатных настроек 1440p/60 проверяется при запуске; диагностика Ctrl+Shift+M. Профиль пользователя сохранён.";
                }
                finally { SafeDeleteTree(stage, layout.Resources); }
            }
        }
        private static string RemoveInstallation(Layout layout, bool repair)
        {
            byte[] current = File.ReadAllBytes(layout.Archive); var host = TryHost(current); var manifest = Manifest(layout);
            if (host != null)
            {
                if (!Directory.Exists(layout.Mod) && !File.Exists(layout.Backup)) return "Мод уже удалён. Lolka " + host.Version + " сохранена.";
                Transaction(layout, current, null, null, true, Hash(current), null);
                return "Мод удалён. Текущая Lolka " + host.Version + " сохранена без отката версии. Профиль пользователя сохранён.";
            }
            byte[] backup = VerifyBackup(layout, manifest);
            if (Hash(current) != StringValue(manifest, "shimHash"))
            {
                if (!repair) throw new IOException("ASAR изменён; используйте восстановление. Текущие файлы сохранены.");
                DurableWrite(Path.Combine(layout.Resources, "lolkamod-recovered-" + Guid.NewGuid().ToString("N") + ".asar"), current);
            }
            Transaction(layout, backup, null, null, false, Hash(current), Hash(backup));
            return "Lolka " + InspectHost(backup).Version + " восстановлена по проверенному backup, мод удалён. Профиль пользователя сохранён.";
        }
        public static string Uninstall(string installation)
        {
            var layout = new Layout(installation); using (Lock(layout)) { EnsureStopped(layout); Recover(layout); return RemoveInstallation(layout, false); }
        }
        public static string Repair(string installation)
        {
            var layout = new Layout(installation); using (Lock(layout)) { EnsureStopped(layout); Recover(layout); return RemoveInstallation(layout, true); }
        }
    }
}
