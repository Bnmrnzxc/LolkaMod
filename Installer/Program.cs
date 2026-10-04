using System;
using System.IO;
using System.Text;
using System.Windows.Forms;
using System.Web.Script.Serialization;

namespace LolkaModInstaller
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            if (args.Length == 0)
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new MainForm());
                return 0;
            }
            string report = null;
            for (int i = 0; i + 1 < args.Length; i++) if (args[i] == "--report") report = args[i + 1];
            try
            {
                if (args.Length < 2) throw new ArgumentException("Usage: --status|--install|--uninstall|--repair <Lolka folder> [--report <JSON>]");
                string result;
                InstallerBackend.InstallStatus status = null;
                switch (args[0])
                {
                    case "--status": status = InstallerBackend.InspectStatus(args[1]); result = status.Message; break;
                    case "--install":
                        string profile = null;
                        for (int i = 2; i + 1 < args.Length; i++) if (args[i] == "--test-user-data") profile = args[i + 1];
                        result = InstallerBackend.Install(args[1], profile); break;
                    case "--uninstall": result = InstallerBackend.Uninstall(args[1]); break;
                    case "--repair": result = InstallerBackend.Repair(args[1]); break;
                    case "--preview":
                        // Offscreen rendering for release QA; no window is shown or focused.
                        Application.EnableVisualStyles();
                        Application.SetCompatibleTextRenderingDefault(false);
                        using (var form = new MainForm())
                        {
                            string previewInstallation = null;
                            for (int i = 2; i + 1 < args.Length; i++) if (args[i] == "--installation") previewInstallation = args[i + 1];
                            if (previewInstallation != null) form.PreparePreview(previewInstallation);
                            var create = typeof(Control).GetMethod("CreateControl", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic,
                                null, new[] { typeof(bool) }, null);
                            if (create == null) throw new InvalidOperationException("Offscreen control creation unavailable.");
                            create.Invoke(form, new object[] { true }); form.PerformLayout();
                            using (var bitmap = new System.Drawing.Bitmap(form.Width, form.Height))
                            {
                                form.DrawToBitmap(bitmap, new System.Drawing.Rectangle(0, 0, form.Width, form.Height));
                                bitmap.Save(Path.GetFullPath(args[1]), System.Drawing.Imaging.ImageFormat.Png);
                            }
                        }
                        result = "Offscreen installer preview saved."; break;
                    default: throw new ArgumentException("Unknown operation");
                }
                WriteReport(report, true, result, status);
                return 0;
            }
            catch (Exception error) { WriteReport(report, false, error.Message); return 1; }
        }
        private static void WriteReport(string path, bool ok, string result, InstallerBackend.InstallStatus status = null)
        {
            string json = new JavaScriptSerializer().Serialize(new { ok = ok, result = result, version = InstallerBackend.ModVersion, status = status });
            if (path != null) File.WriteAllText(Path.GetFullPath(path), json, new UTF8Encoding(false));
            else Console.WriteLine(json);
        }
    }
}
