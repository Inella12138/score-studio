"use strict";
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const C = require("../core");
const MAX_SCRIPT = 16 * 1024 * 1024, MAX_METADATA = 64 * 1024;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INVALID_FILE = /[<>:"/\\|?*\x00-\x1f\x7f]/;
const DEVICE_FILE = /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i;
function truncate(text, limit) {
  let result = "";
  for (const character of text) {
    if (Buffer.byteLength(result + character) > limit) break;
    result += character;
  }
  return result;
}
function readable(text, fallback) {
  return truncate(text.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "-").replace(/\s+/g, " ").trim(), 64)
    .replace(/^[. ]+|[. ]+$/g, "") || fallback;
}
function safeFileName(name) {
  return typeof name === "string" && name === path.basename(name) && Buffer.byteLength(name) <= 240 &&
    !INVALID_FILE.test(name) && !/^[.]|[. ]$/.test(name) &&
    !DEVICE_FILE.test(name);
}
async function checkedPath(root, file) {
  root = path.resolve(root); file = path.resolve(file);
  const relative = path.relative(root, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Invalid storage path");
  let current = root;
  for (const part of ["", ...relative.split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("Symlink storage is not allowed"); }
    catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  return file;
}
async function boundedRead(root, file, limit) {
  await checkedPath(root, file);
  const handle = await fs.open(file, require("node:fs").constants.O_RDONLY | (require("node:fs").constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error("Stored file is invalid or too large");
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error("Stored file is too large");
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}
class Artifacts {
  constructor(library) { this.library = library; this.root = library.root; }
  stem(name) {
    // Reuse the score namespace validation without a module initialization cycle.
    require("./library").safeName(name);
    const stem = name.slice(0, -".score.json".length);
    // Encode terminal dots/spaces to keep distinct stems distinct on Windows.
    return stem.replace(/%/g, "%25").replace(/[. ]+$/, tail => [...tail].map(c => c === "." ? "%2E" : "%20").join(""));
  }
  directory(name) {
    // Reserve "~" for bounded names so a literal stem cannot alias a hashed one.
    let folder = this.stem(name).replace(/~/g, "%7E");
    if (Buffer.byteLength(folder) > 200) folder = truncate(folder, 160) + "~" + crypto.createHash("sha256").update(name).digest("hex").slice(0, 32);
    return path.join(this.root, "scores", folder + ".exports");
  }
  legacyDirectory(name) {
    let folder = this.stem(name);
    if (Buffer.byteLength(folder) > 240) folder = "score-" + crypto.createHash("sha256").update(name).digest("hex").slice(0, 32);
    return path.join(this.root, "artifacts", folder);
  }
  locations(name) {
    return [{ dir: this.directory(name), location: "scores" }, { dir: this.legacyDirectory(name), location: "artifacts" }];
  }
  relative(file) { return path.relative(path.resolve(this.root), path.resolve(file)).split(path.sep).join("/"); }
  checkId(id) {
    if (typeof id !== "string" || !ID.test(id)) throw new Error("Invalid artifact ID");
  }
  async load(name, id, storage) {
    this.checkId(id);
    const metadataPath = path.join(storage.dir, `${id}.json`);
    const m = JSON.parse((await boundedRead(this.root, metadataPath, MAX_METADATA)).toString("utf8"));
    if (!m || typeof m !== "object" || Array.isArray(m) || m.id !== id || m.scoreName !== name || !safeFileName(m.fileName) ||
        (storage.location === "artifacts" ? m.fileName !== `${id}.ahk` : !m.fileName.endsWith(`-${id.slice(0, 8)}.ahk`)) ||
        typeof m.title !== "string" || !Array.isArray(m.voiceNames) || m.voiceNames.some(v => typeof v !== "string") ||
        !["tap", "hold"].includes(m.mode) || typeof m.sourceSha !== "string" || !/^[a-f0-9]{40}$/.test(m.sourceSha) ||
        typeof m.createdAt !== "string" || !Number.isFinite(Date.parse(m.createdAt)) ||
        !Number.isInteger(m.size) || m.size < 0 || m.size > MAX_SCRIPT)
      throw new Error("Invalid artifact metadata");
    const scriptPath = path.join(storage.dir, m.fileName);
    const data = await boundedRead(this.root, scriptPath, MAX_SCRIPT);
    if (data.length !== m.size) throw new Error("Artifact size mismatch");
    return { storage, scriptPath, metadataPath, data, metadata: m };
  }
  describe(entry, currentSha) {
    return { ...entry.metadata, location: entry.storage.location, relativePath: this.relative(entry.scriptPath),
      stale: entry.metadata.sourceSha !== currentSha };
  }
  async locate(name, id) {
    this.checkId(id);
    const found = [];
    let error;
    for (const storage of this.locations(name)) {
      await checkedPath(this.root, storage.dir);
      try { found.push(await this.load(name, id, storage)); }
      catch (e) { if (e.code !== "ENOENT") error ||= e; }
    }
    if (!found.length) throw error || new Error("Artifact not found");
    return found;
  }
  async metadata(name, id) {
    return (await this.locate(name, id))[0].metadata;
  }
  async list(name, currentSha) {
    const locations = this.locations(name);
    if (currentSha === undefined) currentSha = (await this.library.read(name)).sha;
    const artifacts = new Map();
    for (const storage of locations) {
      await checkedPath(this.root, storage.dir);
      let entries;
      try { entries = await fs.readdir(storage.dir, { withFileTypes: true }); }
      catch (e) { if (e.code === "ENOENT") continue; throw e; }
      for (const entry of entries) {
        const id = entry.name.slice(0, -5);
        if (!entry.isFile() || !entry.name.endsWith(".json") || !ID.test(id) || artifacts.has(id)) continue;
        try { artifacts.set(id, this.describe(await this.load(name, id, storage), currentSha)); }
        catch { /* Incomplete or damaged pairs are not library variants. */ }
      }
    }
    return [...artifacts.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }
  async read(name, id) {
    const saved = await this.library.read(name), entry = (await this.locate(name, id))[0];
    return { script: entry.data.toString("utf8"), metadata: this.describe(entry, saved.sha) };
  }
  async remove(name, id) {
    return this.library.exclusive(() => this.removeLocked(name, id));
  }
  async removeLocked(name, id, staleOnly = false) {
    const saved = await this.library.read(name);
    const entries = (await this.locate(name, id)).filter(entry => !staleOnly || entry.metadata.sourceSha !== saved.sha);
    // A duplicated ID is one variant; retain any current copy during stale cleanup.
    if (!entries.length) return null;
    const trashId = crypto.randomUUID(), base = path.join(this.root, ".local", "artifact-trash"), dir = path.join(base, trashId);
    await checkedPath(this.root, dir);
    await fs.mkdir(base, { recursive: true });
    await checkedPath(this.root, base);
    await fs.mkdir(dir);
    const files = [];
    for (const entry of entries) {
      const dest = path.join(dir, entry.storage.location);
      await checkedPath(this.root, dest);
      await fs.mkdir(dest);
      for (const original of [entry.scriptPath, entry.metadataPath])
        files.push({ originalPath: this.relative(original), backupPath: `${entry.storage.location}/${path.basename(original)}` });
    }
    const manifestPath = path.join(dir, "manifest.json");
    const manifest = { version: 1, id, scoreName: name, deletedAt: new Date().toISOString(), status: "pending", files };
    const writeManifest = async (create = false) => {
      await checkedPath(this.root, manifestPath);
      const json = JSON.stringify(manifest, null, 2) + "\n";
      if (create) return fs.writeFile(manifestPath, json, { encoding: "utf8", flag: "wx" });
      // Preserve the original recovery map if a status update cannot be written.
      const temp = await checkedPath(this.root, `${manifestPath}.${crypto.randomUUID()}.tmp`);
      try {
        await fs.writeFile(temp, json, { encoding: "utf8", flag: "wx" });
        await checkedPath(this.root, manifestPath);
        await fs.rename(temp, manifestPath);
      } finally { await fs.unlink(temp).catch(() => {}); }
    };
    await writeManifest(true);
    const moved = [];
    try {
      // Validate the pairs again after preparing recovery storage and before moving.
      for (const entry of entries) {
        const latest = await this.load(name, id, entry.storage);
        if (!isDeepStrictEqual(latest.metadata, entry.metadata) || !latest.data.equals(entry.data))
          throw new Error("Artifact changed during removal");
      }
      for (const file of files) {
        const from = await checkedPath(this.root, path.join(this.root, file.originalPath));
        const to = await checkedPath(this.root, path.join(dir, file.backupPath));
        // External editors do not use the library lock; recheck at each mutation.
        const currentSha = (await this.library.read(name)).sha;
        if (staleOnly && entries.some(entry => entry.metadata.sourceSha === currentSha)) {
          const error = new Error("Artifact is current; cleanup skipped");
          error.code = "ARTIFACT_CURRENT";
          throw error;
        }
        await fs.rename(from, to);
        moved.push(file);
      }
      manifest.status = "complete";
      await writeManifest();
    } catch (error) {
      const rollbackErrors = [];
      for (const file of [...moved].reverse()) {
        try {
          const from = await checkedPath(this.root, path.join(dir, file.backupPath));
          const to = await checkedPath(this.root, path.join(this.root, file.originalPath));
          try { await fs.lstat(to); throw new Error("Original path is occupied"); }
          catch (e) { if (e.code !== "ENOENT") throw e; }
          await fs.rename(from, to);
        } catch (e) { rollbackErrors.push(e.message); }
      }
      manifest.status = rollbackErrors.length ? "rollback-incomplete" : "rolled-back";
      manifest.error = error.message;
      if (rollbackErrors.length) manifest.rollbackErrors = rollbackErrors;
      await writeManifest().catch(() => {});
      if (rollbackErrors.length) throw new Error(`${error.message}; recovery required at ${this.relative(manifestPath)}`);
      if (error.code === "ARTIFACT_CURRENT") return null;
      throw error;
    }
    return { removed: true, name, id, trashPath: this.relative(dir), manifestPath: this.relative(manifestPath) };
  }
  async cleanStale(name) {
    return this.library.exclusive(async () => {
      const candidates = await this.list(name), removed = [];
      // Consider all IDs: the source may have changed since enumeration.
      for (const candidate of candidates) {
        const result = await this.removeLocked(name, candidate.id, true);
        if (result) removed.push(result);
      }
      return { count: removed.length, removed };
    });
  }
  async export(request) {
    return this.library.exclusive(async () => {
      if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("Invalid export request");
      const { name, expectedSha, project, selected, mode, options = {} } = request;
      const dir = this.directory(name), saved = await this.library.read(name);
      if (typeof expectedSha !== "string" || expectedSha !== saved.sha) throw new Error("Saved score changed; reopen before exporting");
      const serialized = JSON.stringify(project);
      if (!serialized || Buffer.byteLength(serialized) > 4 * 1024 * 1024 ||
          !isDeepStrictEqual(JSON.parse(serialized), saved.project)) throw new Error("Save project changes before exporting");
      if (!Array.isArray(selected) || !selected.length || selected.length > saved.project.voices.length ||
          new Set(selected).size !== selected.length || selected.some(id => !saved.project.voices.some(v => v.id === id)))
        throw new Error("Invalid selected voice IDs");
      if (!["tap", "hold"].includes(mode)) throw new Error("Invalid artifact mode");
      if (!options || typeof options !== "object" || Array.isArray(options) ||
          (options.schedule !== undefined && (typeof options.schedule !== "string" || !/^(\d{14})?$/.test(options.schedule))) ||
          (options.startDelay !== undefined && (typeof options.startDelay !== "number" || !Number.isFinite(options.startDelay) || options.startDelay < 0 || options.startDelay > 60)))
        throw new Error("Invalid artifact options");
      const compiled = C.compile(saved.project), plan = C.makeEvents(saved.project, compiled, selected, mode);
      const script = "\uFEFF" + C.ahk(saved.project, plan, { schedule: options.schedule, startDelay: options.startDelay });
      const size = Buffer.byteLength(script), id = crypto.randomUUID();
      if (size > MAX_SCRIPT) throw new Error("Exported script is too large");
      const voiceNames = saved.project.voices.filter(v => selected.includes(v.id)).map(v => v.name);
      let label = readable(saved.project.title, "score") + "-" + readable(voiceNames.join("+"), "voices");
      if (DEVICE_FILE.test(label)) label = "score-" + label;
      const metadata = { id, title: saved.project.title, scoreName: name, sourceSha: saved.sha,
        voiceNames,
        mode, modeRuleCount: (saved.project.modes || []).length,
        createdAt: new Date().toISOString(), fileName: `${label}-${mode}-${id.slice(0, 8)}.ahk`, size };
      const json = JSON.stringify(metadata, null, 2) + "\n";
      if (Buffer.byteLength(json) > MAX_METADATA) throw new Error("Artifact metadata is too large");
      await checkedPath(this.root, dir);
      await fs.mkdir(dir, { recursive: true });
      await checkedPath(this.root, dir);
      // Recheck after compilation and directory creation, before committing the pair.
      if ((await this.library.read(name)).sha !== saved.sha) throw new Error("Saved score changed during export");
      const scriptPath = path.join(dir, metadata.fileName), metadataPath = path.join(dir, `${id}.json`);
      await fs.writeFile(scriptPath, script, { encoding: "utf8", flag: "wx" });
      try { await fs.writeFile(metadataPath, json, { encoding: "utf8", flag: "wx" }); }
      catch (e) { await fs.unlink(scriptPath).catch(() => {}); throw e; }
      return { script, metadata: this.describe({ metadata, scriptPath, storage: { location: "scores" } }, saved.sha) };
    });
  }
}
module.exports = { Artifacts, checkedPath, boundedRead };
