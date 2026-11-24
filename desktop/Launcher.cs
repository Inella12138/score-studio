using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32;
using System.Threading;
using System.Security.Cryptography;

internal class Launcher : Form {
    private Process server;
    private string url;
    private Label status;
    private Button open;
    private NotifyIcon tray;
    private bool exiting;
    private readonly string root = AppDomain.CurrentDomain.BaseDirectory;
    [STAThread]
    static void Main(string[] args) {
        if (args.Length >= 1 && args[0] == "--self-test") {
            string root = args.Length == 2 ? Path.GetFullPath(args[1]) : AppDomain.CurrentDomain.BaseDirectory;
            if (!File.Exists(Path.Combine(root, "bin", "node.exe")) ||
                !File.Exists(Path.Combine(root, "desktop", "server.js")) ||
                !File.Exists(Path.Combine(root, "index.html"))) Environment.Exit(2);
            var check = Process.Start(new ProcessStartInfo(Path.Combine(root, "bin", "node.exe"),
                "--check \"" + Path.Combine(root, "desktop", "server.js") + "\"") {
                UseShellExecute = false, CreateNoWindow = true
            });
            check.WaitForExit(); Environment.Exit(check.ExitCode); return;
        }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        string key;
        using (var sha = SHA256.Create()) key = BitConverter.ToString(sha.ComputeHash(
            Encoding.UTF8.GetBytes(Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory).ToUpperInvariant()))).Replace("-", "");
        bool created;
        using (var mutex = new Mutex(true, @"Local\ScoreStudio-" + key, out created)) {
            if (!created) {
                MessageBox.Show("此目录的简谱工坊已经启动，请使用现有窗口或任务栏图标。", "简谱工坊");
                return;
            }
            try { Application.Run(new Launcher()); }
            finally { mutex.ReleaseMutex(); }
        }
    }
    Launcher() {
        Text = "简谱工坊";
        Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        ClientSize = new Size(640, 410);
        Font = new Font("Microsoft YaHei", 10);
        BackColor = Color.FromArgb(246, 248, 240);
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false;
        var artwork = new PictureBox { Image = Icon.ToBitmap(), SizeMode = PictureBoxSizeMode.Zoom, Location = new Point(34, 34), Size = new Size(70, 70) };
        var caption = new Label { Text = "S C O R E   S T U D I O", AutoSize = true, Location = new Point(125, 33), Font = new Font("Segoe UI", 8), ForeColor = Color.FromArgb(133, 149, 119) };
        var title = new Label { Text = "简谱工坊", AutoSize = true, Location = new Point(120, 54), Font = new Font(Font.FontFamily, 25), ForeColor = Color.FromArgb(40, 67, 48) };
        var subtitle = new Label { Text = "写下旋律，一起演奏。", AutoSize = true, Location = new Point(35, 130), ForeColor = Color.FromArgb(126, 141, 113), Font = new Font(Font.FontFamily, 11) };
        var card = new Panel { BackColor = Color.White, Location = new Point(35, 170), Size = new Size(570, 75) };
        var dot = new Label { Text = "●", Location = new Point(16, 19), Size = new Size(25, 25), ForeColor = Color.FromArgb(88, 131, 82) };
        status = new Label { Text = "正在准备你的音乐空间…", Location = new Point(48, 16), Size = new Size(500, 49), ForeColor = Color.FromArgb(87, 107, 77) };
        card.Controls.AddRange(new Control[] { dot, status });
        open = new Button { Text = "打开我的曲库   →", Location = new Point(35, 269), Size = new Size(230, 47), Enabled = false,
            FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(49, 99, 69), ForeColor = Color.White };
        open.FlatAppearance.BorderSize = 0;
        open.Click += delegate { OpenEditor(); };
        var scores = new Button { Text = "本地文件", Location = new Point(279, 269), Size = new Size(145, 47), FlatStyle = FlatStyle.Flat, BackColor = Color.White, ForeColor = Color.FromArgb(91, 113, 78) };
        scores.FlatAppearance.BorderColor = Color.FromArgb(220, 229, 210);
        scores.Click += delegate {
            Directory.CreateDirectory(Path.Combine(root, "scores"));
            Process.Start(new ProcessStartInfo(Path.Combine(root, "scores")) { UseShellExecute = true });
        };
        var install = new Button { Text = "安装演奏环境", Location = new Point(437, 269), Size = new Size(168, 47), FlatStyle = FlatStyle.Flat, BackColor = Color.White, ForeColor = Color.FromArgb(91, 113, 78) };
        install.FlatAppearance.BorderColor = Color.FromArgb(220, 229, 210);
        install.Click += delegate { Install(); };
        var note = new Label { Text = "本地优先  ·  曲库同步  ·  声部脚本归档\n启动后此窗口自动收起；双击托盘图标可重新打开。", Location = new Point(36, 344), Size = new Size(570, 48), Font = new Font(Font.FontFamily, 9), ForeColor = Color.FromArgb(146, 156, 134) };
        Controls.AddRange(new Control[] { artwork, caption, title, subtitle, card, open, scores, install, note });
        tray = new NotifyIcon { Icon = this.Icon, Text = "简谱工坊", Visible = true };
        tray.DoubleClick += delegate { Show(); WindowState = FormWindowState.Normal; Activate(); };
        var menu = new ContextMenuStrip();
        menu.Items.Add("打开曲库", null, delegate { OpenEditor(); });
        menu.Items.Add("显示启动面板", null, delegate { Show(); WindowState = FormWindowState.Normal; Activate(); });
        menu.Items.Add("退出简谱工坊", null, delegate {
            if (MessageBox.Show("退出会停止曲库服务。请确认曲谱已保存。", "退出简谱工坊", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) == DialogResult.OK) {
                exiting = true; Close();
            }
        });
        tray.ContextMenuStrip = menu;
        FormClosing += delegate(object sender, FormClosingEventArgs e) {
            if (!exiting && e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; Hide(); }
        };
        Shown += delegate { StartServer(); };
        FormClosed += delegate {
            tray.Dispose();
            try { if (server != null && !server.HasExited) server.Kill(); } catch {}
        };
    }
    void StartServer() {
        try {
            Directory.CreateDirectory(Path.Combine(root, "scores"));
            string node = Path.Combine(root, "bin", "node.exe");
            if (!File.Exists(node)) throw new Exception("缺少运行环境 bin/node.exe。请完整解压桌面发行包，或运行 desktop/build.ps1。");
            server = new Process { StartInfo = new ProcessStartInfo(node, "\"" + Path.Combine(root, "desktop", "server.js") + "\"") {
                WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8
            }, EnableRaisingEvents = true };
            bool started = false;
            server.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) {
                if (e.Data != null && e.Data.StartsWith("READY ") && !IsDisposed) BeginInvoke((Action)delegate {
                    if (started) return; started = true; url = e.Data.Substring(6);
                    if (!url.StartsWith("http://127.0.0.1:")) return;
                    status.Text = "曲库已就绪。\n曲谱、声部与演奏脚本，都在你的音乐空间。"; open.Enabled = true;
                    if (!HasAhkV2() && MessageBox.Show(this, "未检测到已安装的 AutoHotkey v2。\n现在打开离线安装向导吗？选“否”可先编辑曲谱。", "首次使用", MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes) Install();
                    OpenEditor();
                    Hide();
                });
            };
            server.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { /* No credentials or runtime internals are shown. */ };
            server.Exited += delegate { if (!IsDisposed && IsHandleCreated) BeginInvoke((Action)delegate { status.Text = "本地服务已退出。请关闭并重新打开应用。"; open.Enabled = false; }); };
            server.Start(); server.BeginOutputReadLine(); server.BeginErrorReadLine();
        } catch (Exception e) { status.Text = e.Message; MessageBox.Show(this, e.Message, "启动失败"); }
    }
    static bool HasAhkV2() {
        foreach (RegistryHive hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
            foreach (RegistryView view in new[] { RegistryView.Registry64, RegistryView.Registry32 }) {
                try {
                    using (var baseKey = RegistryKey.OpenBaseKey(hive, view))
                    using (var key = baseKey.OpenSubKey(@"Software\AutoHotkey")) {
                        string dir = key == null ? null : key.GetValue("InstallDir") as string;
                        if (dir != null && IsV2(dir)) return true;
                    }
                } catch {}
            }
        foreach (string dir in new[] {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "AutoHotkey"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "AutoHotkey")
        }) if (IsV2(dir)) return true;
        return false;
    }
    static bool IsV2(string dir) {
        foreach (string relative in new[] { @"v2\AutoHotkey64.exe", @"v2\AutoHotkey32.exe", "AutoHotkey64.exe", "AutoHotkey32.exe" }) {
            string exe = Path.Combine(dir, relative);
            if (File.Exists(exe)) {
                try { if (FileVersionInfo.GetVersionInfo(exe).FileMajorPart == 2) return true; } catch {}
            }
        }
        return false;
    }
    void Install() {
        try {
            string helper = Path.Combine(root, "install-autohotkey.ps1");
            Process.Start(new ProcessStartInfo("powershell.exe", "-NoLogo -NoProfile -File \"" + helper + "\"") { UseShellExecute = true, WindowStyle = ProcessWindowStyle.Normal });
        } catch (Exception e) { MessageBox.Show(this, "无法打开安装向导：" + e.Message); }
    }
    void OpenEditor() {
        if (url == null) return;
        string edge = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Microsoft\Edge\Application\msedge.exe");
        string chrome = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Google\Chrome\Application\chrome.exe");
        string browser = File.Exists(edge) ? edge : File.Exists(chrome) ? chrome : null;
        try {
            if (browser != null) Process.Start(new ProcessStartInfo(browser, "--app=\"" + url + "\" --new-window") { UseShellExecute = true });
            else Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        } catch (Exception e) { MessageBox.Show(this, "无法打开编辑器：" + e.Message); }
    }
}
