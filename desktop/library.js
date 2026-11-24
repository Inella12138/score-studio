"use strict";
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const C = require("../core"), github = require("./github");
const gitSha = data => crypto.createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
function safeName(name) {
  if (typeof name !== "string" || !name.endsWith(".score.json") || name.length > 180 ||
      /[<>:"/\\|?*\x00-\x1f]/.test(name) || name.startsWith(".") ||
      /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) throw new Error("曲谱文件名无效");
  return name;
}
function validate(data) {
  if (data.length > 4 * 1024 * 1024) throw new Error("曲谱不能超过 4MB");
  return C.validateProject(JSON.parse(data.toString("utf8").replace(/^\uFEFF/, "")));
}
async function atomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(temp, data, { flag: "wx" }); await fs.rename(temp, file); }
  finally { await fs.unlink(temp).catch(() => {}); }
}
class Library {
  constructor(root, remote = github) { this.root = root; this.dir = path.join(root, "scores"); this.stateFile = path.join(root, ".local", "sync.json"); this.remote = remote; this.previews = new Map(); this.busy = false; this.artifacts = new (require("./artifacts").Artifacts)(this); }
  async exclusive(fn) {
    if (this.busy) throw new Error("曲库正在保存或同步，请稍后重试");
    this.busy = true; try { return await fn(); } finally { this.busy = false; }
  }
  async state() { try { return JSON.parse(await fs.readFile(this.stateFile, "utf8")); } catch (e) { if (e.code === "ENOENT") return { base: {} }; throw new Error("本地同步记录损坏，请保留曲库并联系维护者"); } }
  async files({ tolerateInvalid = false } = {}) {
    await fs.mkdir(this.dir, { recursive: true });
    const entries = await fs.readdir(this.dir, { withFileTypes: true }), files = [];
    for (const e of entries) if (e.isFile() && e.name.endsWith(".score.json")) {
      try {
        safeName(e.name);
        const data = await require("./artifacts").boundedRead(this.root, path.join(this.dir, e.name), 4 * 1024 * 1024);
        files.push({ name: e.name, sha: gitSha(data), data });
      } catch (e2) {
        if (!tolerateInvalid) throw new Error(`无法读取曲谱「${e.name}」：${e2.message}`);
        files.push({ name: e.name, error: e2.message });
      }
    }
    return files;
  }
  async list() {
    const items = [];
    for (const f of await this.files({ tolerateInvalid: true })) {
      if (f.error) {
        items.push({ name: f.name, title: f.name, valid: false, error: f.error, voices: 0, voiceNames: [], artifactCount: 0, artifacts: [] }); continue;
      }
      const updatedAt = (await fs.stat(path.join(this.dir, f.name))).mtime.toISOString();
      let artifacts = [], artifactError = null;
      try { artifacts = await this.artifacts.list(f.name, f.sha); } catch (e) { artifactError = e.message; }
      const base = { name: f.name, sha: f.sha, updatedAt, artifacts, artifactCount: artifacts.length, artifactError };
      try { const p = validate(f.data), compiled = C.compile(p); items.push({ ...base, title: p.title, voices: p.voices.length,
        bpm: p.bpm, meter: p.meter, bars: compiled.bars.length, voiceNames: p.voices.map(v => v.name), valid: true }); }
      catch { items.push({ ...base, title: f.name, bpm: null, meter: null, bars: 0, voiceNames: [], valid: false }); }
    }
    return items.sort((a, b) => a.name.localeCompare(b.name, "zh"));
  }
  async read(name) { const data = await require("./artifacts").boundedRead(this.root, path.join(this.dir, safeName(name)), 4 * 1024 * 1024); return { project: validate(data), sha: gitSha(data), name }; }
  async save(name, project, expectedSha) {
    return this.exclusive(async () => {
      safeName(name); const data = Buffer.from(JSON.stringify(project, null, 2) + "\n"); validate(data);
      let previous = null;
      try { previous = await fs.readFile(path.join(this.dir, name)); } catch (e) { if (e.code !== "ENOENT") throw e; }
      if (previous && expectedSha !== gitSha(previous)) throw new Error("同名曲谱已存在或已更新，请重新打开或换一个曲名保存");
      await atomic(path.join(this.dir, name), data);
      return { name, sha: gitSha(data) };
    });
  }
  async update() {
    return this.exclusive(async () => {
      const snapshot = await this.remote.snapshot(), state = await this.state(), local = new Map((await this.files()).map(f => [f.name, f]));
      const downloaded = [], conflicts = [], staged = [];
      const caseNames = new Set();
      for (const entry of snapshot.files) {
        const name = safeName(entry.path.slice(7)), current = local.get(name);
        if (caseNames.has(name.toLowerCase())) throw new Error("远程有仅大小写不同的同名曲谱，请先处理命名冲突");
        caseNames.add(name.toLowerCase());
        if (!current && [...local.keys()].some(n => n.toLowerCase() === name.toLowerCase())) throw new Error("本地与远程曲谱名称仅大小写不同，请先统一名称");
        if (current?.sha === entry.sha) { state.base[name] = entry.sha; continue; }
        if (current && state.base[name] === entry.sha) continue; // Remote unchanged; keep local edits.
        const data = await this.remote.blob(entry.sha);
        if (gitSha(data) !== entry.sha) throw new Error("远程曲谱校验失败");
        validate(data);
        staged.push({ name, data, sha: entry.sha, conflict: !!current && current.sha !== state.base[name] });
      }
      for (const item of staged) {
        if (item.conflict) {
          const dest = path.join(this.root, ".local", "conflicts", `${Date.now()}-${crypto.randomUUID()}-${item.name}`);
          await atomic(dest, item.data); conflicts.push(item.name);
        } else {
          await atomic(path.join(this.dir, item.name), item.data); state.base[item.name] = item.sha; downloaded.push(item.name);
        }
      }
      state.head = snapshot.head;
      await atomic(this.stateFile, JSON.stringify(state, null, 2));
      return { downloaded, conflicts, message: conflicts.length ? "有同名曲谱双方都已修改：本地保留，远程副本放在 .local/conflicts，请比较后另存；上传已阻止冲突覆盖。" : "曲库已更新，本地未上传修改保留。远程删除不会删除本地曲谱。" };
    });
  }
  async prepare() {
    return this.exclusive(async () => {
      const token = await this.remote.credential(), snapshot = await this.remote.snapshot(token), state = await this.state();
      const remote = new Map(snapshot.files.map(e => [e.path.slice(7), e.sha])), files = await this.files(), changes = [];
      for (const f of files) {
        if (!remote.has(f.name) && [...remote.keys()].some(n => n.toLowerCase() === f.name.toLowerCase())) throw new Error(`「${f.name}」与远程文件名仅大小写不同，请统一名称后重试`);
        if (remote.get(f.name) === f.sha) continue;
        if (remote.has(f.name) && remote.get(f.name) !== state.base[f.name]) throw new Error(`远程已修改「${f.name}」，请先更新曲库并解决冲突`);
        if (!remote.has(f.name) && state.base[f.name]) throw new Error(`「${f.name}」远程已删除，请先另存新名称，避免意外恢复已删除曲谱`);
        validate(f.data); changes.push({ name: f.name, sha: f.sha, data: f.data, action: remote.has(f.name) ? "修改" : "新增" });
      }
      if (changes.length > 100) throw new Error("单次最多上传 100 首曲谱");
      const id = crypto.randomUUID(); this.previews.clear();
      this.previews.set(id, { changes, head: snapshot.head, tree: snapshot.tree, expires: Date.now() + 600000 });
      return { id, changes: changes.map(({ name, action }) => ({ name, action })), repository: `${github.OWNER}/${github.REPO}`, public: true };
    });
  }
  async upload(id) {
    return this.exclusive(async () => {
      const preview = this.previews.get(id); this.previews.delete(id);
      if (!preview || preview.expires < Date.now()) throw new Error("上传预览已过期，请重新预览");
      if (!preview.changes.length) return { message: "没有需要上传的曲谱" };
      const now = new Map((await this.files()).map(f => [f.name, f.sha]));
      if (preview.changes.some(f => now.get(f.name) !== f.sha)) throw new Error("预览后曲谱发生变化，请重新预览");
      const token = await this.remote.credential(), snapshot = await this.remote.snapshot(token);
      if (snapshot.head !== preview.head) throw new Error("远程在预览后已更新，请先更新曲库再上传");
      const { api, repoPath } = this.remote, tree = [];
      for (const f of preview.changes) {
        const blob = await api(`${repoPath}/git/blobs`, { method: "POST", token, body: { encoding: "base64", content: f.data.toString("base64") } });
        tree.push({ path: `scores/${f.name}`, mode: "100644", type: "blob", sha: blob.sha });
      }
      const newTree = await api(`${repoPath}/git/trees`, { method: "POST", token, body: { base_tree: preview.tree, tree } });
      const commit = await api(`${repoPath}/git/commits`, { method: "POST", token, body: { message: `更新曲库：${preview.changes.length} 首曲谱`, tree: newTree.sha, parents: [preview.head] } });
      await api(`${repoPath}/git/refs/heads/main`, { method: "PATCH", token, body: { sha: commit.sha, force: false } });
      const state = await this.state();
      for (const f of preview.changes) state.base[f.name] = f.sha;
      state.head = commit.sha; await atomic(this.stateFile, JSON.stringify(state, null, 2));
      return { message: `已上传 ${preview.changes.length} 首曲谱`, commit: commit.sha };
    });
  }
}
module.exports = { Library, gitSha, validate, safeName, atomic };
