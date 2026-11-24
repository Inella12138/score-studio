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
    private readonly string root = AppDomain.CurrentDomain.BaseDirectory;
    [STAThread]
    static void Main(string[] args) {
        if (args.Length == 1 && args[0] == "--self-test") {
            string root = AppDomain.CurrentDomain.BaseDirectory;
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
        ClientSize = new Size(480, 245);
        Font = new Font("Microsoft YaHei", 10);
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false;
        var title = new Label { Text = "简谱工坊 · 桌面版", AutoSize = true, Location = new Point(24, 24), Font = new Font(Font.FontFamily, 17) };
        status = new Label { Text = "正在启动本地编辑器…", Location = new Point(24, 70), Size = new Size(430, 48) };
        open = new Button { Text = "打开编辑器", Location = new Point(24, 130), Size = new Size(130, 38), Enabled = false };
        open.Click += delegate { OpenEditor(); };
        var scores = new Button { Text = "打开曲库文件夹", Location = new Point(164, 130), Size = new Size(140, 38) };
        scores.Click += delegate {
            Directory.CreateDirectory(Path.Combine(root, "scores"));
            Process.Start(new ProcessStartInfo(Path.Combine(root, "scores")) { UseShellExecute = true });
        };
        var install = new Button { Text = "安装 AutoHotkey", Location = new Point(314, 130), Size = new Size(140, 38) };
        install.Click += delegate { Install(); };
        var note = new Label { Text = "曲库：应用目录 / scores\n窗口可最小化；关闭本窗口会退出本地服务，请先保存曲谱。", Location = new Point(24, 185), Size = new Size(430, 50) };
        Controls.AddRange(new Control[] { title, status, open, scores, install, note });
        tray = new NotifyIcon { Icon = SystemIcons.Application, Text = "简谱工坊", Visible = true };
        tray.DoubleClick += delegate { Show(); WindowState = FormWindowState.Normal; Activate(); };
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
                    status.Text = "本地编辑器已就绪。更新曲库免登录；上传需要 GitHub 授权。"; open.Enabled = true;
                    if (!HasAhkV2() && MessageBox.Show(this, "未检测到已安装的 AutoHotkey v2。\n现在打开离线安装向导吗？选“否”可先编辑曲谱。", "首次使用", MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes) Install();
                    OpenEditor();
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
