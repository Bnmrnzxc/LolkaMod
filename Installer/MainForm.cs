using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace LolkaModInstaller
{
    public class MainForm : Form
    {
        private static readonly Color WindowColor = Color.FromArgb(28, 29, 31);
        private static readonly Color CardColor = Color.FromArgb(39, 40, 43);
        private static readonly Color TextColor = Color.FromArgb(243, 244, 245);
        private static readonly Color MutedColor = Color.FromArgb(170, 175, 181);
        private static readonly Color AccentColor = Color.FromArgb(105, 188, 222);
        private readonly TextBox installationPathTextBox;
        private readonly TextBox statusTextBox;
        private readonly ModernButton browseButton, installButton, uninstallButton, repairButton, checkButton, detailsButton;
        private readonly StatusTile clientTile, modTile, versionTile;
        private readonly StatusBanner banner;
        private readonly RoundedPanel detailsPanel;
        private Image brandImage;
        private Icon brandIcon;
        private bool busy, detailsVisible;
        private bool updateCheckBusy, downloading;
        private InstallerBackend.InstallStatus lastInspection;
        private readonly CancellationTokenSource updateCancellation = new CancellationTokenSource();
        private int collapsedHeight;

        public MainForm() : this(null) { }
        public MainForm(string installation)
        {
            Text = "Установщик LolkaMod";
            StartPosition = FormStartPosition.CenterScreen;
            AutoScaleMode = AutoScaleMode.Dpi;
            AutoScaleDimensions = new SizeF(96F, 96F);
            ClientSize = new Size(624, 440);
            MinimumSize = new Size(620, 479);
            BackColor = WindowColor;
            ForeColor = TextColor;
            Font = new Font("Segoe UI", 9F, FontStyle.Regular, GraphicsUnit.Point);
            DoubleBuffered = true;
            LoadBrand();

            installationPathTextBox = new TextBox();
            installationPathTextBox.ReadOnly = true;
            installationPathTextBox.BorderStyle = BorderStyle.None;
            installationPathTextBox.BackColor = Color.FromArgb(30, 31, 33);
            installationPathTextBox.ForeColor = TextColor;
            installationPathTextBox.Dock = DockStyle.Fill;
            installationPathTextBox.Margin = Padding.Empty;
            installationPathTextBox.AccessibleName = "Папка установки Lolka";
            installationPathTextBox.TabIndex = 0;

            statusTextBox = new TextBox();
            statusTextBox.Multiline = true;
            statusTextBox.ReadOnly = true;
            statusTextBox.ScrollBars = ScrollBars.Vertical;
            statusTextBox.BorderStyle = BorderStyle.None;
            statusTextBox.BackColor = Color.FromArgb(30, 31, 33);
            statusTextBox.ForeColor = Color.FromArgb(204, 208, 213);
            statusTextBox.Dock = DockStyle.Fill;
            statusTextBox.WordWrap = true;
            statusTextBox.AccessibleName = "Подробности операции";

            browseButton = CreateButton("Обзор…", 1);
            installButton = CreateButton("Установить / обновить", 2);
            installButton.FillColor = AccentColor;
            installButton.ForeColor = Color.FromArgb(18, 37, 46);
            installButton.Font = new Font(Font, FontStyle.Bold);
            uninstallButton = CreateButton("Удалить мод", 3);
            repairButton = CreateButton("Восстановить Lolka", 4);
            detailsButton = CreateButton("Подробности", 5);
            checkButton = CreateButton("Проверить", 6);
            foreach (ModernButton button in new[] { detailsButton, checkButton })
            { button.FillColor = WindowColor; button.ForeColor = MutedColor; button.BorderColor = WindowColor; }

            clientTile = new StatusTile("Клиент", "Проверка…", 0);
            modTile = new StatusTile("Статус", "Проверка…", 1);
            versionTile = new StatusTile("Установлено", "Проверка…", 2);
            banner = new StatusBanner();
            banner.SetMessage("Готово к проверке", "Закройте Lolka перед установкой или восстановлением.", StatusTone.Neutral);
            detailsPanel = new RoundedPanel(Color.FromArgb(30, 31, 33));
            detailsPanel.Padding = new Padding(12);
            detailsPanel.Dock = DockStyle.Fill;
            detailsPanel.Margin = new Padding(0, 8, 0, 0);
            detailsPanel.Visible = false;
            detailsPanel.Controls.Add(statusTextBox);
            try { installationPathTextBox.Text = InstallerBackend.DefaultInstallation ?? String.Empty; }
            catch { installationPathTextBox.Text = String.Empty; }
            if (installation != null) installationPathTextBox.Text = Path.GetFullPath(installation);
            BuildLayout();
            WireEvents();
            Shown += OnShown;
        }

        private void LoadBrand()
        {
            Assembly assembly = Assembly.GetExecutingAssembly();
            using (Stream stream = assembly.GetManifestResourceStream("LolkaMod.Brand.Logo.png"))
            {
                if (stream != null)
                    using (Image image = Image.FromStream(stream)) brandImage = new Bitmap(image);
            }
            using (Stream stream = assembly.GetManifestResourceStream("LolkaMod.Brand.App.ico"))
            {
                if (stream != null) { brandIcon = new Icon(stream); Icon = brandIcon; }
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            try
            {
                int enabled = 1;
                if (DwmSetWindowAttribute(Handle, 20, ref enabled, sizeof(int)) != 0)
                    DwmSetWindowAttribute(Handle, 19, ref enabled, sizeof(int));
            }
            catch (DllNotFoundException) { }
            catch (EntryPointNotFoundException) { }
        }
        [DllImport("dwmapi.dll", PreserveSig = true)]
        private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            // A normal window close must not interrupt a filesystem transaction.
            if (busy && e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                banner.SetMessage("Операция выполняется", "Дождитесь завершения, затем закройте установщик.", StatusTone.Warning);
            }
            if (!e.Cancel) updateCancellation.Cancel();
            base.OnFormClosing(e);
        }

        private ModernButton CreateButton(string text, int tabIndex)
        {
            ModernButton button = new ModernButton();
            button.Text = text; button.AccessibleName = text; button.TabIndex = tabIndex;
            button.Dock = DockStyle.Fill; button.Margin = Padding.Empty;
            button.FillColor = Color.FromArgb(48, 50, 53);
            button.BorderColor = Color.FromArgb(60, 62, 66);
            button.ForeColor = TextColor; button.Font = Font;
            return button;
        }
        private static TableLayoutPanel Table(int columns, int rows)
        {
            TableLayoutPanel table = new TableLayoutPanel();
            table.Dock = DockStyle.Fill; table.Margin = Padding.Empty;
            table.ColumnCount = columns; table.RowCount = rows; table.BackColor = Color.Transparent;
            if (rows == 1) table.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            return table;
        }
        private static Label TextLabel(string text, Color color, float size, FontStyle style)
        {
            Label label = new Label();
            label.Text = text; label.ForeColor = color;
            label.Font = new Font("Segoe UI", size, style, GraphicsUnit.Point);
            label.Dock = DockStyle.Fill; label.Margin = Padding.Empty;
            label.TextAlign = ContentAlignment.MiddleLeft; label.AutoEllipsis = true;
            return label;
        }

        private void BuildLayout()
        {
            TableLayoutPanel root = Table(1, 9);
            root.BackColor = WindowColor; root.Padding = new Padding(16);
            root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            foreach (float height in new[] { 192F, 10F, 64F, 10F, 36F, 10F, 48F, 28F })
                root.RowStyles.Add(new RowStyle(SizeType.Absolute, height));
            root.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));

            RoundedPanel mainCard = new RoundedPanel(CardColor);
            mainCard.Padding = new Padding(14); mainCard.Dock = DockStyle.Fill; mainCard.Margin = Padding.Empty;
            TableLayoutPanel cardLayout = Table(1, 5);
            cardLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            foreach (float height in new[] { 50F, 8F, 52F, 10F, 38F })
                cardLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, height));

            TableLayoutPanel header = Table(3, 1);
            header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 46F));
            header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 12F));
            header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            PictureBox logo = new PictureBox();
            logo.Image = brandImage; logo.SizeMode = PictureBoxSizeMode.Zoom;
            logo.Dock = DockStyle.Fill; logo.Margin = new Padding(0, 2, 0, 2);
            logo.TabStop = false; logo.AccessibleName = "Логотип LolkaMod";
            TableLayoutPanel titles = Table(1, 2);
            titles.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            titles.RowStyles.Add(new RowStyle(SizeType.Percent, 60F));
            titles.RowStyles.Add(new RowStyle(SizeType.Percent, 40F));
            titles.Controls.Add(TextLabel("LolkaMod", TextColor, 15F, FontStyle.Bold), 0, 0);
            titles.Controls.Add(TextLabel("Установщик · версия " + InstallerBackend.ModVersion, MutedColor, 9F, FontStyle.Regular), 0, 1);
            header.Controls.Add(logo, 0, 0); header.Controls.Add(titles, 2, 0);

            TableLayoutPanel pathGroup = Table(1, 2);
            pathGroup.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            pathGroup.RowStyles.Add(new RowStyle(SizeType.Absolute, 18F));
            pathGroup.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            pathGroup.Controls.Add(TextLabel("Папка Lolka", MutedColor, 8.5F, FontStyle.Regular), 0, 0);
            TableLayoutPanel pathRow = Table(3, 1);
            pathRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            pathRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 8F));
            pathRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 86F));
            RoundedPanel pathBox = new RoundedPanel(Color.FromArgb(30, 31, 33));
            pathBox.BorderColor = Color.FromArgb(62, 64, 68); pathBox.CornerRadius = 6;
            pathBox.Dock = DockStyle.Fill; pathBox.Margin = Padding.Empty; pathBox.Padding = new Padding(10, 8, 8, 4);
            pathBox.Controls.Add(installationPathTextBox);
            pathRow.Controls.Add(pathBox, 0, 0); pathRow.Controls.Add(browseButton, 2, 0);
            pathGroup.Controls.Add(pathRow, 0, 1);
            cardLayout.Controls.Add(header, 0, 0); cardLayout.Controls.Add(pathGroup, 0, 2);
            cardLayout.Controls.Add(installButton, 0, 4); mainCard.Controls.Add(cardLayout);

            TableLayoutPanel states = Table(5, 1);
            states.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 34F));
            states.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 8F));
            states.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 34F));
            states.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 8F));
            states.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 32F));
            states.Controls.Add(clientTile, 0, 0); states.Controls.Add(modTile, 2, 0); states.Controls.Add(versionTile, 4, 0);

            TableLayoutPanel actions = Table(3, 1);
            actions.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50F));
            actions.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 8F));
            actions.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50F));
            actions.Controls.Add(uninstallButton, 0, 0); actions.Controls.Add(repairButton, 2, 0);

            TableLayoutPanel footer = Table(3, 1);
            footer.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 108F));
            footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            footer.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 92F));
            footer.Controls.Add(detailsButton, 0, 0); footer.Controls.Add(checkButton, 2, 0);

            root.Controls.Add(mainCard, 0, 0); root.Controls.Add(states, 0, 2); root.Controls.Add(actions, 0, 4);
            root.Controls.Add(banner, 0, 6); root.Controls.Add(footer, 0, 7); root.Controls.Add(detailsPanel, 0, 8);
            Controls.Add(root);
        }

        private void WireEvents()
        {
            browseButton.Click += OnBrowse;
            installButton.Click += async delegate { await InstallBundled(); };
            uninstallButton.Click += async delegate { await RunBackend("Удаление мода", delegate(string path) { return InstallerBackend.Uninstall(path); }); };
            repairButton.Click += async delegate { await RunBackend("Восстановление", delegate(string path) { return InstallerBackend.Repair(path); }); };
            checkButton.Click += async delegate { await RunBackend("Проверка", delegate(string path) { return InstallerBackend.Status(path); }); await CheckUpdates(); };
            detailsButton.Click += delegate { ToggleDetails(); };
        }
        private Task InstallBundled()
        {
            return RunBackend("Установка", delegate(string path)
            {
                InstallerBackend.InstallStatus status = InstallerBackend.InspectStatus(path);
                if (status.ModInstalled && !String.IsNullOrEmpty(status.InstalledModVersion) && InstallerUpdates.CompareVersions(status.InstalledModVersion, InstallerBackend.ModVersion) > 0)
                    throw new InvalidOperationException("В Lolka установлена более новая версия мода. Нажмите «Проверить» и обновите установщик.");
                return InstallerBackend.Install(path);
            });
        }
        private void ToggleDetails()
        {
            detailsVisible = !detailsVisible;
            if (detailsVisible) { collapsedHeight = ClientSize.Height; ClientSize = new Size(ClientSize.Width, ClientSize.Height + Scaled(160)); }
            else ClientSize = new Size(ClientSize.Width, Math.Max(collapsedHeight, Scaled(440)));
            detailsPanel.Visible = detailsVisible;
            detailsButton.Text = detailsVisible ? "Скрыть детали" : "Подробности";
        }
        private int Scaled(int value)
        {
            using (Graphics graphics = CreateGraphics()) return (int)Math.Round(value * graphics.DpiY / 96F);
        }
        private async void OnShown(object sender, EventArgs e)
        {
            await RunBackend("Проверка", delegate(string path) { return InstallerBackend.Status(path); });
            await CheckUpdates();
        }
        private async void OnBrowse(object sender, EventArgs e)
        {
            using (FolderBrowserDialog dialog = new FolderBrowserDialog())
            {
                dialog.Description = "Выберите папку установленного клиента Lolka"; dialog.ShowNewFolderButton = false;
                if (!String.IsNullOrEmpty(installationPathTextBox.Text)) dialog.SelectedPath = installationPathTextBox.Text;
                if (dialog.ShowDialog(this) == DialogResult.OK)
                {
                    installationPathTextBox.Text = dialog.SelectedPath;
                    await RunBackend("Проверка", delegate(string path) { return InstallerBackend.Status(path); });
                }
            }
        }
        private sealed class OperationResult
        {
            internal string Message, InspectionError;
            internal InstallerBackend.InstallStatus Status;
        }
        private async Task RunBackend(string operationName, Func<string, string> operation)
        {
            if (busy) return;
            string path = installationPathTextBox.Text;
            busy = true; SetButtonsEnabled(false); statusTextBox.Text = operationName + "…";
            clientTile.SetValue("Проверяется…", false); modTile.SetValue("Проверяется…", false);
            banner.SetMessage(operationName + "…", "Дождитесь завершения операции.", StatusTone.Neutral);
            try
            {
                OperationResult result = await Task.Run(delegate
                {
                    OperationResult outcome = new OperationResult(); outcome.Message = operation(path);
                    try { outcome.Status = InstallerBackend.InspectStatus(path); }
                    catch (Exception error) { outcome.InspectionError = error.Message; }
                    return outcome;
                });
                if (IsDisposed || Disposing) return;
                statusTextBox.Text = String.IsNullOrEmpty(result.Message) ? "Операция завершена." : result.Message;
                if (result.Status == null)
                {
                    ClearInspection(); statusTextBox.AppendText("\r\nПроверка состояния: " + result.InspectionError);
                    banner.SetMessage("Операция завершена", "Состояние не подтверждено. Откройте подробности.", StatusTone.Warning);
                }
                else
                {
                    ApplyInspection(result.Status);
                    if (!result.Status.RecoveryPending && !result.Status.NeedsRepatch)
                    {
                        if (operationName == "Установка" && result.Status.ModInstalled) banner.SetMessage("Мод установлен", "Откройте Lolka. После обновления клиента повторите установку.", StatusTone.Success);
                        else if (operationName == "Удаление мода" && !result.Status.ModInstalled) banner.SetMessage("Мод удалён", "Теперь можно запустить обычную Lolka.", StatusTone.Success);
                        else if (operationName == "Восстановление" && result.Status.ClientFound && !result.Status.ModInstalled) banner.SetMessage("Lolka восстановлена", "Оригинальные файлы клиента восстановлены.", StatusTone.Success);
                    }
                }
                FinishOperation();
            }
            catch (Exception error)
            {
                string message = String.IsNullOrEmpty(error.Message) ? "Проверьте папку Lolka и права доступа." : error.Message;
                if (IsDisposed || Disposing) return;
                ClearInspection(); statusTextBox.Text = operationName + " не завершена.\r\n" + message;
                banner.SetMessage(operationName == "Проверка" ? "Не удалось проверить Lolka" : "Операция не завершена", message, StatusTone.Error);
                FinishOperation();
            }
        }
        private async Task CheckUpdates()
        {
            if (updateCheckBusy || downloading || busy || IsDisposed || updateCancellation.IsCancellationRequested) return;
            updateCheckBusy = true; SetButtonsEnabled(false);
            statusTextBox.AppendText("\r\nПроверка обновлений установщика…");
            try
            {
                UpdateRelease release = null;
                try { release = await Task.Run(delegate { return InstallerUpdates.Check(updateCancellation.Token); }); }
                catch (Exception error)
                {
                    if (updateCancellation.IsCancellationRequested) return;
                    statusTextBox.AppendText("\r\nНе удалось проверить GitHub. Обновление из этого установщика доступно без сети.");
                    if (!BundleUpdateAvailable()) banner.SetMessage("Обновления не проверены", "GitHub недоступен. Доступна встроенная версия установщика.", StatusTone.Warning);
                    if (!(error is System.Net.WebException)) statusTextBox.AppendText("\r\n" + error.Message);
                }
                if (IsDisposed || Disposing || updateCancellation.IsCancellationRequested) return;
                string installed = InstalledVersion();
                bool remote = release != null && InstallerUpdates.CompareVersions(release.Version, InstallerBackend.ModVersion) > 0
                    && (installed == null || InstallerUpdates.CompareVersions(release.Version, installed) > 0);
                if (!remote && !BundleUpdateAvailable())
                { if (release != null) statusTextBox.AppendText("\r\nНовых версий нет."); return; }
                string target = remote ? release.Version : InstallerBackend.ModVersion;
                statusTextBox.AppendText("\r\nДоступен LolkaMod " + target + ".");
                // No remembered skip or download: this prompt is offered anew each run.
                using (UpdateDialog dialog = new UpdateDialog(installed, target, !remote))
                {
                    if (dialog.ShowDialog(this) == DialogResult.OK)
                    {
                        if (remote) await DownloadUpdate(release);
                        else await InstallBundled();
                    }
                    else banner.SetMessage("Обновление отложено", "Доступна версия " + target + ". Предложим обновиться при следующем запуске.", StatusTone.Neutral);
                }
            }
            catch (OperationCanceledException) { }
            catch (System.Net.WebException)
            {
                if (!IsDisposed && !updateCancellation.IsCancellationRequested)
                {
                    statusTextBox.AppendText("\r\nНе удалось проверить обновления. Доступна встроенная версия " + InstallerBackend.ModVersion + ".");
                    banner.SetMessage("Обновления не проверены", "Нет соединения с GitHub. Можно использовать встроенную версию.", StatusTone.Warning);
                }
            }
            catch (Exception error)
            {
                if (!IsDisposed && !updateCancellation.IsCancellationRequested)
                {
                    statusTextBox.AppendText("\r\n" + error.Message);
                    banner.SetMessage("Обновление не выполнено", error.Message, StatusTone.Warning);
                }
            }
            finally
            {
                updateCheckBusy = false;
                if (!IsDisposed && !Disposing) SetButtonsEnabled(!busy);
            }
        }
        private string InstalledVersion()
        {
            return lastInspection != null && lastInspection.ModInstalled && !String.IsNullOrEmpty(lastInspection.InstalledModVersion)
                ? lastInspection.InstalledModVersion : null;
        }
        private bool BundleUpdateAvailable()
        {
            string installed = InstalledVersion();
            if (installed == null || lastInspection.RecoveryPending || lastInspection.NeedsRepatch) return false;
            try { return InstallerUpdates.CompareVersions(InstallerBackend.ModVersion, installed) > 0; }
            catch (InvalidDataException) { return false; }
        }
        private async Task DownloadUpdate(UpdateRelease release)
        {
            downloading = true; SetButtonsEnabled(false);
            string installation = installationPathTextBox.Text;
            banner.SetMessage("Загрузка LolkaMod " + release.Version, "Можно закрыть окно, чтобы отменить загрузку.", StatusTone.Neutral);
            try
            {
                string file = await Task.Run(delegate
                {
                    int previous = -1;
                    return InstallerUpdates.Download(release, updateCancellation.Token, delegate(int percent)
                    {
                        if (percent == previous) return; previous = percent;
                        PostToUi(delegate { banner.SetMessage("Загрузка LolkaMod " + release.Version, percent + "% · Можно закрыть окно для отмены.", StatusTone.Neutral); });
                    });
                });
                if (IsDisposed || Disposing || updateCancellation.IsCancellationRequested) return;
                InstallerUpdates.OpenDownloaded(file, release, installation);
                Close();
            }
            finally { downloading = false; if (!IsDisposed && !Disposing) SetButtonsEnabled(!busy); }
        }
        private void ApplyInspection(InstallerBackend.InstallStatus status)
        {
            lastInspection = status;
            if (status.RecoveryPending)
            {
                clientTile.SetValue("Не проверено", false); modTile.SetValue("Не проверено", false);
                versionTile.SetValue("Не проверено", false);
                banner.SetMessage("Нужно восстановить клиент", "Обнаружена незавершённая операция. Выберите «Восстановить Lolka».", StatusTone.Warning);
                return;
            }
            clientTile.SetValue(status.ClientFound ? "Найден" + (String.IsNullOrEmpty(status.HostVersion) ? "" : " · " + status.HostVersion) : "Не подтверждён", status.ClientFound);
            modTile.SetValue(status.ModInstalled ? "Установлен" : status.NeedsRepatch ? "Нужен патч" : "Не установлен", status.ModInstalled);
            versionTile.SetValue(String.IsNullOrEmpty(status.InstalledModVersion) ? "—" : status.InstalledModVersion, status.ModInstalled);
            installButton.Text = BundleUpdateAvailable() ? "Обновить до " + InstallerBackend.ModVersion : status.ModInstalled ? "Переустановить мод" : "Установить LolkaMod";
            if (status.NeedsRepatch) banner.SetMessage("Мод нужно установить заново", "Мод сейчас не активен. Закройте Lolka и повторите установку.", StatusTone.Warning);
            else if (BundleUpdateAvailable()) banner.SetMessage("Есть обновление LolkaMod", "Установлено " + status.InstalledModVersion + ". Доступно " + InstallerBackend.ModVersion + ".", StatusTone.Neutral);
            else if (status.ModInstalled) banner.SetMessage("LolkaMod установлен", "После обновления Lolka повторите установку мода.", StatusTone.Success);
            else banner.SetMessage("Готово к установке", "Закройте Lolka, включая значок в трее, и установите мод.", StatusTone.Neutral);
        }
        private void ClearInspection()
        {
            lastInspection = null;
            clientTile.SetValue("Не подтверждён", false); modTile.SetValue("Не подтверждён", false);
            versionTile.SetValue("Не проверено", false);
        }
        // Read-only preparation for hidden rendering. No installation or network requests.
        public void PreparePreview(string installation)
        {
            if (installation != null) installationPathTextBox.Text = installation;
            try
            {
                InstallerBackend.InstallStatus status = InstallerBackend.InspectStatus(installationPathTextBox.Text);
                ApplyInspection(status); statusTextBox.Text = status.Message;
            }
            catch (Exception error)
            {
                ClearInspection(); statusTextBox.Text = error.Message;
                banner.SetMessage("Не удалось проверить Lolka", error.Message, StatusTone.Error);
            }
        }
        private void PostToUi(Action action)
        {
            if (IsDisposed || !IsHandleCreated) return;
            try { BeginInvoke((MethodInvoker)delegate { if (!IsDisposed && !Disposing) action(); }); }
            catch (InvalidOperationException) { }
        }
        private void FinishOperation() { busy = false; SetButtonsEnabled(true); }
        private void SetButtonsEnabled(bool enabled)
        {
            enabled = enabled && !updateCheckBusy && !downloading;
            browseButton.Enabled = enabled; installButton.Enabled = enabled; uninstallButton.Enabled = enabled;
            repairButton.Enabled = enabled; checkButton.Enabled = enabled;
        }
        protected override void Dispose(bool disposing)
        {
            base.Dispose(disposing);
            if (disposing)
            {
                if (brandImage != null) { brandImage.Dispose(); brandImage = null; }
                if (brandIcon != null) { brandIcon.Dispose(); brandIcon = null; }
            }
        }
    }

    internal static class UiDrawing
    {
        internal static GraphicsPath Rounded(RectangleF rectangle, float radius)
        {
            GraphicsPath path = new GraphicsPath();
            float diameter = Math.Min(radius * 2F, Math.Min(rectangle.Width, rectangle.Height));
            if (diameter < 1F) { path.AddRectangle(rectangle); return path; }
            path.AddArc(rectangle.Left, rectangle.Top, diameter, diameter, 180, 90);
            path.AddArc(rectangle.Right - diameter, rectangle.Top, diameter, diameter, 270, 90);
            path.AddArc(rectangle.Right - diameter, rectangle.Bottom - diameter, diameter, diameter, 0, 90);
            path.AddArc(rectangle.Left, rectangle.Bottom - diameter, diameter, diameter, 90, 90);
            path.CloseFigure(); return path;
        }
        internal static Color ParentColor(Control control)
        {
            for (Control parent = control.Parent; parent != null; parent = parent.Parent)
            {
                RoundedPanel rounded = parent as RoundedPanel;
                if (rounded != null) return rounded.SurfaceColor;
                if (parent.BackColor.A != 0) return parent.BackColor;
            }
            return Color.FromArgb(28, 29, 31);
        }
        internal static void Glyph(Graphics graphics, Rectangle rectangle, int kind, Color color)
        {
            float x = rectangle.Left, y = rectangle.Top, w = rectangle.Width, h = rectangle.Height;
            using (Pen pen = new Pen(color, Math.Max(1.6F, w / 12F)))
            {
                pen.StartCap = LineCap.Round; pen.EndCap = LineCap.Round;
                if (kind == 0)
                {
                    graphics.DrawPolygon(pen, new[] { new PointF(x + w * .5F, y), new PointF(x + w * .91F, y + h * .25F), new PointF(x + w * .91F, y + h * .75F), new PointF(x + w * .5F, y + h), new PointF(x + w * .09F, y + h * .75F), new PointF(x + w * .09F, y + h * .25F) });
                    graphics.DrawLines(pen, new[] { new PointF(x + w * .29F, y + h * .52F), new PointF(x + w * .45F, y + h * .68F), new PointF(x + w * .72F, y + h * .36F) });
                }
                else if (kind == 1)
                {
                    graphics.DrawRectangle(pen, x + w * .15F, y + h * .2F, w * .7F, h * .65F);
                    graphics.DrawLine(pen, x + w * .36F, y + h * .02F, x + w * .36F, y + h * .2F);
                    graphics.DrawLine(pen, x + w * .65F, y + h * .02F, x + w * .65F, y + h * .2F);
                    graphics.DrawLine(pen, x + w * .36F, y + h * .85F, x + w * .36F, y + h * .99F);
                    graphics.DrawLine(pen, x + w * .65F, y + h * .85F, x + w * .65F, y + h * .99F);
                }
                else
                {
                    graphics.DrawEllipse(pen, x + w * .06F, y + h * .06F, w * .88F, h * .88F);
                    if (kind == 2)
                    {
                        graphics.DrawLine(pen, x + w * .5F, y + h * .26F, x + w * .5F, y + h * .55F);
                        graphics.DrawLine(pen, x + w * .5F, y + h * .55F, x + w * .7F, y + h * .55F);
                    }
                    else if (kind == 3)
                        graphics.DrawLines(pen, new[] { new PointF(x + w * .26F, y + h * .51F), new PointF(x + w * .43F, y + h * .68F), new PointF(x + w * .75F, y + h * .34F) });
                    else
                    {
                        graphics.DrawLine(pen, x + w * .5F, y + h * .25F, x + w * .5F, y + h * .54F);
                        graphics.DrawLine(pen, x + w * .5F, y + h * .73F, x + w * .5F, y + h * .75F);
                    }
                }
            }
        }
    }

    internal class RoundedPanel : Panel
    {
        internal Color SurfaceColor { get; set; }
        internal Color BorderColor { get; set; }
        internal int CornerRadius { get; set; }
        internal RoundedPanel(Color surface)
        {
            SurfaceColor = surface; BorderColor = Color.FromArgb(49, 51, 55); CornerRadius = 10; BackColor = Color.Transparent;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.SupportsTransparentBackColor, true);
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (GraphicsPath path = UiDrawing.Rounded(new RectangleF(.5F, .5F, Math.Max(0, Width - 1F), Math.Max(0, Height - 1F)), CornerRadius * e.Graphics.DpiX / 96F))
            using (SolidBrush brush = new SolidBrush(SurfaceColor))
            using (Pen pen = new Pen(BorderColor)) { e.Graphics.FillPath(brush, path); e.Graphics.DrawPath(pen, path); }
            base.OnPaint(e);
        }
    }

    internal sealed class ModernButton : Button
    {
        internal Color FillColor { get; set; }
        internal Color BorderColor { get; set; }
        private bool hover, pressed;
        internal ModernButton()
        {
            FlatStyle = FlatStyle.Flat; FlatAppearance.BorderSize = 0; Cursor = Cursors.Hand; UseVisualStyleBackColor = false;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        }
        protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hover = false; pressed = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnMouseDown(MouseEventArgs e) { if (e.Button == MouseButtons.Left) pressed = true; Invalidate(); base.OnMouseDown(e); }
        protected override void OnMouseUp(MouseEventArgs e) { pressed = false; Invalidate(); base.OnMouseUp(e); }
        protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
        protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }
        protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }
        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.Clear(UiDrawing.ParentColor(this)); e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            Color fill = !Enabled ? Color.FromArgb(43, 45, 48) : pressed ? ControlPaint.Dark(FillColor, .08F) : hover ? ControlPaint.Light(FillColor, .08F) : FillColor;
            using (GraphicsPath path = UiDrawing.Rounded(new RectangleF(.5F, .5F, Width - 1F, Height - 1F), 6F * e.Graphics.DpiX / 96F))
            using (SolidBrush brush = new SolidBrush(fill))
            using (Pen pen = new Pen(BorderColor)) { e.Graphics.FillPath(brush, path); e.Graphics.DrawPath(pen, path); }
            TextRenderer.DrawText(e.Graphics, Text, Font, ClientRectangle, Enabled ? ForeColor : Color.FromArgb(127, 132, 138), TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis);
            if (Focused && ShowFocusCues)
            {
                using (GraphicsPath path = UiDrawing.Rounded(new RectangleF(3F, 3F, Width - 6F, Height - 6F), 4F * e.Graphics.DpiX / 96F))
                using (Pen pen = new Pen(Color.FromArgb(225, 232, 238))) { pen.DashStyle = DashStyle.Dot; e.Graphics.DrawPath(pen, path); }
            }
        }
    }

    internal sealed class StatusTile : RoundedPanel
    {
        private readonly Label titleLabel, valueLabel;
        private readonly int kind;
        private Color glyphColor = Color.FromArgb(144, 150, 159);
        internal StatusTile(string title, string value, int iconKind) : base(Color.FromArgb(36, 38, 40))
        {
            kind = iconKind; Dock = DockStyle.Fill; Margin = Padding.Empty;
            TableLayoutPanel labels = new TableLayoutPanel();
            labels.Dock = DockStyle.Fill; labels.BackColor = Color.Transparent; labels.Margin = Padding.Empty;
            labels.Padding = new Padding(44, 9, 6, 9); labels.ColumnCount = 1; labels.RowCount = 2;
            labels.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            labels.RowStyles.Add(new RowStyle(SizeType.Percent, 46F)); labels.RowStyles.Add(new RowStyle(SizeType.Percent, 54F));
            titleLabel = new Label(); valueLabel = new Label();
            foreach (Label label in new[] { titleLabel, valueLabel })
            { label.Dock = DockStyle.Fill; label.Margin = Padding.Empty; label.TextAlign = ContentAlignment.MiddleLeft; label.AutoEllipsis = true; }
            titleLabel.Text = title; titleLabel.ForeColor = Color.FromArgb(171, 176, 183); titleLabel.Font = new Font("Segoe UI", 8.5F);
            valueLabel.ForeColor = Color.FromArgb(235, 238, 242); valueLabel.Font = new Font("Segoe UI", 9F);
            labels.Controls.Add(titleLabel, 0, 0); labels.Controls.Add(valueLabel, 0, 1); Controls.Add(labels);
            SetValue(value, false);
        }
        internal void SetValue(string value, bool confirmed)
        {
            valueLabel.Text = value; AccessibleName = titleLabel.Text + ": " + value;
            glyphColor = confirmed ? Color.FromArgb(105, 188, 222) : Color.FromArgb(144, 150, 159);
            Invalidate(true);
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            float scale = e.Graphics.DpiX / 96F;
            int side = (int)Math.Round(22F * scale), left = (int)Math.Round(12F * scale);
            UiDrawing.Glyph(e.Graphics, new Rectangle(left, (Height - side) / 2, side, side), kind, glyphColor);
        }
    }

    internal enum StatusTone { Neutral, Success, Warning, Error }
    internal sealed class StatusBanner : RoundedPanel
    {
        private readonly Label titleLabel, subtitleLabel;
        private StatusTone tone;
        internal StatusBanner() : base(Color.FromArgb(34, 40, 44))
        {
            Dock = DockStyle.Fill; Margin = Padding.Empty;
            TableLayoutPanel labels = new TableLayoutPanel();
            labels.Dock = DockStyle.Fill; labels.BackColor = Color.Transparent; labels.Margin = Padding.Empty;
            labels.Padding = new Padding(45, 4, 9, 4); labels.ColumnCount = 1; labels.RowCount = 2;
            labels.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            labels.RowStyles.Add(new RowStyle(SizeType.Percent, 50F)); labels.RowStyles.Add(new RowStyle(SizeType.Percent, 50F));
            titleLabel = new Label(); subtitleLabel = new Label();
            titleLabel.Font = new Font("Segoe UI", 9F, FontStyle.Bold); subtitleLabel.Font = new Font("Segoe UI", 8.5F);
            foreach (Label label in new[] { titleLabel, subtitleLabel })
            { label.Dock = DockStyle.Fill; label.Margin = Padding.Empty; label.AutoEllipsis = true; label.TextAlign = ContentAlignment.MiddleLeft; }
            titleLabel.ForeColor = Color.FromArgb(235, 240, 244); subtitleLabel.ForeColor = Color.FromArgb(171, 181, 191);
            labels.Controls.Add(titleLabel, 0, 0); labels.Controls.Add(subtitleLabel, 0, 1); Controls.Add(labels);
        }
        internal void SetMessage(string title, string subtitle, StatusTone value)
        {
            tone = value; titleLabel.Text = title; subtitleLabel.Text = subtitle; AccessibleName = title + ". " + subtitle;
            SurfaceColor = tone == StatusTone.Error ? Color.FromArgb(49, 36, 38) : tone == StatusTone.Warning ? Color.FromArgb(46, 42, 34) : Color.FromArgb(34, 40, 44);
            BorderColor = tone == StatusTone.Error ? Color.FromArgb(72, 49, 52) : tone == StatusTone.Warning ? Color.FromArgb(65, 59, 44) : Color.FromArgb(47, 58, 65);
            Invalidate(true);
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            float scale = e.Graphics.DpiX / 96F;
            int side = (int)Math.Round(23F * scale), left = (int)Math.Round(12F * scale);
            Color color = tone == StatusTone.Error ? Color.FromArgb(229, 133, 132) : tone == StatusTone.Warning ? Color.FromArgb(227, 190, 116) : Color.FromArgb(105, 188, 222);
            UiDrawing.Glyph(e.Graphics, new Rectangle(left, (Height - side) / 2, side, side), tone == StatusTone.Success ? 3 : 4, color);
        }
    }
}
