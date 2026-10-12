using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace LolkaModInstaller
{
    internal sealed class UpdateDialog : Form
    {
        private static readonly Color WindowColor = Color.FromArgb(28, 29, 31);
        private static readonly Color CardColor = Color.FromArgb(39, 40, 43);
        private static readonly Color TextColor = Color.FromArgb(243, 244, 245);
        private static readonly Color MutedColor = Color.FromArgb(184, 189, 196);
        private static readonly Color AccentColor = Color.FromArgb(105, 188, 222);

        internal UpdateDialog(string currentVersion, string latestVersion) : this(currentVersion, latestVersion, false) { }
        internal UpdateDialog(string currentVersion, string latestVersion, bool bundled)
        {
            Text = "Обновление LolkaMod";
            StartPosition = FormStartPosition.CenterParent;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowInTaskbar = false;
            AutoScaleMode = AutoScaleMode.Dpi;
            AutoScaleDimensions = new SizeF(96F, 96F);
            ClientSize = new Size(540, 340);
            BackColor = WindowColor;
            ForeColor = TextColor;
            Font = new Font("Segoe UI", 9F, FontStyle.Regular, GraphicsUnit.Point);

            TableLayoutPanel content = new TableLayoutPanel();
            content.Dock = DockStyle.Fill;
            content.Padding = new Padding(20);
            content.Margin = Padding.Empty;
            content.BackColor = WindowColor;
            content.ColumnCount = 1;
            content.RowCount = 6;
            content.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            content.RowStyles.Add(new RowStyle(SizeType.Absolute, 42F));
            content.RowStyles.Add(new RowStyle(SizeType.Absolute, 82F));
            content.RowStyles.Add(new RowStyle(SizeType.Absolute, 72F));
            content.RowStyles.Add(new RowStyle(SizeType.Absolute, 32F));
            content.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            content.RowStyles.Add(new RowStyle(SizeType.Absolute, 42F));

            RoundedPanel card = new RoundedPanel(CardColor);
            card.Dock = DockStyle.Fill;
            card.Margin = new Padding(0, 0, 0, 8);

            Label title = new Label();
            title.Dock = DockStyle.Fill;
            title.Margin = Padding.Empty;
            title.Padding = new Padding(12, 0, 8, 0);
            title.Text = "Доступно обновление LolkaMod";
            title.ForeColor = TextColor;
            title.Font = new Font("Segoe UI", 13F, FontStyle.Bold, GraphicsUnit.Point);
            title.TextAlign = ContentAlignment.MiddleLeft;
            title.AccessibleName = title.Text;
            card.Controls.Add(title);

            RoundedPanel versionsCard = new RoundedPanel(CardColor);
            versionsCard.Dock = DockStyle.Fill;
            versionsCard.Margin = new Padding(0, 6, 0, 4);
            versionsCard.Padding = new Padding(12, 6, 12, 6);
            TableLayoutPanel versions = new TableLayoutPanel();
            versions.Dock = DockStyle.Fill;
            versions.ColumnCount = 2; versions.RowCount = 2;
            versions.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 150F));
            versions.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            versions.RowStyles.Add(new RowStyle(SizeType.Percent, 50F));
            versions.RowStyles.Add(new RowStyle(SizeType.Percent, 50F));
            versions.Controls.Add(VersionLabel("Установлено", false, false), 0, 0);
            versions.Controls.Add(VersionLabel(currentVersion ?? "Мод не установлен", true, false), 1, 0);
            versions.Controls.Add(VersionLabel("Новая версия", false, false), 0, 1);
            versions.Controls.Add(VersionLabel(latestVersion, true, true), 1, 1);
            versionsCard.Controls.Add(versions);

            Label message = new Label();
            message.Dock = DockStyle.Fill;
            message.Margin = new Padding(0, 8, 0, 0);
            message.ForeColor = MutedColor;
            message.Font = new Font("Segoe UI", 9F, FontStyle.Regular, GraphicsUnit.Point);
            message.Text = bundled
                ? "Обновление уже есть в этом установщике.\r\nЗакройте Lolka, включая значок в трее.\r\nНажмите «Обновить», чтобы установить новую версию."
                : "Новая версия будет скачана с GitHub.\r\nПосле проверки файла откроется свежий установщик.\r\nСкачивание начнётся только после нажатия «Обновить».";
            message.TextAlign = ContentAlignment.MiddleLeft;
            message.AccessibleName = message.Text;

            Label skipHint = new Label();
            skipHint.Dock = DockStyle.Fill; skipHint.ForeColor = MutedColor;
            skipHint.Text = "«Пропустить» отложит обновление до следующего запуска.";
            skipHint.TextAlign = ContentAlignment.MiddleLeft;

            TableLayoutPanel actions = new TableLayoutPanel();
            actions.Dock = DockStyle.Fill;
            actions.Margin = Padding.Empty;
            actions.ColumnCount = 4;
            actions.RowCount = 1;
            actions.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            actions.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 112F));
            actions.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 8F));
            actions.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 112F));

            ModernButton updateButton = new ModernButton();
            updateButton.Text = "Обновить";
            updateButton.AccessibleName = updateButton.Text;
            updateButton.Dock = DockStyle.Fill;
            updateButton.Margin = Padding.Empty;
            updateButton.FillColor = AccentColor;
            updateButton.BorderColor = AccentColor;
            updateButton.ForeColor = Color.FromArgb(18, 37, 46);
            updateButton.Font = new Font(Font, FontStyle.Bold);
            updateButton.DialogResult = DialogResult.OK;

            ModernButton skipButton = new ModernButton();
            skipButton.Text = "Пропустить";
            skipButton.AccessibleName = skipButton.Text;
            skipButton.Dock = DockStyle.Fill;
            skipButton.Margin = Padding.Empty;
            skipButton.FillColor = Color.FromArgb(48, 50, 53);
            skipButton.BorderColor = Color.FromArgb(60, 62, 66);
            skipButton.ForeColor = TextColor;
            skipButton.DialogResult = DialogResult.Cancel;

            actions.Controls.Add(updateButton, 1, 0);
            actions.Controls.Add(skipButton, 3, 0);
            content.Controls.Add(card, 0, 0);
            content.Controls.Add(versionsCard, 0, 1);
            content.Controls.Add(message, 0, 2);
            content.Controls.Add(skipHint, 0, 3);
            content.Controls.Add(actions, 0, 5);
            Controls.Add(content);

            AcceptButton = updateButton;
            CancelButton = skipButton;
            FormClosing += delegate
            {
                if (DialogResult == DialogResult.None) DialogResult = DialogResult.Cancel;
            };
        }
        private static Label VersionLabel(string text, bool value, bool accent)
        {
            return new Label { Text = text, AccessibleName = text, Dock = DockStyle.Fill,
                Margin = Padding.Empty, TextAlign = ContentAlignment.MiddleLeft,
                ForeColor = accent ? AccentColor : value ? TextColor : MutedColor,
                Font = new Font("Segoe UI", value ? 10.5F : 9F, value ? FontStyle.Bold : FontStyle.Regular, GraphicsUnit.Point) };
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
    }
}
