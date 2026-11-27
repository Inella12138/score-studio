using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using Microsoft.Win32.SafeHandles;

// One bounded JSON plan on stdin; success is exit 0 and the exact versioned
// response below. No shell, recursive deletion, delete-on-close, or path unlink.
internal static partial class TrashDelete {
    const uint ReadAttributes = 0x80, ListDirectory = 1, Delete = 0x10000;
    const uint GenericRead = 0x80000000, GenericWrite = 0x40000000, ShareRead = 1, OpenExisting = 3, CreateNew = 1;
    const uint BackupSemantics = 0x02000000, OpenReparsePoint = 0x00200000;
    const uint DirectoryAttribute = 0x10, ReparseAttribute = 0x400;
    const int MaxInput = 1024 * 1024, MaxManifest = 64 * 1024;

    [DataContract] internal sealed class Item {
        [DataMember(Name = "path", IsRequired = true)] public string Path;
        [DataMember(Name = "ino", IsRequired = true)] public string Ino;
        [DataMember(Name = "dev", IsRequired = true)] public string Dev;
        [DataMember(Name = "size", IsRequired = true)] public string Size;
        [DataMember(Name = "mtime", IsRequired = true)] public string Mtime;
        [DataMember(Name = "ctime", IsRequired = true)] public string Ctime;
    }
    [DataContract] internal sealed class Plan {
        [DataMember(Name = "version", IsRequired = true)] public int Version;
        [DataMember(Name = "root", IsRequired = true)] public string Root;
        [DataMember(Name = "entry", IsRequired = true)] public string Entry;
        [DataMember(Name = "manifest", IsRequired = true)] public Item Manifest;
        [DataMember(Name = "manifestData", IsRequired = true)] public string ManifestData;
        [DataMember(Name = "files", IsRequired = true)] public Item[] Files;
        [DataMember(Name = "directories", IsRequired = true)] public Item[] Directories;
    }
    [DataContract] internal sealed class RecoveryFile {
        [DataMember(Name = "backupPath", IsRequired = true)] public string BackupPath;
    }
    [DataContract] internal sealed class RecoveryManifest {
        [DataMember(Name = "version", IsRequired = true)] public int Version;
        [DataMember(Name = "status", IsRequired = true)] public string Status;
        [DataMember(Name = "files", IsRequired = true)] public RecoveryFile[] Files;
    }
    [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint Low, High; }
    [StructLayout(LayoutKind.Sequential)] struct FileInfo {
        public uint Attributes;
        public FileTime Creation, Access, Write;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [StructLayout(LayoutKind.Sequential)] struct BasicInfo {
        public long Creation, Access, Write, Change;
        public uint Attributes;
    }
    [StructLayout(LayoutKind.Sequential)] struct Disposition {
        // FILE_DISPOSITION_INFO.DeleteFile is a one-byte Windows BOOLEAN.
        public byte DeleteFile;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security,
        uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int kind, out BasicInfo info, uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder name, uint size, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, ref Disposition info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadFile(SafeFileHandle handle, byte[] buffer, uint count, out uint read, IntPtr overlapped);

    // Erased by the compiler in production. Tests provide a partial definition
    // to stop at the actual disposition boundaries while all guards are held.
    static partial void BeforeDeleteForTest();
    static partial void BeforeManifestDeleteForTest();

    sealed class Held : IDisposable {
        public readonly string Path;
        public readonly SafeFileHandle Handle;
        public Held(string path, bool directory, bool deletable, Item expected) {
            Path = path;
            uint access = directory ? ReadAttributes | ListDirectory : GenericRead;
            if (deletable) access |= Delete;
            // Deny both write and delete sharing: this blocks rename, removal,
            // reparse-point installation and content edits for the entire plan.
            Handle = CreateFile(path, access, ShareRead, IntPtr.Zero, OpenExisting,
                BackupSemantics | OpenReparsePoint, IntPtr.Zero);
            if (Handle.IsInvalid) throw NativeError();
            try {
                FileInfo info;
                if (!GetFileInformationByHandle(Handle, out info)) throw NativeError();
                Require((info.Attributes & ReparseAttribute) == 0 &&
                    ((info.Attributes & DirectoryAttribute) != 0) == directory);
                var final = new StringBuilder(32768);
                uint length = GetFinalPathNameByHandle(Handle, final, (uint)final.Capacity, 0);
                Require(length > 0 && length < final.Capacity &&
                    String.Equals(final.ToString().TrimEnd('\\'), ("\\\\?\\" + path).TrimEnd('\\'),
                        StringComparison.OrdinalIgnoreCase));
                if (expected != null) {
                    Require(Number(expected.Ino) == ((ulong)info.IndexHigh << 32 | info.IndexLow) &&
                        Number(expected.Dev) == info.Volume);
                    if (!directory) {
                        BasicInfo basic;
                        if (!GetFileInformationByHandleEx(Handle, 0, out basic, (uint)Marshal.SizeOf(typeof(BasicInfo))))
                            throw NativeError();
                        Require(Number(expected.Size) == ((ulong)info.SizeHigh << 32 | info.SizeLow) &&
                            Number(expected.Mtime) == (ulong)basic.Write && Number(expected.Ctime) == (ulong)basic.Change);
                    }
                }
            } catch { Handle.Dispose(); throw; }
        }
        public void Remove() {
            var disposition = new Disposition { DeleteFile = 1 };
            if (!SetFileInformationByHandle(Handle, 4, ref disposition, 1)) throw NativeError();
            // Close immediately so the next empty-directory removal sees the
            // child gone. All its ancestors remain guarded.
            Handle.Dispose();
        }
        public void Dispose() { Handle.Dispose(); }
    }

    static Exception NativeError() { return new Win32Exception(Marshal.GetLastWin32Error()); }
    static void Require(bool condition) {
        if (!condition) throw new IOException("Artifact trash changed or is unsafe; recovery files preserved");
    }
    static ulong Number(string text) { return UInt64.Parse(text, NumberStyles.None, CultureInfo.InvariantCulture); }
    static T Decode<T>(byte[] bytes) {
        using (var stream = new MemoryStream(bytes))
            return (T)new DataContractJsonSerializer(typeof(T)).ReadObject(stream);
    }
    static bool Segment(string value) {
        if (String.IsNullOrEmpty(value) || value == "." || value == ".." ||
            value.EndsWith(".") || value.EndsWith(" ")) return false;
        return value.IndexOfAny(System.IO.Path.GetInvalidFileNameChars()) < 0;
    }
    static bool Backup(string value) {
        if (value == null) return false;
        string[] parts = value.Split('/');
        return parts.Length == 2 && (parts[0] == "scores" || parts[0] == "artifacts") && Segment(parts[1]);
    }
    static void ExactContents(string directory, IEnumerable<string> expected) {
        var names = new HashSet<string>(expected, StringComparer.Ordinal);
        string[] actual = System.IO.Directory.GetFileSystemEntries(directory);
        Require(actual.Length == names.Count);
        foreach (string child in actual) Require(names.Remove(System.IO.Path.GetFileName(child)));
        Require(names.Count == 0);
    }
    static void SameBytes(byte[] a, byte[] b) {
        Require(a.Length == b.Length);
        for (int i = 0; i < a.Length; i++) Require(a[i] == b[i]);
    }
    static void RestoreManifest(string path, byte[] bytes) {
        // The entry and every ancestor are still guarded. CREATE_NEW cannot
        // overwrite an unexpected file, hard link, symlink, or reparse point.
        using (SafeFileHandle handle = CreateFile(path, GenericWrite, ShareRead, IntPtr.Zero, CreateNew,
            OpenReparsePoint, IntPtr.Zero)) {
            if (handle.IsInvalid) throw NativeError();
            using (var stream = new FileStream(handle, FileAccess.Write)) {
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush(true);
            }
        }
    }
    static void Execute(Plan plan) {
        Guid entryId;
        Require(plan != null && plan.Version == 1 && plan.Root != null &&
            plan.Root.Length >= 3 && Char.IsLetter(plan.Root[0]) && plan.Root[1] == ':' && plan.Root[2] == '\\' &&
            String.Equals(System.IO.Path.GetFullPath(plan.Root), plan.Root, StringComparison.OrdinalIgnoreCase) &&
            plan.Entry != null && plan.Entry.Length == 36 && Guid.TryParseExact(plan.Entry, "D", out entryId) &&
            plan.Manifest != null && plan.Manifest.Path == "manifest.json" &&
            plan.Files != null && plan.Files.Length > 0 && plan.Files.Length <= 1024 &&
            plan.Directories != null && plan.Directories.Length >= 2 && plan.Directories.Length <= 3);
        byte[] manifestBytes = Convert.FromBase64String(plan.ManifestData);
        Require(manifestBytes.Length <= MaxManifest);
        var manifest = Decode<RecoveryManifest>(manifestBytes);
        Require(manifest.Version == 1 && manifest.Status == "complete" && manifest.Files != null &&
            manifest.Files.Length == plan.Files.Length);
        string entry = System.IO.Path.Combine(plan.Root, ".local", "artifact-trash", plan.Entry);
        var files = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var storages = new HashSet<string>(StringComparer.Ordinal);
        for (int i = 0; i < plan.Files.Length; i++) {
            Item item = plan.Files[i];
            Require(item != null && Backup(item.Path) && files.Add(item.Path) &&
                manifest.Files[i] != null && manifest.Files[i].BackupPath == item.Path);
            storages.Add(item.Path.Split('/')[0]);
        }
        Require(plan.Directories[0] != null && plan.Directories[0].Path == "" &&
            plan.Directories.Length == storages.Count + 1);
        var directoryNames = new HashSet<string>(StringComparer.Ordinal);
        for (int i = 1; i < plan.Directories.Length; i++)
            Require(plan.Directories[i] != null && storages.Contains(plan.Directories[i].Path) &&
                directoryNames.Add(plan.Directories[i].Path));

        var held = new List<Held>();
        try {
            // Acquire every ancestor in order, starting at the volume root.
            // Existing write/delete handles cause a sharing violation: fail closed.
            string current = System.IO.Path.GetPathRoot(entry);
            held.Add(new Held(current, true, false, null));
            string[] parts = entry.Substring(current.Length).Split('\\');
            for (int i = 0; i < parts.Length; i++) {
                Require(Segment(parts[i]));
                current = System.IO.Path.Combine(current, parts[i]);
                bool last = i == parts.Length - 1;
                held.Add(new Held(current, true, last, last ? plan.Directories[0] : null));
            }
            Held entryHandle = held[held.Count - 1];
            var storageHandles = new List<Held>();
            for (int i = 1; i < plan.Directories.Length; i++) {
                var directory = new Held(System.IO.Path.Combine(entry, plan.Directories[i].Path), true, true, plan.Directories[i]);
                held.Add(directory); storageHandles.Add(directory);
            }
            var manifestHandle = new Held(System.IO.Path.Combine(entry, "manifest.json"), false, true, plan.Manifest);
            held.Add(manifestHandle);
            byte[] actualManifest = new byte[manifestBytes.Length + 1];
            uint read;
            Require(ReadFile(manifestHandle.Handle, actualManifest, (uint)actualManifest.Length, out read, IntPtr.Zero));
            Require(read == manifestBytes.Length);
            Array.Resize(ref actualManifest, (int)read);
            SameBytes(manifestBytes, actualManifest);
            var fileHandles = new List<Held>();
            foreach (Item item in plan.Files) {
                var file = new Held(System.IO.Path.Combine(entry, item.Path.Replace('/', '\\')), false, true, item);
                held.Add(file); fileHandles.Add(file);
            }
            var expectedEntry = new List<string>(storages);
            expectedEntry.Add("manifest.json");
            ExactContents(entry, expectedEntry);
            foreach (string storage in storages) {
                var expected = new List<string>();
                foreach (Item item in plan.Files)
                    if (item.Path.StartsWith(storage + "/", StringComparison.Ordinal)) expected.Add(item.Path.Split('/')[1]);
                ExactContents(System.IO.Path.Combine(entry, storage), expected);
            }
            BeforeDeleteForTest();
            foreach (Held file in fileHandles) file.Remove();
            foreach (Held storage in storageHandles) {
                ExactContents(storage.Path, new string[0]);
                storage.Remove();
            }
            // Anything failing above leaves the original manifest in place.
            // Never remove unknown additions to make a directory become empty.
            ExactContents(entry, new[] { "manifest.json" });
            BeforeManifestDeleteForTest();
            manifestHandle.Remove();
            try { entryHandle.Remove(); }
            catch {
                // Directory contents can grow even with a directory handle
                // open. If final rmdir fails, retain the original recovery map
                // without touching the unexpected addition.
                RestoreManifest(System.IO.Path.Combine(entry, "manifest.json"), manifestBytes);
                throw;
            }
        } finally {
            for (int i = held.Count - 1; i >= 0; i--) held[i].Dispose();
        }
    }
    static int Main(string[] args) {
        try {
            Require(args.Length == 0);
            Console.InputEncoding = new UTF8Encoding(false, true);
            Console.OutputEncoding = new UTF8Encoding(false);
            var input = new StringBuilder();
            int next;
            while ((next = Console.In.Read()) >= 0 && next != '\n') {
                Require(input.Length < MaxInput);
                input.Append((char)next);
            }
            Execute(Decode<Plan>(Encoding.UTF8.GetBytes(input.ToString())));
            Console.Out.WriteLine("{\"version\":1,\"removed\":true}");
            return 0;
        } catch (Exception error) {
            Console.Error.WriteLine("Safe artifact trash deletion failed: " + error.Message);
            return 1;
        }
    }
}
