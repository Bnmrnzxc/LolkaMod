using System;
using System.IO;
using System.Reflection;
using System.Text;
using System.Web.Script.Serialization;

namespace LolkaModInstaller
{
    internal static class InstallerUpdatesHarness
    {
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

        private static object Run(string[] args)
        {
            if (args.Length == 0) throw new ArgumentException("Missing mode");
            switch (args[0])
            {
                case "parse":
                {
                    var release = InstallerUpdates.ParseRelease(Console.In.ReadToEnd());
                    return new { ok = true, release.Version, release.AssetUrl, release.AssetSha256, release.AssetSize };
                }
                case "compare":
                    if (args.Length != 3) throw new ArgumentException("compare expects two versions");
                    return new { ok = true, result = InstallerUpdates.CompareVersions(args[1], args[2]) };
                case "quote":
                    return new { ok = true, result = InstallerUpdates.QuoteArgument(Json.Deserialize<string>(Console.In.ReadToEnd())) };
                case "verify":
                {
                    if (args.Length != 2) throw new ArgumentException("verify expects a fixture path");
                    var release = InstallerUpdates.ParseRelease(Console.In.ReadToEnd());
                    InstallerUpdates.VerifyInstaller(args[1], release);
                    return new { ok = true };
                }
                case "verify-end":
                {
                    if (args.Length != 2) throw new ArgumentException("verify-end expects a fixture path");
                    var release = InstallerUpdates.ParseRelease(Console.In.ReadToEnd());
                    using (var stream = new FileStream(args[1], FileMode.Open, FileAccess.ReadWrite, FileShare.Read))
                    {
                        stream.Position = stream.Length;
                        var method = typeof(InstallerUpdates).GetMethod("VerifyStream", BindingFlags.Static | BindingFlags.NonPublic);
                        method.Invoke(null, new object[] { stream, release });
                    }
                    return new { ok = true };
                }
                case "uri":
                {
                    var value = Json.DeserializeObject(Console.In.ReadToEnd()) as System.Collections.Generic.Dictionary<string, object>;
                    if (value == null || !(value["url"] is string) || !(value["redirected"] is bool))
                        throw new ArgumentException("Invalid URI input");
                    Uri uri;
                    var valid = Uri.TryCreate((string)value["url"], UriKind.Absolute, out uri) &&
                        InstallerUpdates.IsAllowedAssetUri(uri, (bool)value["redirected"]);
                    return new { ok = true, allowed = valid };
                }
                default: throw new ArgumentException("Unknown mode");
            }
        }

        private static int Main(string[] args)
        {
            try { Console.Out.Write(Json.Serialize(Run(args))); return 0; }
            catch { Console.Out.Write(Json.Serialize(new { ok = false })); return 2; }
        }
    }
}
