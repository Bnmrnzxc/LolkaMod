using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

namespace LolkaModInstaller
{
    internal sealed class UpdateRelease
    {
        public string Version, AssetUrl, AssetSha256;
        public long AssetSize;
    }

    // Public stable releases only. Checking never downloads or runs executable code.
    internal static class InstallerUpdates
    {
        internal const string Feed = "https://api.github.com/repos/Bnmrnzxc/LolkaMod/releases/latest";
        private const string Repository = "https://github.com/Bnmrnzxc/LolkaMod/releases/";
        private const int MetadataLimit = 512 * 1024;
        private const long InstallerLimit = 64 * 1024 * 1024;
        private static readonly Regex Semver = new Regex(@"\Av?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?\z", RegexOptions.CultureInvariant);

        private static Match Version(string value)
        {
            if (String.IsNullOrEmpty(value) || value.Length > 128) throw InvalidRelease();
            Match match = Semver.Match(value);
            if (!match.Success) throw InvalidRelease();
            foreach (int group in new[] { 4, 5 })
                if (match.Groups[group].Success)
                    foreach (string part in match.Groups[group].Value.Split('.'))
                        if (part.Length == 0 || group == 4 && Regex.IsMatch(part, @"^[0-9]+$") && part.Length > 1 && part[0] == '0') throw InvalidRelease();
            return match;
        }
        private static int CompareNumber(string a, string b)
        {
            if (a.Length != b.Length) return a.Length.CompareTo(b.Length);
            return String.CompareOrdinal(a, b);
        }
        internal static int CompareVersions(string left, string right)
        {
            Match a = Version(left), b = Version(right);
            for (int i = 1; i <= 3; i++)
            { int difference = CompareNumber(a.Groups[i].Value, b.Groups[i].Value); if (difference != 0) return difference; }
            string[] ap = a.Groups[4].Success ? a.Groups[4].Value.Split('.') : new string[0];
            string[] bp = b.Groups[4].Success ? b.Groups[4].Value.Split('.') : new string[0];
            if (ap.Length == 0 || bp.Length == 0) return ap.Length == bp.Length ? 0 : ap.Length == 0 ? 1 : -1;
            for (int i = 0; i < Math.Max(ap.Length, bp.Length); i++)
            {
                if (i >= ap.Length || i >= bp.Length) return i >= ap.Length ? -1 : 1;
                bool an = Regex.IsMatch(ap[i], @"^[0-9]+$"), bn = Regex.IsMatch(bp[i], @"^[0-9]+$");
                int difference = an && bn ? CompareNumber(ap[i], bp[i]) : an != bn ? (an ? -1 : 1) : String.CompareOrdinal(ap[i], bp[i]);
                if (difference != 0) return difference;
            }
            return 0;
        }

        private static InvalidDataException InvalidRelease()
        { return new InvalidDataException("Данные обновления не прошли проверку. Файлы Lolka не изменены."); }
        private static string Field(Dictionary<string, object> value, string key)
        { object item; return value.TryGetValue(key, out item) ? item as string : null; }
        private static bool IsFalse(Dictionary<string, object> value, string key)
        { object item; return value.TryGetValue(key, out item) && item is bool && !(bool)item; }
        internal static UpdateRelease ParseRelease(string json)
        {
            if (json == null || Encoding.UTF8.GetByteCount(json) > MetadataLimit) throw InvalidRelease();
            Dictionary<string, object> data;
            try { data = new JavaScriptSerializer { MaxJsonLength = MetadataLimit, RecursionLimit = 32 }.DeserializeObject(json) as Dictionary<string, object>; }
            catch (ArgumentException) { throw InvalidRelease(); }
            catch (InvalidOperationException) { throw InvalidRelease(); }
            if (data == null || !IsFalse(data, "draft") || !IsFalse(data, "prerelease")) throw InvalidRelease();
            string tag = Field(data, "tag_name");
            Match version = Version(tag);
            if (!tag.StartsWith("v", StringComparison.Ordinal) || version.Groups[4].Success || version.Groups[5].Success || Field(data, "html_url") != Repository + "tag/" + tag) throw InvalidRelease();
            object rawAssets;
            if (!data.TryGetValue("assets", out rawAssets) || !(rawAssets is object[])) throw InvalidRelease();
            UpdateRelease result = null;
            foreach (object rawAsset in (object[])rawAssets)
            {
                Dictionary<string, object> asset = rawAsset as Dictionary<string, object>;
                if (asset == null || Field(asset, "name") != "LolkaModInstaller.exe") continue;
                if (result != null || Field(asset, "state") != "uploaded") throw InvalidRelease();
                string url = Field(asset, "browser_download_url"), digest = Field(asset, "digest");
                object rawSize; long size;
                if (!asset.TryGetValue("size", out rawSize) || !(rawSize is int || rawSize is long) || !Int64.TryParse(Convert.ToString(rawSize, System.Globalization.CultureInfo.InvariantCulture), out size) || size < 2 || size > InstallerLimit) throw InvalidRelease();
                if (url != Repository + "download/" + tag + "/LolkaModInstaller.exe" || digest == null || !Regex.IsMatch(digest, @"\Asha256:[a-f0-9]{64}\z")) throw InvalidRelease();
                result = new UpdateRelease { Version = tag.Substring(1), AssetUrl = url, AssetSha256 = digest.Substring(7), AssetSize = size };
            }
            if (result == null) throw InvalidRelease();
            return result;
        }
        internal static bool IsAllowedAssetUri(Uri uri, bool redirected)
        {
            if (uri == null || !uri.IsAbsoluteUri || uri.Scheme != "https" || uri.Port != 443 || uri.UserInfo.Length != 0 || uri.Fragment.Length != 0) return false;
            if (redirected && uri.Host == "release-assets.githubusercontent.com") return true;
            if (uri.Host != "github.com" || uri.Query.Length != 0) return false;
            string prefix = "/Bnmrnzxc/LolkaMod/releases/download/";
            if (!uri.AbsolutePath.StartsWith(prefix, StringComparison.Ordinal)) return false;
            string[] path = uri.AbsolutePath.Substring(prefix.Length).Split('/');
            if (path.Length != 2 || path[1] != "LolkaModInstaller.exe") return false;
            try { Match version = Version(path[0]); return path[0].StartsWith("v", StringComparison.Ordinal) && !version.Groups[4].Success && !version.Groups[5].Success; }
            catch (InvalidDataException) { return false; }
        }
        internal static UpdateRelease Check(CancellationToken cancellation)
        {
            using (MemoryStream buffer = new MemoryStream())
            {
                DownloadBytes(new Uri(Feed), false, MetadataLimit, null, buffer, cancellation, null);
                return ParseRelease(new UTF8Encoding(false, true).GetString(buffer.ToArray()));
            }
        }

        private static void DownloadBytes(Uri initial, bool asset, long limit, long? expectedSize, Stream output, CancellationToken cancellation, Action<int> progress)
        {
            Uri current = initial;
            Stopwatch elapsed = Stopwatch.StartNew();
            // This application targets CLR 4; its legacy networking defaults omit TLS 1.2.
            ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072;
            for (int redirects = 0; redirects <= 3; redirects++)
            {
                cancellation.ThrowIfCancellationRequested();
                if (asset ? !IsAllowedAssetUri(current, redirects != 0) : current.AbsoluteUri != Feed) throw InvalidRelease();
                if (elapsed.ElapsedMilliseconds >= (asset ? 60000 : 10000)) throw new WebException("Время ожидания обновления истекло.", WebExceptionStatus.Timeout);
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(current);
                request.AllowAutoRedirect = false;
                request.Timeout = Math.Min(10000, (asset ? 60000 : 10000) - (int)elapsed.ElapsedMilliseconds);
                request.ReadWriteTimeout = 10000;
                request.UserAgent = "LolkaModInstaller";
                request.Accept = asset ? "application/octet-stream" : "application/vnd.github+json";
                if (!asset) request.Headers["X-GitHub-Api-Version"] = "2022-11-28";
                request.UseDefaultCredentials = false;
                request.CachePolicy = new System.Net.Cache.RequestCachePolicy(System.Net.Cache.RequestCacheLevel.NoCacheNoStore);
                using (cancellation.Register(request.Abort))
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    int status = (int)response.StatusCode;
                    if (asset && (status == 301 || status == 302 || status == 303 || status == 307 || status == 308))
                    {
                        Uri next;
                        if (redirects == 3 || !Uri.TryCreate(current, response.Headers["Location"], out next) || !IsAllowedAssetUri(next, true)) throw InvalidRelease();
                        // A GitHub-to-GitHub redirect cannot select a different release.
                        if (next.Host == "github.com" && next.AbsoluteUri != initial.AbsoluteUri) throw InvalidRelease();
                        current = next; continue;
                    }
                    if (status != 200 || response.ContentLength > limit || expectedSize.HasValue && response.ContentLength >= 0 && response.ContentLength != expectedSize.Value) throw InvalidRelease();
                    using (Stream input = response.GetResponseStream())
                    {
                        byte[] bytes = new byte[32768]; long received = 0; int count;
                        while ((count = input.Read(bytes, 0, bytes.Length)) > 0)
                        {
                            cancellation.ThrowIfCancellationRequested();
                            if (elapsed.ElapsedMilliseconds > (asset ? 60000 : 10000)) throw new WebException("Время ожидания обновления истекло.", WebExceptionStatus.Timeout);
                            received += count;
                            if (received > limit || expectedSize.HasValue && received > expectedSize.Value) throw InvalidRelease();
                            output.Write(bytes, 0, count);
                            if (progress != null && expectedSize.HasValue) progress((int)(received * 100 / expectedSize.Value));
                        }
                        if (expectedSize.HasValue && received != expectedSize.Value) throw InvalidRelease();
                        return;
                    }
                }
            }
            throw InvalidRelease();
        }
        internal static void VerifyInstaller(string file, UpdateRelease release)
        {
            using (FileStream stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read)) VerifyStream(stream, release);
        }
        private static void VerifyStream(FileStream stream, UpdateRelease release)
        {
            stream.Position = 0;
            if (release == null || release.AssetSize < 2 || release.AssetSize > InstallerLimit || stream.Length != release.AssetSize || stream.ReadByte() != 'M' || stream.ReadByte() != 'Z') throw InvalidRelease();
            stream.Position = 0;
            string hash;
            using (SHA256 sha = SHA256.Create()) hash = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
            if (hash != release.AssetSha256) throw InvalidRelease();
        }
        internal static string Download(UpdateRelease release, CancellationToken cancellation, Action<int> progress)
        {
            // Only the selected official asset may supply a filename or executable.
            Match version = Version(release.Version);
            if (version.Groups[4].Success || version.Groups[5].Success || release.Version.StartsWith("v", StringComparison.Ordinal) || release.AssetUrl != Repository + "download/v" + release.Version + "/LolkaModInstaller.exe" || !Regex.IsMatch(release.AssetSha256 ?? "", @"\A[a-f0-9]{64}\z") || release.AssetSize < 2 || release.AssetSize > InstallerLimit) throw InvalidRelease();
            string folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LolkaMod", "installer-updates");
            Directory.CreateDirectory(folder);
            if ((File.GetAttributes(folder) & FileAttributes.ReparsePoint) != 0) throw InvalidRelease();
            string target = Path.Combine(folder, "LolkaModInstaller-" + release.Version + "-" + release.AssetSha256 + ".exe");
            if (File.Exists(target))
            {
                try { VerifyInstaller(target, release); return target; }
                catch (InvalidDataException) { File.Delete(target); }
            }
            string temporary = Path.Combine(folder, Guid.NewGuid().ToString("N") + ".download");
            try
            {
                using (FileStream stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None))
                {
                    DownloadBytes(new Uri(release.AssetUrl), true, InstallerLimit, release.AssetSize, stream, cancellation, progress);
                    stream.Flush(true); VerifyStream(stream, release);
                }
                cancellation.ThrowIfCancellationRequested();
                if (File.Exists(target)) { VerifyInstaller(target, release); return target; }
                File.Move(temporary, target); return target;
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }
        internal static void OpenDownloaded(string file, UpdateRelease release, string installation)
        {
            // Hold the verified file against replacement until the child is running.
            using (FileStream stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                VerifyStream(stream, release);
                if (FileVersionInfo.GetVersionInfo(file).ProductVersion != release.Version) throw InvalidRelease();
                using (Process child = Process.Start(new ProcessStartInfo(file, "--open " + QuoteArgument(installation)) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(file) }))
                {
                    if (child == null) throw new IOException("Не удалось открыть новый установщик.");
                    // Detect an incompatible or rejected launch before closing the old window.
                    child.WaitForInputIdle(10000);
                    if (child.HasExited) throw new IOException("Новый установщик не запустился. Текущая версия остаётся доступной.");
                }
            }
        }
        internal static string QuoteArgument(string value)
        {
            if (value == null || value.IndexOf('\0') >= 0) throw new ArgumentException("Invalid installation path.");
            // Windows command-line escaping, including a final backslash before the quote.
            StringBuilder result = new StringBuilder("\""); int slashes = 0;
            foreach (char character in value)
            {
                if (character == '\\') { slashes++; continue; }
                result.Append('\\', character == '"' ? slashes * 2 + 1 : slashes);
                result.Append(character); slashes = 0;
            }
            result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
        }
    }
}
