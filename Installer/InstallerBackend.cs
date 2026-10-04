using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

namespace LolkaModInstaller
{
    public static class InstallerBackend
    {
        public const string ModVersion = "0.3.0";
        private const string OriginalHash = "fd94ecec264d7d7a56a0b5d1bb5ac1e416b6c9a4ee2d171b3704b0b72f0260a8";
        private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
        public static string DefaultInstallation { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Lolka"); } }

        private sealed class Layout
        {
            public string Root, Resources, Archive, Backup, Mod;
            public Layout(string installation)
            {
                if (String.IsNullOrWhiteSpace(installation)) throw new IOException("Выберите папку Lolka.");
                Root = Path.GetFullPath(installation).TrimEnd(Path.DirectorySeparatorChar);
                Resources = Path.Combine(Root, "resources");
                Archive = Path.Combine(Resources, "app.asar");
                Backup = Path.Combine(Resources, "_app.asar");
                Mod = Path.Combine(Resources, "lolkamod");
                if (!Directory.Exists(Resources) || !File.Exists(Archive)) throw new IOException("В папке нет resources/app.asar. Установите Lolka и выберите её папку.");
                for (var folder = new DirectoryInfo(Root); folder != null; folder = folder.Parent) NoLink(folder.FullName);
                NoLink(Resources); NoLink(Archive);
                if (File.Exists(Backup)) NoLink(Backup);
                if (Directory.Exists(Mod)) NoLink(Mod);
            }
        }
        private static Dictionary<string, object> Json(string text)
        {
            var serializer = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024, RecursionLimit = 128 };
            var value = serializer.DeserializeObject(text) as Dictionary<string, object>;
            if (value == null) throw new IOException("Некорректный JSON.");
            return value;
        }
        private static string StringValue(Dictionary<string, object> data, string key)
        {
            object value; return data.TryGetValue(key, out value) ? value as string : null;
        }
        private static void WriteJson(string path, object value) { File.WriteAllText(path, new JavaScriptSerializer().Serialize(value), Utf8); }
        private static string Hash(byte[] bytes)
        {
            using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
        }
        private static string FileHash(string path) { return Hash(File.ReadAllBytes(path)); }
        private static void NoLink(string path)
        {
            if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new IOException("Путь через symbolic link/junction не поддерживается: " + path);
        }
        private static FileStream Lock(Layout layout)
        {
            var path = Path.Combine(layout.Resources, ".lolkamod-install.lock");
            if (File.Exists(path)) NoLink(path);
            return new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None, 1, FileOptions.DeleteOnClose);
        }
        private static void EnsureStopped(Layout layout)
        {
            string executable = Path.Combine(layout.Root, "Lolka.exe");
            foreach (var process in Process.GetProcessesByName("Lolka"))
            {
                using (process)
                {
                    try
                    {
                        if (process.HasExited) continue;
                        if (String.Equals(process.MainModule.FileName, executable, StringComparison.OrdinalIgnoreCase))
                            throw new IOException("Закройте Lolka, включая значок в трее, и повторите операцию.");
                    }
                    catch (System.ComponentModel.Win32Exception)
                    {
                        if (!process.HasExited) throw new IOException("Не удалось проверить запущенный процесс Lolka. Закройте клиент и повторите.");
                    }
                    catch (InvalidOperationException) { /* Process exited during enumeration. */ }
                }
            }
        }
        private static Dictionary<string, object> Manifest(Layout layout)
        {
            if (!Directory.Exists(layout.Mod)) return null;
            string path = Path.Combine(layout.Mod, "install.json");
            if (!File.Exists(path)) throw new IOException("Незавершённая установка. Используйте «Восстановить Lolka».");
            NoLink(path);
            var manifest = Json(File.ReadAllText(path, Utf8));
            if (StringValue(manifest, "originalHash") != OriginalHash) throw new IOException("Неизвестная установка мода. Файлы сохранены.");
            return manifest;
        }
        private static void VerifyBackup(Layout layout)
        {
            if (!File.Exists(layout.Backup) || FileHash(layout.Backup) != OriginalHash) throw new IOException("Резервная копия original ASAR отсутствует или повреждена. Переустановите Lolka.");
        }
        private static void SafeDeleteTree(string path, string expectedParent)
        {
            if (!String.Equals(Path.GetDirectoryName(Path.GetFullPath(path)), Path.GetFullPath(expectedParent), StringComparison.OrdinalIgnoreCase)) throw new IOException("Небезопасный путь удаления.");
            if (!Directory.Exists(path)) return;
            NoLink(path);
            // Check every child before a recursive delete; never traverse reparse points.
            foreach (var child in Directory.GetFileSystemEntries(path))
            {
                NoLink(child);
                if (Directory.Exists(child)) CheckTree(child);
            }
            Directory.Delete(path, true);
        }
        private static void CheckTree(string path)
        {
            foreach (var child in Directory.GetFileSystemEntries(path)) { NoLink(child); if (Directory.Exists(child)) CheckTree(child); }
        }
        private static void ReplaceArchive(Layout layout, byte[] bytes, string expectedHash)
        {
            if (Hash(bytes) != expectedHash) throw new IOException("Replacement ASAR hash mismatch.");
            string stage = Path.Combine(layout.Resources, ".lolkamod-entry-" + Guid.NewGuid().ToString("N") + ".tmp");
            string replaced = stage + ".previous";
            bool swapped = false, verified = false;
            try
            {
                using (var stream = new FileStream(stage, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { stream.Write(bytes, 0, bytes.Length); stream.Flush(true); }
                if (FileHash(stage) != expectedHash) throw new IOException("Staged ASAR hash mismatch.");
                EnsureStopped(layout);
                File.Replace(stage, layout.Archive, replaced);
                swapped = true;
                if (FileHash(layout.Archive) != expectedHash) throw new IOException("ASAR verification failed.");
                verified = true;
            }
            catch
            {
                if (swapped && File.Exists(replaced))
                {
                    File.Replace(replaced, layout.Archive, stage);
                    swapped = false;
                }
                throw;
            }
            finally
            {
                // Cleanup errors cannot turn a verified committed replacement into a failed install.
                if (verified || !swapped)
                {
                    try { if (File.Exists(stage)) File.Delete(stage); } catch (IOException) { } catch (UnauthorizedAccessException) { }
                    try { if (File.Exists(replaced)) File.Delete(replaced); } catch (IOException) { } catch (UnauthorizedAccessException) { }
                }
            }
        }
        private static byte[] ReadAsar(byte[] archive, string file)
        {
            if (archive.Length < 16 || BitConverter.ToUInt32(archive, 0) != 4) throw new IOException("Некорректный ASAR.");
            uint headerSize = BitConverter.ToUInt32(archive, 4), jsonSize = BitConverter.ToUInt32(archive, 12);
            long start = 8L + headerSize;
            if (headerSize < 8 || jsonSize > headerSize - 8 || start > archive.LongLength || jsonSize > 16 * 1024 * 1024) throw new IOException("Некорректный ASAR header.");
            var current = Json(Utf8.GetString(archive, 16, checked((int)jsonSize)));
            foreach (var component in file.Split('/'))
            {
                object files, node;
                if (!current.TryGetValue("files", out files) || !((Dictionary<string, object>)files).TryGetValue(component, out node)) throw new IOException("ASAR entry missing: " + file);
                current = node as Dictionary<string, object>;
                if (current == null) throw new IOException("Некорректная ASAR entry.");
            }
            long offset; object sizeValue;
            if (!Int64.TryParse(StringValue(current, "offset"), out offset) || !current.TryGetValue("size", out sizeValue)) throw new IOException("Unsupported ASAR entry.");
            long size = Convert.ToInt64(sizeValue);
            if (offset < 0 || size < 0 || size > 16 * 1024 * 1024 || start + offset + size > archive.LongLength) throw new IOException("ASAR entry out of bounds.");
            byte[] result = new byte[checked((int)size)];
            Buffer.BlockCopy(archive, checked((int)(start + offset)), result, 0, result.Length);
            return result;
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
            using (var archive = new ZipArchive(new MemoryStream(bytes), ZipArchiveMode.Read))
            {
                foreach (string name in new[] { "main.cjs", "preload.js", "build.json", "shim.asar" })
                {
                    var entry = archive.GetEntry(name);
                    if (entry == null || entry.Length > 16 * 1024 * 1024) throw new IOException("Installer entry missing/too large: " + name);
                    using (var stream = entry.Open()) using (var output = new MemoryStream()) { stream.CopyTo(output); files.Add(name, output.ToArray()); }
                }
            }
            if (StringValue(Json(Utf8.GetString(files["build.json"])), "version") != ModVersion) throw new IOException("Installer/mod version mismatch.");
            return files;
        }
        public static string Status(string installation)
        {
            var layout = new Layout(installation);
            string current = FileHash(layout.Archive);
            var manifest = Manifest(layout);
            if (current == OriginalHash && manifest == null && !File.Exists(layout.Backup)) return "Lolka 1.0.120 совместима. Мод не установлен.";
            if (manifest != null && current == StringValue(manifest, "shimHash"))
            {
                VerifyBackup(layout);
                return "Установлен LolkaMod " + StringValue(manifest, "modVersion") + ". Backup проверен. Автообновления Lolka приостановлены.\r\n1440p: экспериментальный режим, нужен тест со зрителем.";
            }
            return "ASAR или установка изменены. Файлы сохранены; используйте восстановление или переустановите Lolka.";
        }
        public static string Install(string installation) { return Install(installation, null); }
        public static string Install(string installation, string testUserData)
        {
            var layout = new Layout(installation);
            using (Lock(layout))
            {
                EnsureStopped(layout);
                byte[] previousEntry = File.ReadAllBytes(layout.Archive);
                string currentHash = Hash(previousEntry);
                var oldManifest = Manifest(layout);
                bool upgrade = oldManifest != null;
                if (upgrade)
                {
                    VerifyBackup(layout);
                    if (currentHash != StringValue(oldManifest, "shimHash")) throw new IOException("ASAR изменён после установки. Сначала восстановите Lolka.");
                }
                else if (currentHash != OriginalHash || File.Exists(layout.Backup)) throw new IOException("Поддерживается только original Lolka 1.0.120. Неизвестные файлы сохранены.");
                byte[] original = File.ReadAllBytes(upgrade ? layout.Backup : layout.Archive);
                if (Hash(original) != OriginalHash) throw new IOException("Original ASAR hash mismatch.");
                string originalPreload = Utf8.GetString(ReadAsar(original, "dist-js/preload.js"));
                var host = Json(Utf8.GetString(ReadAsar(original, "package.json")));
                if (StringValue(host, "version") != "1.0.120") throw new IOException("Unsupported host version.");
                var payload = Payload();
                string stage = Path.Combine(layout.Resources, ".lolkamod-stage-" + Guid.NewGuid().ToString("N"));
                string nextMod = Path.Combine(stage, "next"), previousMod = Path.Combine(stage, "previous");
                bool newBackup = false, previousMoved = false, nextMoved = false, entryChanged = false, completed = false;
                Directory.CreateDirectory(nextMod);
                try
                {
                    File.WriteAllBytes(Path.Combine(nextMod, "main.cjs"), payload["main.cjs"]);
                    File.WriteAllBytes(Path.Combine(nextMod, "build.json"), payload["build.json"]);
                    File.WriteAllText(Path.Combine(nextMod, "preload.js"), "// Original preload retained in its own scope.\n(function(){\n" + originalPreload + "\n})();\n" + Utf8.GetString(payload["preload.js"]), Utf8);
                    var config = new Dictionary<string, object> { { "testMode", testUserData != null }, { "baseline", false } };
                    if (testUserData != null) config.Add("userData", Path.GetFullPath(testUserData));
                    // A normal GUI update never transfers a test configuration into a primary client.
                    WriteJson(Path.Combine(nextMod, "config.json"), config);
                    string shimHash = Hash(payload["shim.asar"]);
                    WriteJson(Path.Combine(nextMod, "install.json"), new { modVersion = ModVersion, hostVersion = "1.0.120", originalHash = OriginalHash, shimHash = shimHash, installedAt = DateTime.UtcNow.ToString("o"), testMode = testUserData != null });
                    if (!upgrade)
                    {
                        string stagedBackup = Path.Combine(stage, "original.asar");
                        using (var stream = new FileStream(stagedBackup, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { stream.Write(original, 0, original.Length); stream.Flush(true); }
                        if (FileHash(stagedBackup) != OriginalHash) throw new IOException("Staged backup hash mismatch.");
                        File.Move(stagedBackup, layout.Backup); newBackup = true; VerifyBackup(layout);
                    }
                    EnsureStopped(layout);
                    if (FileHash(layout.Archive) != currentHash) throw new IOException("ASAR changed while staging; operation aborted.");
                    if (upgrade) { CheckTree(layout.Mod); Directory.Move(layout.Mod, previousMod); previousMoved = true; }
                    Directory.Move(nextMod, layout.Mod); nextMoved = true;
                    entryChanged = true; ReplaceArchive(layout, payload["shim.asar"], shimHash);
                    VerifyBackup(layout);
                    if (FileHash(layout.Archive) != shimHash) throw new IOException("Installed entry hash mismatch.");
                    completed = true;
                    return "Установлен LolkaMod " + ModVersion + ". Управление качеством встроено в штатные настройки трансляции Lolka: доступны 720p/1080p/1440p и 30/60 FPS; настройки сохраняются после перезапуска. Отдельная кнопка LM и профиль мода не требуются.\r\nДля диагностики нажмите Ctrl+Shift+M. Автообновления Lolka приостановлены. Качество экспериментальное; проверка через SFU ещё не завершена.";
                }
                catch
                {
                    if (entryChanged) ReplaceArchive(layout, previousEntry, currentHash);
                    if (nextMoved) SafeDeleteTree(layout.Mod, layout.Resources);
                    if (previousMoved) Directory.Move(previousMod, layout.Mod);
                    if (newBackup && File.Exists(layout.Backup) && FileHash(layout.Archive) == OriginalHash && FileHash(layout.Backup) == OriginalHash) File.Delete(layout.Backup);
                    throw;
                }
                finally
                {
                    // Preserve a rollback directory if a rollback itself failed.
                    if (completed || !Directory.Exists(previousMod)) SafeDeleteTree(stage, layout.Resources);
                }
            }
        }
        public static string Uninstall(string installation)
        {
            var layout = new Layout(installation);
            using (Lock(layout))
            {
                EnsureStopped(layout);
                string current = FileHash(layout.Archive);
                var manifest = Manifest(layout);
                if (current == OriginalHash && manifest == null && !File.Exists(layout.Backup)) return "Мод уже удалён. Original Lolka восстановлена.";
                if (current != OriginalHash && (manifest == null || current != StringValue(manifest, "shimHash"))) throw new IOException("ASAR изменён; используйте восстановление. Текущие файлы сохранены.");
                if (File.Exists(layout.Backup)) VerifyBackup(layout);
                else if (current != OriginalHash) VerifyBackup(layout);
                if (current != OriginalHash) ReplaceArchive(layout, File.ReadAllBytes(layout.Backup), OriginalHash);
                SafeDeleteTree(layout.Mod, layout.Resources);
                if (File.Exists(layout.Backup)) File.Delete(layout.Backup);
                return "Original Lolka восстановлена, мод удалён. Штатный профиль и настройки мода сохранены.";
            }
        }
        public static string Repair(string installation)
        {
            var layout = new Layout(installation);
            using (Lock(layout))
            {
                EnsureStopped(layout); VerifyBackup(layout);
                if (FileHash(layout.Archive) != OriginalHash)
                {
                    File.Copy(layout.Archive, Path.Combine(layout.Resources, "lolkamod-recovered-" + Guid.NewGuid().ToString("N") + ".asar"), false);
                    ReplaceArchive(layout, File.ReadAllBytes(layout.Backup), OriginalHash);
                }
                SafeDeleteTree(layout.Mod, layout.Resources);
                File.Delete(layout.Backup);
                return "Lolka восстановлена по проверенному original ASAR. Предыдущий entry сохранён в resources/lolkamod-recovered-*.asar. Профиль пользователя сохранён.";
            }
        }
    }
}
