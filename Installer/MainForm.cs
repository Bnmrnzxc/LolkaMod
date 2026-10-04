using System;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace LolkaModInstaller
{
    public class MainForm : Form
    {
        private readonly TextBox installationPathTextBox;
        private readonly TextBox statusTextBox;
        private readonly Button browseButton;
        private readonly Button installButton;
        private readonly Button uninstallButton;
        private readonly Button repairButton;
        private readonly Button checkButton;
        private bool busy;

        public MainForm()
        {
            Text = "LolkaMod Installer";
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(620, 450);
            Size = new Size(760, 570);
            AutoScaleMode = AutoScaleMode.Dpi;
            AutoScaleDimensions = new SizeF(96F, 96F);
            BackColor = Color.FromArgb(23, 22, 34);
            ForeColor = Color.FromArgb(244, 241, 255);
            Font = new Font("Segoe UI", 9F, FontStyle.Regular, GraphicsUnit.Point);

            installationPathTextBox = new TextBox();
            installationPathTextBox.ReadOnly = true;
            installationPathTextBox.Dock = DockStyle.Fill;
            installationPathTextBox.BackColor = Color.FromArgb(16, 15, 24);
            installationPathTextBox.ForeColor = ForeColor;
            installationPathTextBox.BorderStyle = BorderStyle.FixedSingle;

            statusTextBox = new TextBox();
            statusTextBox.Multiline = true;
            statusTextBox.ReadOnly = true;
            statusTextBox.ScrollBars = ScrollBars.Vertical;
            statusTextBox.Dock = DockStyle.Fill;
            statusTextBox.BackColor = Color.FromArgb(16, 15, 24);
            statusTextBox.ForeColor = Color.FromArgb(220, 216, 235);
            statusTextBox.BorderStyle = BorderStyle.FixedSingle;
            statusTextBox.WordWrap = true;

            browseButton = CreateButton("Обзор…");
            installButton = CreateButton("Установить / обновить");
            uninstallButton = CreateButton("Удалить мод");
            repairButton = CreateButton("Восстановить Lolka");
            checkButton = CreateButton("Проверить");

            string defaultInstallation = String.Empty;
            try
            {
                defaultInstallation = InstallerBackend.DefaultInstallation;
            }
            catch
            {
                // Keep the path editable through the folder picker even if discovery fails.
            }
            installationPathTextBox.Text = defaultInstallation ?? String.Empty;

            BuildLayout();
            WireEvents();
            Shown += OnShown;
        }

        private static Button CreateButton(string text)
        {
            Button button = new Button();
            button.Text = text;
            button.Dock = DockStyle.Fill;
            button.MinimumSize = new Size(0, 40);
            button.Margin = new Padding(4);
            button.FlatStyle = FlatStyle.Flat;
            button.FlatAppearance.BorderColor = Color.FromArgb(75, 67, 100);
            button.BackColor = Color.FromArgb(38, 34, 54);
            button.ForeColor = Color.FromArgb(244, 241, 255);
            button.Cursor = Cursors.Hand;
            return button;
        }

        private void BuildLayout()
        {
            TableLayoutPanel layout = new TableLayoutPanel();
            layout.Dock = DockStyle.Fill;
            layout.Padding = new Padding(16);
            layout.ColumnCount = 1;
            layout.RowCount = 6;
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 70F));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 62F));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 82F));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 106F));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 26F));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));

            Panel header = new Panel();
            header.Dock = DockStyle.Fill;
            header.BackColor = Color.FromArgb(67, 39, 112);
            header.Padding = new Padding(14, 9, 14, 8);

            Label brand = new Label();
            brand.Text = "LM";
            brand.Font = new Font("Segoe UI", 18F, FontStyle.Bold, GraphicsUnit.Point);
            brand.ForeColor = Color.FromArgb(221, 208, 255);
            brand.TextAlign = ContentAlignment.MiddleCenter;
            brand.Dock = DockStyle.Left;
            brand.Width = 52;

            Label title = new Label();
            title.Text = "LolkaMod Installer";
            title.Font = new Font("Segoe UI", 16F, FontStyle.Bold, GraphicsUnit.Point);
            title.ForeColor = Color.White;
            title.TextAlign = ContentAlignment.MiddleLeft;
            title.Dock = DockStyle.Fill;

            Label version = new Label();
            version.Text = InstallerBackend.ModVersion;
            version.Font = new Font("Segoe UI", 9F, FontStyle.Regular, GraphicsUnit.Point);
            version.ForeColor = Color.FromArgb(224, 213, 246);
            version.TextAlign = ContentAlignment.MiddleRight;
            version.Dock = DockStyle.Right;
            version.Width = 70;

            header.Controls.Add(title);
            header.Controls.Add(version);
            header.Controls.Add(brand);

            Label instructions = new Label();
            instructions.Dock = DockStyle.Fill;
            instructions.TextAlign = ContentAlignment.MiddleLeft;
            instructions.ForeColor = Color.FromArgb(205, 201, 218);
            instructions.Text = "Закройте Lolka и нажмите «Установить / обновить». После обновления клиента повторите установку.\r\nСовместимость интерфейса проверяется при запуске Lolka.";

            TableLayoutPanel pathGroup = new TableLayoutPanel();
            pathGroup.Dock = DockStyle.Fill;
            pathGroup.Padding = new Padding(0, 6, 0, 4);
            pathGroup.ColumnCount = 1;
            pathGroup.RowCount = 2;
            pathGroup.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            pathGroup.RowStyles.Add(new RowStyle(SizeType.Absolute, 22F));
            pathGroup.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            Label pathLabel = new Label();
            pathLabel.Text = "Папка установки Lolka";
            pathLabel.Dock = DockStyle.Fill;
            pathLabel.ForeColor = Color.FromArgb(205, 201, 218);

            TableLayoutPanel pathRow = new TableLayoutPanel();
            pathRow.Dock = DockStyle.Fill;
            pathRow.ColumnCount = 2;
            pathRow.RowCount = 1;
            pathRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            pathRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 104F));
            pathRow.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            pathRow.Controls.Add(installationPathTextBox, 0, 0);
            pathRow.Controls.Add(browseButton, 1, 0);
            pathGroup.Controls.Add(pathLabel, 0, 0);
            pathGroup.Controls.Add(pathRow, 0, 1);

            TableLayoutPanel actions = new TableLayoutPanel();
            actions.Dock = DockStyle.Fill;
            actions.ColumnCount = 2;
            actions.RowCount = 2;
            actions.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50F));
            actions.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50F));
            actions.RowStyles.Add(new RowStyle(SizeType.Percent, 50F));
            actions.RowStyles.Add(new RowStyle(SizeType.Percent, 50F));
            actions.Controls.Add(installButton, 0, 0);
            actions.Controls.Add(uninstallButton, 1, 0);
            actions.Controls.Add(repairButton, 0, 1);
            actions.Controls.Add(checkButton, 1, 1);

            Label statusLabel = new Label();
            statusLabel.Text = "Состояние";
            statusLabel.Dock = DockStyle.Fill;
            statusLabel.TextAlign = ContentAlignment.BottomLeft;
            statusLabel.ForeColor = Color.FromArgb(205, 201, 218);

            layout.Controls.Add(header, 0, 0);
            layout.Controls.Add(instructions, 0, 1);
            layout.Controls.Add(pathGroup, 0, 2);
            layout.Controls.Add(actions, 0, 3);
            layout.Controls.Add(statusLabel, 0, 4);
            layout.Controls.Add(statusTextBox, 0, 5);
            Controls.Add(layout);
        }

        private void WireEvents()
        {
            browseButton.Click += OnBrowse;
            installButton.Click += delegate
            {
                RunBackend("Установка / обновление", delegate(string path) { return InstallerBackend.Install(path); });
            };
            uninstallButton.Click += delegate
            {
                RunBackend("Удаление мода", delegate(string path) { return InstallerBackend.Uninstall(path); });
            };
            repairButton.Click += delegate
            {
                RunBackend("Восстановление Lolka", delegate(string path) { return InstallerBackend.Repair(path); });
            };
            checkButton.Click += delegate
            {
                RunBackend("Проверка", delegate(string path) { return InstallerBackend.Status(path); });
            };
        }

        private void OnShown(object sender, EventArgs e)
        {
            RunBackend("Проверка состояния", delegate(string path) { return InstallerBackend.Status(path); });
        }

        private void OnBrowse(object sender, EventArgs e)
        {
            using (FolderBrowserDialog dialog = new FolderBrowserDialog())
            {
                dialog.Description = "Выберите папку установленного клиента Lolka";
                dialog.ShowNewFolderButton = false;
                if (!String.IsNullOrEmpty(installationPathTextBox.Text))
                    dialog.SelectedPath = installationPathTextBox.Text;
                if (dialog.ShowDialog(this) == DialogResult.OK)
                    installationPathTextBox.Text = dialog.SelectedPath;
            }
        }

        private async void RunBackend(string operationName, Func<string, string> operation)
        {
            if (busy)
                return;

            string path = installationPathTextBox.Text;
            busy = true;
            SetButtonsEnabled(false);
            statusTextBox.Text = operationName + "…";

            try
            {
                string result = await Task.Run(delegate { return operation(path); }).ConfigureAwait(false);
                PostToUi(delegate
                {
                    statusTextBox.Text = String.IsNullOrEmpty(result) ? "Операция завершена." : result;
                    FinishOperation();
                });
            }
            catch (Exception exception)
            {
                string message = String.IsNullOrEmpty(exception.Message)
                    ? "Неизвестная ошибка. Проверьте папку установки и права доступа."
                    : exception.Message;
                PostToUi(delegate
                {
                    statusTextBox.Text = operationName + " не выполнена.\r\n" + message;
                    FinishOperation();
                });
            }
        }

        private void PostToUi(Action action)
        {
            if (IsDisposed || !IsHandleCreated)
                return;
            try
            {
                BeginInvoke(action);
            }
            catch (InvalidOperationException)
            {
                // The form may be closing while a filesystem operation finishes.
            }
        }

        private void FinishOperation()
        {
            busy = false;
            SetButtonsEnabled(true);
        }

        private void SetButtonsEnabled(bool enabled)
        {
            browseButton.Enabled = enabled;
            installButton.Enabled = enabled;
            uninstallButton.Enabled = enabled;
            repairButton.Enabled = enabled;
            checkButton.Enabled = enabled;
        }
    }
}
