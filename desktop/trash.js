"use strict";
const fs = require("node:fs/promises"), path = require("node:path");
const childProcess = require("node:child_process");
const { constants } = require("node:fs"), { Artifacts } = require("./artifacts");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_MANIFEST = 64 * 1024;
function uuid(value) { return typeof value === "string" && value.length === 36 && UUID.test(value); }
function inside(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
    throw new Error("Invalid artifact trash path");
  return target;
}
function segment(value) {
  return typeof value === "string" && value.length > 0 && value !== "." && value !== ".." &&
    !/[<>:"/\\|?*\x00-\x1f\x7f]/.test(value) && !/[. ]$/.test(value) &&
    !/^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(value);
}
function identity(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
}
function sameFile(a, b) {
  return identity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function sameNames(actual, expected) {
  const sorted = expected.slice().sort();
  return actual.length === sorted.length && actual.sort().every((name, i) => name === sorted[i]);
}
function changed() { return new Error("Artifact trash changed or is unsafe; recovery files preserved"); }
class ArtifactTrash {
  constructor(library) {
    this.library = library;
    this.root = path.resolve(library.root);
    this.trashRoot = path.join(this.root, ".local", "artifact-trash");
    this.artifacts = new Artifacts({ root: this.root });
  }
  async checked(file) {
    inside(this.root, file);
    // Check from the volume root, including ancestors above the library root.
    const volume = path.parse(file).root, parts = path.relative(volume, file).split(path.sep);
    let current = volume, stat = await fs.lstat(volume, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw changed();
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      stat = await fs.lstat(current, { bigint: true });
      if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory())) throw changed();
    }
    return stat;
  }
  async manifest(dir) {
    const file = inside(dir, path.join(dir, "manifest.json")), before = await this.checked(file);
    if (!before.isFile() || before.size > MAX_MANIFEST) throw changed();
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      if (!sameFile(before, await handle.stat({ bigint: true }))) throw changed();
      const buffer = Buffer.alloc(MAX_MANIFEST + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_MANIFEST || BigInt(length) !== before.size || !sameFile(before, await handle.stat({ bigint: true })) ||
          !sameFile(before, await this.checked(file))) throw changed();
      return { path: file, stat: before, data: buffer.subarray(0, length) };
    } finally { await handle.close(); }
  }
  async inspect(name) {
    if (!uuid(name)) throw changed();
    const dir = inside(this.trashRoot, path.join(this.trashRoot, name));
    if (path.dirname(dir) !== this.trashRoot) throw changed();
    const stat = await this.checked(dir);
    if (!stat.isDirectory()) throw changed();
    const manifest = await this.manifest(dir), value = JSON.parse(manifest.data.toString("utf8"));
    if (!value || Array.isArray(value) || value.version !== 1 || !uuid(value.id) ||
        typeof value.scoreName !== "string" || !value.scoreName.endsWith(".score.json") ||
        value.status !== "complete" || !Array.isArray(value.files) || !value.files.length) throw changed();
    const locations = new Map(this.artifacts.locations(value.scoreName).map(storage =>
      [storage.location, path.relative(this.root, storage.dir).split(path.sep).join("/")]));
    const files = [], originals = new Set(), backups = new Set(), storageNames = new Set();
    for (const record of value.files) {
      if (!record || Array.isArray(record) || typeof record.originalPath !== "string" || typeof record.backupPath !== "string")
        throw changed();
      const original = record.originalPath.split("/"), backup = record.backupPath.split("/");
      if (original.length !== 3 || backup.length !== 2 || !original.every(segment) || !backup.every(segment) ||
          !locations.has(original[0]) || original.slice(0, 2).join("/") !== locations.get(original[0]) ||
          backup[0] !== original[0] || backup[1] !== original[2] ||
          originals.has(record.originalPath.toLowerCase()) || backups.has(record.backupPath.toLowerCase())) throw changed();
      originals.add(record.originalPath.toLowerCase()); backups.add(record.backupPath.toLowerCase());
      storageNames.add(backup[0]);
      const file = inside(dir, path.resolve(dir, ...backup));
      inside(this.trashRoot, file);
      const fileStat = await this.checked(file);
      if (!fileStat.isFile()) throw changed();
      files.push({ path: file, stat: fileStat });
    }
    const directories = [{ path: dir, stat }];
    for (const storage of storageNames) {
      const target = inside(dir, path.join(dir, storage)), storageStat = await this.checked(target);
      if (!storageStat.isDirectory()) throw changed();
      directories.push({ path: target, stat: storageStat });
    }
    const plan = { dir, manifest, files, directories,
      bytes: Number(manifest.stat.size + files.reduce((sum, file) => sum + file.stat.size, 0n)) };
    await this.recheck(plan, files, directories);
    return plan;
  }
  async recheck(plan, files, directories) {
    inside(this.trashRoot, plan.dir);
    const manifest = await this.manifest(plan.dir);
    if (!manifest.data.equals(plan.manifest.data) || !sameFile(manifest.stat, plan.manifest.stat)) throw changed();
    for (const directory of directories) {
      inside(this.trashRoot, directory.path);
      if (!identity(directory.stat, await this.checked(directory.path))) throw changed();
      const expected = [...files, plan.manifest, ...directories.filter(item => item.path !== plan.dir)]
        .filter(item => path.dirname(item.path) === directory.path).map(item => path.basename(item.path));
      if (!sameNames(await fs.readdir(directory.path), expected)) throw changed();
    }
    for (const file of files) {
      inside(plan.dir, file.path);
      if (!sameFile(file.stat, await this.checked(file.path))) throw changed();
    }
  }
  async scan() {
    let stat;
    try { stat = await this.checked(this.trashRoot); }
    catch (error) { if (error.code === "ENOENT") return { plans: [], count: 0, bytes: 0, protectedCount: 0 }; throw error; }
    if (!stat.isDirectory()) throw changed();
    const plans = [];
    let protectedCount = 0;
    for (const name of await fs.readdir(this.trashRoot)) {
      try { plans.push(await this.inspect(name)); }
      catch { protectedCount++; }
    }
    return { plans, count: plans.length, bytes: plans.reduce((sum, plan) => sum + plan.bytes, 0), protectedCount };
  }
  async summary() {
    // Bytes include the manifest and mapped backups; protected entries are excluded.
    const { count, bytes, protectedCount } = await this.scan();
    return { count, bytes, protectedCount };
  }
  async remove(plan) {
    // Path checks alone cannot authorize unlink: a junction can change after the
    // last check. The Windows helper holds all verified handles until completion.
    if (process.platform !== "win32") throw new Error("Safe artifact trash deletion requires Windows");
    await this.recheck(plan, plan.files, plan.directories);
    const snapshot = item => ({
      path: path.relative(plan.dir, item.path).split(path.sep).join("/"),
      ino: item.stat.ino.toString(), dev: item.stat.dev.toString(), size: item.stat.size.toString(),
      mtime: (item.stat.mtimeNs / 100n + 116444736000000000n).toString(),
      ctime: (item.stat.ctimeNs / 100n + 116444736000000000n).toString()
    });
    const input = JSON.stringify({ version: 1, root: this.root, entry: path.basename(plan.dir),
      manifest: snapshot(plan.manifest), manifestData: plan.manifest.data.toString("base64"),
      files: plan.files.map(snapshot), directories: plan.directories.map(snapshot) });
    if (Buffer.byteLength(input, "utf8") > 1024 * 1024) throw changed();
    await this.invokeDelete(input);
  }
  async invokeDelete(input) {
    const helper = path.resolve(__dirname, "..", "bin", "ScoreTrashDelete.exe");
    await new Promise((resolve, reject) => {
      const child = childProcess.execFile(helper, [], {
        windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024, encoding: "utf8"
      }, (error, stdout) => {
        if (error) return reject(new Error("Safe artifact trash deletion failed; recovery files preserved", { cause: error }));
        if (stdout.trim() !== '{"version":1,"removed":true}') return reject(changed());
        resolve();
      });
      // Spawn failures also emit a stdin error; observe it without masking the
      // execFile result. Never fall back to path-based or shell deletion.
      child.stdin.on("error", () => {});
      child.stdin.end(input + "\n", "utf8");
    });
  }
  async empty(options) {
    if (!options || typeof options !== "object" || Array.isArray(options) || options.confirm !== true)
      throw new Error("Emptying artifact trash requires confirm: true");
    return this.library.exclusive(async () => {
      const { plans } = await this.scan();
      let removedCount = 0, removedBytes = 0;
      for (const plan of plans) {
        // Revalidate the whole entry after enumeration and before its first mutation.
        await this.recheck(plan, plan.files, plan.directories);
        await this.remove(plan);
        removedCount++; removedBytes += plan.bytes;
      }
      // Return the remaining summary alongside totals actually removed in this call.
      return { ...await this.summary(), removedCount, removedBytes };
    });
  }
}
module.exports = { ArtifactTrash };
