using System;
using System.Net;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace LolkaModInstaller
{
    internal static class InstallerUpdateUIHarness
    {
        private static ApplicationContext context;
        private static MainForm currentForm;
        private static System.Windows.Forms.Timer pollTimer;
        private static string scenario;
        private static int launches, checksAtLaunch, promptsAtLaunch;
        private static bool closeStarted;

        [STAThread]
        private static int Main(string[] args)
        {
            if (args.Length != 1) throw new ArgumentException("Expected one scenario name.");
            scenario = args[0];
            ConfigureScenario(scenario);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            context = new ApplicationContext();
            Application.Idle += OnIdle;
            Application.Run(context);
            Console.WriteLine("{\"checks\":" + InstallerUpdates.CheckCalls +
                ",\"prompts\":" + UpdateDialog.PromptCalls +
                ",\"bundledPrompts\":" + UpdateDialog.BundledPromptCalls +
                ",\"remotePrompts\":" + UpdateDialog.RemotePromptCalls +
                ",\"lastCurrent\":\"" + Escape(UpdateDialog.LastCurrentVersion) + "\"" +
                ",\"lastLatest\":\"" + Escape(UpdateDialog.LastLatestVersion) + "\"" +
                ",\"downloads\":" + InstallerUpdates.DownloadCalls +
                ",\"opens\":" + InstallerUpdates.OpenCalls +
                ",\"installs\":" + InstallerBackend.InstallCalls +
                ",\"launches\":" + launches +
                ",\"buttonsEnabled\":" + InstallerUpdates.ButtonsEnabledAtEnd.ToString().ToLowerInvariant() + "}");
            return 0;
        }

        private static void ConfigureScenario(string name)
        {
            InstallerBackend.Reset();
            InstallerUpdates.Reset();
            UpdateDialog.Reset();
            UpdateDialog.NextResult = name == "update" || name == "local-update" ? DialogResult.OK : DialogResult.Cancel;
            if (name == "equal") InstallerUpdates.LatestVersion = InstallerBackend.ModVersion;
            else if (name == "older") InstallerUpdates.LatestVersion = "0.5.3";
            else if (name == "local-update" || name == "local-twice" || name == "local-offline" || name == "local-current") InstallerUpdates.LatestVersion = InstallerBackend.ModVersion;
            else if (name == "installed-ahead") InstallerUpdates.LatestVersion = "0.5.5-preview.3";
            else InstallerUpdates.LatestVersion = "0.6.0";
            InstallerUpdates.Offline = name == "offline" || name == "local-offline";
            InstallerUpdates.WaitForCancellation = name == "close-cancel";
            if (name == "local-update" || name == "local-twice" || name == "local-offline")
                InstallerBackend.ConfigureInstalled("0.5.4-preview.3");
            else if (name == "local-current") InstallerBackend.ConfigureInstalled(InstallerBackend.ModVersion);
            else if (name == "installed-ahead") InstallerBackend.ConfigureInstalled("0.5.6-preview.1");
        }

        private static void OnIdle(object sender, EventArgs e)
        {
            Application.Idle -= OnIdle;
            if (scenario == "twice" || scenario == "local-twice")
            {
                StartLaunch();
                StartPolling(delegate
                {
                    if (IsIdle())
                    {
                        checksAtLaunch = InstallerUpdates.CheckCalls;
                        promptsAtLaunch = UpdateDialog.PromptCalls;
                        DisposeCurrent();
                        StartLaunch();
                        StartPolling(FinishTwice);
                    }
                });
                return;
            }

            StartLaunch();
            StartPolling(delegate
            {
                if (scenario == "close-cancel" && InstallerUpdates.CheckCalls > 0 && !closeStarted)
                {
                    closeStarted = true;
                    currentForm.Close();
                }
                if (IsIdle()) Complete();
            });
        }

        private static void StartLaunch()
        {
            launches++;
            currentForm = new MainForm("harness-installation");
            MethodInfo create = typeof(Control).GetMethod("CreateControl", BindingFlags.Instance | BindingFlags.NonPublic,
                null, new[] { typeof(bool) }, null);
            if (create == null) throw new InvalidOperationException("Hidden control creation is unavailable.");
            create.Invoke(currentForm, new object[] { true });
            currentForm.PerformLayout();
            MethodInfo shown = typeof(MainForm).GetMethod("OnShown", BindingFlags.Instance | BindingFlags.NonPublic,
                null, new[] { typeof(object), typeof(EventArgs) }, null);
            if (shown == null) throw new InvalidOperationException("MainForm.OnShown was not found.");
            shown.Invoke(currentForm, new object[] { currentForm, EventArgs.Empty });
        }

        private static void StartPolling(Action tick)
        {
            StopPolling();
            pollTimer = new System.Windows.Forms.Timer();
            pollTimer.Interval = 10;
            pollTimer.Tick += delegate
            {
                try { tick(); }
                catch (Exception error) { Fail(error); }
            };
            pollTimer.Start();
        }

        private static bool IsIdle()
        {
            if (currentForm == null || currentForm.IsDisposed) return true;
            return !ReadBool(currentForm, "busy") && !ReadBool(currentForm, "updateCheckBusy") && !ReadBool(currentForm, "downloading");
        }

        private static bool ReadBool(object target, string fieldName)
        {
            FieldInfo field = target.GetType().GetField(fieldName, BindingFlags.Instance | BindingFlags.NonPublic);
            if (field == null) throw new InvalidOperationException("Expected MainForm field was not found: " + fieldName);
            return (bool)field.GetValue(target);
        }

        private static bool InstallButtonEnabled()
        {
            FieldInfo field = typeof(MainForm).GetField("installButton", BindingFlags.Instance | BindingFlags.NonPublic);
            if (field == null) throw new InvalidOperationException("MainForm.installButton was not found.");
            return ((Control)field.GetValue(currentForm)).Enabled;
        }

        private static void FinishTwice()
        {
            if (!IsIdle()) return;
            if (InstallerUpdates.CheckCalls != checksAtLaunch + 1 || UpdateDialog.PromptCalls != promptsAtLaunch + 1)
                throw new InvalidOperationException("Each independent launch must check and prompt again.");
            if (InstallerUpdates.DownloadCalls != 0 || InstallerUpdates.OpenCalls != 0 || InstallerBackend.InstallCalls != 0)
                throw new InvalidOperationException("Skip must not download or open an installer.");
            InstallerUpdates.ButtonsEnabledAtEnd = InstallButtonEnabled();
            DisposeCurrent();
            Complete();
        }

        private static void Complete()
        {
            StopPolling();
            if (scenario != "twice") InstallerUpdates.ButtonsEnabledAtEnd = InstallButtonEnabled();
            DisposeCurrent();
            context.ExitThread();
        }

        private static string Escape(string value)
        {
            return (value ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"");
        }

        private static void DisposeCurrent()
        {
            if (currentForm != null)
            {
                currentForm.Dispose();
                currentForm = null;
            }
        }

        private static void StopPolling()
        {
            if (pollTimer != null) { pollTimer.Stop(); pollTimer.Dispose(); pollTimer = null; }
        }

        private static void Fail(Exception error)
        {
            StopPolling();
            Console.Error.WriteLine(error.ToString());
            DisposeCurrent();
            context.ExitThread();
            Environment.ExitCode = 1;
        }
    }

    internal static class InstallerBackend
    {
        internal const string ModVersion = "0.5.5-preview.2";
        internal static string InstalledModVersion;
        internal static int InstallCalls;
        internal sealed class InstallStatus
        {
            internal bool ModInstalled;
            internal bool RecoveryPending;
            internal bool NeedsRepatch;
            internal bool ClientFound;
            internal bool BackupVerified;
            internal string HostVersion;
            internal string InstalledModVersion;
            internal string Message;
        }

        internal static string DefaultInstallation { get { return "harness-installation"; } }
        internal static void Reset() { InstalledModVersion = null; InstallCalls = 0; }
        internal static void ConfigureInstalled(string version) { InstalledModVersion = version; }
        internal static string Status(string path) { return "Harness client status."; }
        internal static InstallStatus InspectStatus(string path)
        {
            return new InstallStatus { ClientFound = true, ModInstalled = InstalledModVersion != null,
                InstalledModVersion = InstalledModVersion, HostVersion = "1.0.120", Message = "Harness client status." };
        }
        internal static string Install(string path)
        {
            Interlocked.Increment(ref InstallCalls);
            InstalledModVersion = ModVersion;
            return "Harness install.";
        }
        internal static string Uninstall(string path) { return "Harness uninstall."; }
        internal static string Repair(string path) { return "Harness repair."; }
    }

    internal sealed class UpdateRelease
    {
        internal string Version;
    }

    internal static class InstallerUpdates
    {
        internal static string LatestVersion;
        internal static bool Offline, WaitForCancellation, ButtonsEnabledAtEnd;
        internal static int CheckCalls, DownloadCalls, OpenCalls;

        internal static void Reset()
        {
            LatestVersion = "0.6.0"; Offline = false; WaitForCancellation = false;
            ButtonsEnabledAtEnd = false; CheckCalls = DownloadCalls = OpenCalls = 0;
        }
        internal static int CompareVersions(string left, string right)
        {
            string[] a = left.Split('+')[0].Split('-'), b = right.Split('+')[0].Split('-');
            Version av, bv;
            if (!Version.TryParse(a[0], out av) || !Version.TryParse(b[0], out bv)) throw new InvalidOperationException("Invalid test version.");
            int core = av.CompareTo(bv); if (core != 0) return core;
            if (a.Length == 1 || b.Length == 1) return a.Length == b.Length ? 0 : a.Length == 1 ? 1 : -1;
            string[] ap = a[1].Split('.'), bp = b[1].Split('.');
            for (int i = 0; i < Math.Max(ap.Length, bp.Length); i++)
            {
                if (i >= ap.Length || i >= bp.Length) return i >= ap.Length ? -1 : 1;
                long an, bn; bool numericA = Int64.TryParse(ap[i], out an), numericB = Int64.TryParse(bp[i], out bn);
                int difference = numericA && numericB ? an.CompareTo(bn) : numericA != numericB ? (numericA ? -1 : 1) : String.CompareOrdinal(ap[i], bp[i]);
                if (difference != 0) return difference;
            }
            return 0;
        }
        internal static UpdateRelease Check(CancellationToken token)
        {
            Interlocked.Increment(ref CheckCalls);
            if (WaitForCancellation)
            {
                while (!token.IsCancellationRequested) Thread.Sleep(5);
                token.ThrowIfCancellationRequested();
            }
            if (Offline) throw new WebException("Harness offline.");
            token.ThrowIfCancellationRequested();
            return new UpdateRelease { Version = LatestVersion };
        }
        internal static string Download(UpdateRelease release, CancellationToken token, Action<int> progress)
        {
            Interlocked.Increment(ref DownloadCalls);
            token.ThrowIfCancellationRequested();
            if (progress != null) progress(100);
            return "harness-update.exe";
        }
        internal static void OpenDownloaded(string file, UpdateRelease release, string installation)
        {
            Interlocked.Increment(ref OpenCalls);
        }
    }

    internal sealed class UpdateDialog : IDisposable
    {
        internal static DialogResult NextResult;
        internal static int PromptCalls, BundledPromptCalls, RemotePromptCalls;
        internal static string LastCurrentVersion, LastLatestVersion;
        private readonly bool bundled;
        internal UpdateDialog(string currentVersion, string latestVersion, bool isBundled)
        {
            LastCurrentVersion = currentVersion; LastLatestVersion = latestVersion; bundled = isBundled;
        }
        internal DialogResult ShowDialog(IWin32Window owner)
        {
            Interlocked.Increment(ref PromptCalls);
            if (bundled) Interlocked.Increment(ref BundledPromptCalls); else Interlocked.Increment(ref RemotePromptCalls);
            return NextResult;
        }
        internal static void Reset()
        {
            NextResult = DialogResult.Cancel; PromptCalls = BundledPromptCalls = RemotePromptCalls = 0;
            LastCurrentVersion = LastLatestVersion = null;
        }
        public void Dispose() { }
    }
}
