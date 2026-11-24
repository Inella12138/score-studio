"use strict";
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const C = require("../core");
const MAX_SCRIPT = 16 * 1024 * 1024, MAX_METADATA = 64 * 1024;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
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
  directory(name) {
    // Reuse the score namespace validation without a module initialization cycle.
    require("./library").safeName(name);
    const stem = name.slice(0, -".score.json".length);
    // Encode terminal dots/spaces to keep distinct stems distinct on Windows.
    let folder = stem.replace(/%/g, "%25").replace(/[. ]+$/, tail => [...tail].map(c => c === "." ? "%2E" : "%20").join(""));
    if (Buffer.byteLength(folder) > 240) folder = "score-" + crypto.createHash("sha256").update(name).digest("hex").slice(0, 32);
    return path.join(this.root, "artifacts", folder);
  }
  async metadata(name, id) {
    if (typeof id !== "string" || !ID.test(id)) throw new Error("Invalid artifact ID");
    const dir = this.directory(name);
    const m = JSON.parse((await boundedRead(this.root, path.join(dir, `${id}.json`), MAX_METADATA)).toString("utf8"));
    if (m.id !== id || m.scoreName !== name || m.fileName !== `${id}.ahk` ||
        typeof m.title !== "string" || !Array.isArray(m.voiceNames) || m.voiceNames.some(v => typeof v !== "string") ||
        !["tap", "hold"].includes(m.mode) || !/^[a-f0-9]{40}$/.test(m.sourceSha) ||
        !Number.isFinite(Date.parse(m.createdAt)) || !Number.isInteger(m.size) || m.size < 0 || m.size > MAX_SCRIPT)
      throw new Error("Invalid artifact metadata");
    return m;
  }
  async list(name, currentSha) {
    const dir = this.directory(name);
    if (currentSha === undefined) currentSha = (await this.library.read(name)).sha;
    await checkedPath(this.root, dir);
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (e) { if (e.code === "ENOENT") return []; throw e; }
    const artifacts = [];
    for (const entry of entries) {
      const id = entry.name.slice(0, -5);
      if (!entry.isFile() || !entry.name.endsWith(".json") || !ID.test(id)) continue;
      try {
        const metadata = await this.metadata(name, id);
        const script = await boundedRead(this.root, path.join(dir, metadata.fileName), MAX_SCRIPT);
        if (script.length !== metadata.size) continue;
        artifacts.push({ ...metadata, stale: metadata.sourceSha !== currentSha });
      } catch { /* Incomplete or damaged pairs are not library variants. */ }
    }
    return artifacts.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }
  async read(name, id) {
    const saved = await this.library.read(name), metadata = await this.metadata(name, id);
    const data = await boundedRead(this.root, path.join(this.directory(name), metadata.fileName), MAX_SCRIPT);
    if (data.length !== metadata.size) throw new Error("Artifact size mismatch");
    return { script: data.toString("utf8"), metadata: { ...metadata, stale: metadata.sourceSha !== saved.sha } };
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
      const script = C.ahk(saved.project, plan, { schedule: options.schedule, startDelay: options.startDelay });
      const size = Buffer.byteLength(script), id = crypto.randomUUID();
      if (size > MAX_SCRIPT) throw new Error("Exported script is too large");
      const metadata = { id, title: saved.project.title, scoreName: name, sourceSha: saved.sha,
        voiceNames: saved.project.voices.filter(v => selected.includes(v.id)).map(v => v.name),
        mode, modeRuleCount: (saved.project.modes || []).length,
        createdAt: new Date().toISOString(), fileName: `${id}.ahk`, size };
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
      return { script, metadata: { ...metadata, stale: false } };
    });
  }
}
module.exports = { Artifacts, checkedPath, boundedRead };
