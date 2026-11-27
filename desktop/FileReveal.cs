using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Reflection;
using System.Threading;
using System.Collections;

internal static class FileReveal {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHParseDisplayName(string name, IntPtr bind, out IntPtr item, uint attributes, out uint found);
    [DllImport("shell32.dll")]
    private static extern int SHOpenFolderAndSelectItems(IntPtr item, uint count, IntPtr children, uint flags);
    [DllImport("shell32.dll")]
    private static extern IntPtr ILFindLastID(IntPtr item);
    [DllImport("ole32.dll")]
    private static extern int OleInitialize(IntPtr reserved);
    [DllImport("ole32.dll")]
    private static extern void OleUninitialize();
    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    private static object Get(object target, string name) {
        return target.GetType().InvokeMember(name, BindingFlags.GetProperty, null, target, null);
    }
    private static bool ShowFolder(string directory) {
        object shell = null, windows = null;
        try {
            shell = Activator.CreateInstance(Type.GetTypeFromProgID("Shell.Application"));
            windows = shell.GetType().InvokeMember("Windows", BindingFlags.InvokeMethod, null, shell, null);
            foreach (object window in (IEnumerable)windows) {
                try {
                    Uri location;
                    if (!Uri.TryCreate(Convert.ToString(Get(window, "LocationURL")), UriKind.Absolute, out location) ||
                        !location.IsFile || !string.Equals(Path.GetFullPath(location.LocalPath).TrimEnd('\\'),
                            directory.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) continue;
                    var handle = new IntPtr(Convert.ToInt64(Get(window, "HWND")));
                    ShowWindow(handle, 9); // Restore a minimized Explorer window.
                    SetForegroundWindow(handle);
                    return GetForegroundWindow() == handle;
                } catch { /* Other Shell windows may not expose a folder URL. */ }
                finally { if (Marshal.IsComObject(window)) Marshal.ReleaseComObject(window); }
            }
        } catch {}
        finally {
            if (windows != null && Marshal.IsComObject(windows)) Marshal.ReleaseComObject(windows);
            if (shell != null && Marshal.IsComObject(shell)) Marshal.ReleaseComObject(shell);
        }
        return false;
    }
    [STAThread]
    static int Main(string[] args) {
        IntPtr item = IntPtr.Zero, folder = IntPtr.Zero, children = IntPtr.Zero;
        bool initialized = false;
        try {
            if (args.Length != 1) return 2;
            string file = Path.GetFullPath(args[0]);
            if (!File.Exists(file) || !string.Equals(Path.GetExtension(file), ".ahk", StringComparison.OrdinalIgnoreCase)) return 3;
            if (OleInitialize(IntPtr.Zero) < 0) return 4;
            initialized = true;
            string directory = Path.GetDirectoryName(file);
            uint found;
            int hr = SHParseDisplayName(file, IntPtr.Zero, out item, 0, out found);
            if (hr < 0) return 4;
            hr = SHParseDisplayName(directory, IntPtr.Zero, out folder, 0, out found);
            if (hr < 0) return 4;
            children = Marshal.AllocCoTaskMem(IntPtr.Size);
            Marshal.WriteIntPtr(children, ILFindLastID(item));
            hr = SHOpenFolderAndSelectItems(folder, 1, children, 0);
            if (hr < 0) return 5;
            for (int attempt = 0; attempt < 30; attempt++) {
                if (ShowFolder(directory)) return 0;
                if (attempt == 10)
                    Process.Start(new ProcessStartInfo(directory) { UseShellExecute = true });
                Thread.Sleep(100);
            }
            // A successful Shell request alone does not confirm that a window appeared.
            return 7;
        } catch { return 6; }
        finally {
            if (children != IntPtr.Zero) Marshal.FreeCoTaskMem(children);
            if (folder != IntPtr.Zero) Marshal.FreeCoTaskMem(folder);
            if (item != IntPtr.Zero) Marshal.FreeCoTaskMem(item);
            if (initialized) OleUninitialize();
        }
    }
}
