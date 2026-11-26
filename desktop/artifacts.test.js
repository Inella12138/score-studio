"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const crypto = require("node:crypto"), childProcess = require("node:child_process");
const C = require("../core"), { Library } = require("./library"), { createServer } = require("./server");
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "score-artifacts-"));
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith("score-artifacts-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const library = new Library(root, { snapshot() { throw new Error("Remote access forbidden"); } });
  const project = { version: 1, title: "本地曲目", bpm: 120, meter: "4/4", gap: 40, keys: C.DEFAULT_KEYS.slice(),
    tempos: [], lengths: [], voices: [{ id: "lead", name: "旋律", source: "1 2 3 4" }, { id: "bass", name: "低音", source: "19===" }] };
  const saved = await library.save("song.score.json", project);
  return { root, library, project, request: { name: saved.name, expectedSha: saved.sha, project, selected: ["bass", "lead"], mode: "tap", options: { schedule: "", startDelay: 2 } } };
}
async function legacyPair(library, request, overrides = {}) {
  const id = overrides.id || crypto.randomUUID();
  const script = C.ahk(request.project, C.makeEvents(request.project, C.compile(request.project), request.selected, request.mode), request.options);
  const metadata = { id, title: request.project.title, scoreName: request.name, sourceSha: request.expectedSha,
    voiceNames: request.project.voices.filter(v => request.selected.includes(v.id)).map(v => v.name),
    mode: request.mode, createdAt: new Date().toISOString(), fileName: `${id}.ahk`, size: Buffer.byteLength(script), ...overrides };
  const dir = library.artifacts.legacyDirectory(request.name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, metadata.fileName), script);
  await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(metadata));
  return { script, metadata, dir };
}
test("exports immutable local script pairs using core ordering and score voice order", async t => {
  const { root, library, project, request } = await fixture(t);
  for (const mode of ["tap", "hold"]) {
    const result = await library.artifacts.export({ ...request, mode, script: "malicious raw script" });
    const expected = "\uFEFF" + C.ahk(project, C.makeEvents(project, C.compile(project), request.selected, mode), request.options);
    assert.equal(result.script, expected);
    assert.deepEqual(result.metadata.voiceNames, ["旋律", "低音"]);
    assert.equal(result.metadata.size, Buffer.byteLength(expected));
    assert.equal(result.metadata.stale, false);
    const dir = path.join(root, "scores", "song.exports");
    assert.match(result.metadata.fileName, new RegExp(`^本地曲目-旋律\\+低音-${mode}-${result.metadata.id.slice(0, 8)}\\.ahk$`));
    assert.equal(result.metadata.location, "scores");
    assert.equal(result.metadata.relativePath, `scores/song.exports/${result.metadata.fileName}`);
    assert.deepEqual((await fs.readFile(path.join(dir, result.metadata.fileName))).subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
    assert.equal(await fs.readFile(path.join(dir, result.metadata.fileName), "utf8"), expected);
    const stored = JSON.parse(await fs.readFile(path.join(dir, `${result.metadata.id}.json`), "utf8"));
    assert.equal(stored.sourceSha, request.expectedSha);
    const read = await library.artifacts.read(request.name, result.metadata.id);
    assert.equal(read.script, expected);
  }
  const duplicate = await library.artifacts.export(request);
  const artifacts = await library.artifacts.list(request.name);
  assert.equal(artifacts.length, 3);
  assert.equal(new Set(artifacts.map(a => a.id)).size, 3);
  assert.ok(artifacts.some(a => a.id === duplicate.metadata.id));
});
test("library enriches songs and computes stale status without changing stored metadata", async t => {
  const { root, library, request, project } = await fixture(t);
  const { metadata } = await library.artifacts.export(request);
  let row = (await library.list())[0];
  assert.deepEqual([row.bpm, row.meter, row.bars, row.artifactCount, row.valid], [120, "4/4", 1, 1, true]);
  assert.deepEqual(row.voiceNames, ["旋律", "低音"]);
  assert.ok(Number.isFinite(Date.parse(row.updatedAt)));
  await library.save(request.name, { ...project, bpm: 90 }, request.expectedSha);
  row = (await library.list())[0];
  assert.equal(row.artifacts[0].stale, true);
  const read = await library.artifacts.read(request.name, metadata.id);
  assert.equal(read.metadata.stale, true);
  const stored = JSON.parse(await fs.readFile(path.join(root, "scores", "song.exports", `${metadata.id}.json`), "utf8"));
  assert.equal(stored.stale, undefined);
});
test("long score names and oversized files cannot break other library entries", async t => {
  const { root, library, project } = await fixture(t);
  const name = "曲".repeat(81) + ".score.json";
  const saved = await library.save(name, project);
  assert.ok(Buffer.byteLength(path.basename(library.artifacts.directory(name))) < 240);
  await library.artifacts.export({ name, expectedSha: saved.sha, project, selected: ["lead"], mode: "tap" });
  await fs.writeFile(path.join(root, "scores", "too-big.score.json"), Buffer.alloc(4 * 1024 * 1024 + 1, 32));
  const rows = await library.list();
  assert.equal(rows.length, 3);
  assert.equal(rows.find(r => r.name === name).artifactCount, 1);
  assert.equal(rows.find(r => r.name === "song.score.json").valid, true);
  assert.equal(rows.find(r => r.name === "too-big.score.json").valid, false);
});
test("requires saved hash and semantically identical project; rejects malformed export arguments", async t => {
  const { root, library, request, project } = await fixture(t);
  const reordered = Object.fromEntries(Object.entries(project).reverse());
  await library.artifacts.export({ ...request, project: reordered });
  for (const override of [
    { name: "missing.score.json" }, { expectedSha: "0".repeat(40) },
    { expectedSha: undefined }, { project: { ...project, title: "unsaved edit" } },
    { selected: [] }, { selected: ["missing"] }, { selected: ["lead", "lead"] },
    { selected: "lead" }, { mode: "execute" }, { options: { schedule: '"; Run "bad"' } },
    { options: { startDelay: 61 } }, { options: null }, { name: "../song.score.json" }
  ]) await assert.rejects(() => library.artifacts.export({ ...request, ...override }));
  assert.equal((await fs.readdir(path.join(root, "scores", "song.exports"))).length, 2);
  for (const id of ["../secret", "abc", "", null, "0".repeat(36), "00000000-0000-0000-0000-000000000000"])
    await assert.rejects(() => library.artifacts.read(request.name, id));
  const invalid = { ...project, voices: [{ id: "bad", name: "bad", source: "1" }] };
  const saved = await library.save("invalid.score.json", invalid);
  await assert.rejects(() => library.artifacts.export({ ...request, ...saved, expectedSha: saved.sha, project: invalid, selected: ["bad"] }));
});
test("exports recheck the saved source before committing a pair", async t => {
  const { root, library, request, project } = await fixture(t), read = library.read.bind(library);
  let reads = 0;
  t.mock.method(library, "read", async name => {
    if (++reads === 2) await fs.writeFile(path.join(root, "scores", name), JSON.stringify({ ...project, bpm: 90 }));
    return read(name);
  });
  await assert.rejects(() => library.artifacts.export(request), /changed during export/);
  assert.deepEqual(await fs.readdir(library.artifacts.directory(request.name)), []);
  assert.equal(library.busy, false);
});
test("exports only selected voices with scheduling options and avoids Windows stem aliases", async t => {
  const { library, project, request } = await fixture(t);
  const options = { schedule: "20261201083000", startDelay: 0 };
  const result = await library.artifacts.export({ ...request, selected: ["bass"], options });
  assert.deepEqual(result.metadata.voiceNames, ["低音"]);
  assert.equal(result.script, "\uFEFF" + C.ahk(project, C.makeEvents(project, C.compile(project), ["bass"], "tap"), options));
  assert.notEqual(library.artifacts.directory("song..score.json"), library.artifacts.directory("song%2E.score.json"));
  assert.notEqual(library.artifacts.directory("song .score.json"), library.artifacts.directory("song%20.score.json"));
  assert.ok(Buffer.byteLength(path.basename(library.artifacts.directory("%".repeat(160) + ".score.json"))) <= 240);
  await assert.rejects(() => library.artifacts.export(null), /Invalid export request/);
});
test("symlink storage and score reads are rejected; damaged pairs are excluded", async t => {
  const { root, library, request } = await fixture(t);
  const { metadata } = await library.artifacts.export(request);
  const dir = path.join(root, "scores", "song.exports");
  await fs.writeFile(path.join(dir, metadata.fileName), "damaged");
  assert.deepEqual(await library.artifacts.list(request.name), []);
  await assert.rejects(() => library.artifacts.read(request.name, metadata.id), /size/i);
  const external = path.join(root, "other");
  await fs.mkdir(external);
  await fs.mkdir(path.join(root, "artifacts"));
  try { await fs.symlink(external, path.join(root, "artifacts", "linked"), "junction"); }
  catch (e) { if (e.code === "EPERM") { t.diagnostic("Symlink creation unavailable"); return; } throw e; }
  await assert.rejects(() => library.artifacts.list("linked.score.json", request.expectedSha), /Symlink/);
  try { await fs.symlink(path.join(root, "scores", request.name), path.join(root, "scores", "linked.score.json"), "file"); }
  catch (e) { if (e.code === "EPERM") { t.diagnostic("File symlink creation unavailable"); return; } throw e; }
  await assert.rejects(() => library.read("linked.score.json"), /Symlink/);
});
test("readable names sanitize Windows characters and bound Unicode titles and score stems", async t => {
  const { library, request, project } = await fixture(t);
  const named = { ...project, title: "CON.<曲目>:\"/\\|?*" + "曲".repeat(100),
    voices: project.voices.map(v => ({ ...v, name: '声部:<>"|?*' + "声".repeat(100) })) };
  const saved = await library.save("names.score.json", named);
  const { metadata } = await library.artifacts.export({ ...request, name: saved.name, expectedSha: saved.sha, project: named });
  assert.ok(Buffer.byteLength(metadata.fileName) <= 240);
  assert.doesNotMatch(metadata.fileName, /[<>:"/\\|?*\x00-\x1f]/);
  assert.match(metadata.fileName, /^score-CON\./);
  assert.equal((await library.artifacts.read(saved.name, metadata.id)).metadata.title, named.title);
  const long = "曲".repeat(80) + ".score.json", folder = path.basename(library.artifacts.directory(long));
  assert.ok(Buffer.byteLength(folder) <= 240);
  assert.match(folder, /\.exports$/);
  assert.notEqual(library.artifacts.directory(long), library.artifacts.directory(folder.slice(0, -8) + ".score.json"));
  assert.notEqual(library.artifacts.directory(long), library.artifacts.directory("曲".repeat(79) + "歌.score.json"));
});
test("legacy and named variants coexist without duplicate IDs and are both recoverably removable", async t => {
  const { root, library, request } = await fixture(t);
  const named = await library.artifacts.export(request), legacy = await legacyPair(library, request);
  const copy = await legacyPair(library, request, { id: named.metadata.id });
  const items = await library.artifacts.list(request.name);
  assert.equal(items.length, 2);
  assert.equal(items.find(a => a.id === named.metadata.id).location, "scores");
  assert.equal(items.find(a => a.id === legacy.metadata.id).location, "artifacts");
  assert.equal((await library.artifacts.read(request.name, legacy.metadata.id)).script, legacy.script);
  const result = await library.artifacts.remove(request.name, named.metadata.id);
  const manifest = JSON.parse(await fs.readFile(path.join(root, result.manifestPath), "utf8"));
  assert.equal(manifest.status, "complete");
  assert.equal(manifest.id, named.metadata.id);
  assert.equal(manifest.scoreName, request.name);
  assert.equal(manifest.files.length, 4);
  for (const file of manifest.files) {
    await assert.rejects(fs.access(path.join(root, file.originalPath)), { code: "ENOENT" });
    const backup = await fs.readFile(path.join(root, result.trashPath, file.backupPath));
    if (file.originalPath === named.metadata.relativePath) assert.equal(backup.toString("utf8"), named.script);
    if (file.originalPath.endsWith(copy.metadata.fileName)) assert.equal(backup.toString("utf8"), copy.script);
  }
  const removedLegacy = await library.artifacts.remove(request.name, legacy.metadata.id);
  assert.equal(await fs.readFile(path.join(root, removedLegacy.trashPath, "artifacts", legacy.metadata.fileName), "utf8"), legacy.script);
  assert.deepEqual(await library.artifacts.list(request.name), []);
  await assert.rejects(() => library.artifacts.read(request.name, named.metadata.id), /not found/);
  await assert.rejects(() => library.artifacts.remove(request.name, legacy.metadata.id), /not found/);
  assert.equal((await library.read(request.name)).sha, request.expectedSha);
});
test("stale cleanup backs up old named and legacy pairs, preserves current variants and unrelated files", async t => {
  const { root, library, request, project } = await fixture(t);
  const old = await library.artifacts.export(request), legacy = await legacyPair(library, request);
  const updated = { ...project, bpm: 90 }, saved = await library.save(request.name, updated, request.expectedSha);
  const current = await library.artifacts.export({ ...request, project: updated, expectedSha: saved.sha });
  const dir = library.artifacts.directory(request.name);
  await fs.writeFile(path.join(dir, "notes.txt"), "keep me");
  await fs.writeFile(path.join(dir, `${crypto.randomUUID()}.json`), "{broken");
  // The stale flag stored on disk is not authoritative.
  for (const metadata of [old.metadata, current.metadata]) {
    const file = path.join(dir, `${metadata.id}.json`);
    const stored = JSON.parse(await fs.readFile(file, "utf8"));
    await fs.writeFile(file, JSON.stringify({ ...stored, stale: metadata.id === current.metadata.id }));
  }
  const result = await library.artifacts.cleanStale(request.name);
  assert.equal(result.count, 2);
  assert.deepEqual(new Set(result.removed.map(a => a.id)), new Set([old.metadata.id, legacy.metadata.id]));
  const remaining = await library.artifacts.list(request.name);
  assert.deepEqual(remaining.map(a => [a.id, a.stale]), [[current.metadata.id, false]]);
  assert.equal((await library.artifacts.read(request.name, current.metadata.id)).script, current.script);
  assert.equal(await fs.readFile(path.join(dir, "notes.txt"), "utf8"), "keep me");
  assert.equal((await library.read(request.name)).sha, saved.sha);
  assert.deepEqual(await library.artifacts.cleanStale(request.name), { count: 0, removed: [] });
  assert.equal((await fs.readdir(path.join(root, ".local", "artifact-trash"))).length, 2);
});
test("cleanup removes a stale duplicate while retaining the current copy of the same ID", async t => {
  const { root, library, request, project } = await fixture(t);
  const artifact = await library.artifacts.export(request), updated = { ...project, bpm: 90 };
  const saved = await library.save(request.name, updated, request.expectedSha);
  const legacy = await legacyPair(library, { ...request, project: updated, expectedSha: saved.sha }, { id: artifact.metadata.id });
  assert.equal((await library.artifacts.list(request.name))[0].stale, true);
  const result = await library.artifacts.cleanStale(request.name);
  assert.equal(result.count, 1);
  assert.deepEqual((await library.artifacts.list(request.name)).map(a => [a.id, a.location, a.stale]), [[artifact.metadata.id, "artifacts", false]]);
  assert.equal((await library.artifacts.read(request.name, artifact.metadata.id)).script, legacy.script);
  await assert.rejects(fs.access(path.join(root, artifact.metadata.relativePath)), { code: "ENOENT" });
  const manifest = JSON.parse(await fs.readFile(path.join(root, result.removed[0].manifestPath), "utf8"));
  assert.equal(manifest.files.length, 2);
});
test("cleanup rechecks the real score at mutation and rolls back if a moved script becomes current", async t => {
  const { root, library, request, project } = await fixture(t);
  const original = await fs.readFile(path.join(root, "scores", request.name));
  const artifact = await library.artifacts.export(request);
  await library.save(request.name, { ...project, bpm: 90 }, request.expectedSha);
  const read = library.read.bind(library);
  let reads = 0;
  t.mock.method(library, "read", async name => {
    assert.equal(library.busy, true);
    if (++reads === 4) await fs.writeFile(path.join(root, "scores", name), original);
    return read(name);
  });
  assert.deepEqual(await library.artifacts.cleanStale(request.name), { count: 0, removed: [] });
  assert.equal(library.busy, false);
  library.read.mock.restore();
  assert.equal((await library.artifacts.read(request.name, artifact.metadata.id)).script, artifact.script);
  assert.equal((await library.artifacts.list(request.name))[0].stale, false);
  const trash = await fs.readdir(path.join(root, ".local", "artifact-trash"));
  const manifest = JSON.parse(await fs.readFile(path.join(root, ".local", "artifact-trash", trash[0], "manifest.json"), "utf8"));
  assert.equal(manifest.status, "rolled-back");
});
test("cleanup considers variants that become stale after listing and respects the library lock", async t => {
  const { root, library, request, project } = await fixture(t);
  const artifact = await library.artifacts.export(request), read = library.read.bind(library);
  await library.exclusive(async () => {
    await assert.rejects(() => library.artifacts.remove(request.name, artifact.metadata.id), /曲库正在/);
    await assert.rejects(() => library.artifacts.cleanStale(request.name), /曲库正在/);
  });
  let reads = 0;
  t.mock.method(library, "read", async name => {
    if (++reads === 2) await fs.writeFile(path.join(root, "scores", name), JSON.stringify({ ...project, bpm: 90 }));
    return read(name);
  });
  assert.equal((await library.artifacts.cleanStale(request.name)).count, 1);
  assert.equal(library.busy, false);
  library.read.mock.restore();
  assert.deepEqual(await library.artifacts.list(request.name), []);
});
test("a failed metadata move rolls the script back and leaves a recovery manifest", async t => {
  const { root, library, request } = await fixture(t);
  const artifact = await library.artifacts.export(request);
  const metadataPath = path.join(library.artifacts.directory(request.name), `${artifact.metadata.id}.json`);
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, "rename", async (from, to) => {
    if (from === metadataPath) throw Object.assign(new Error("Paired move denied"), { code: "EACCES" });
    return rename(from, to);
  });
  await assert.rejects(() => library.artifacts.remove(request.name, artifact.metadata.id), /Paired move denied/);
  assert.equal(library.busy, false);
  assert.equal((await library.artifacts.read(request.name, artifact.metadata.id)).script, artifact.script);
  const [trash] = await fs.readdir(path.join(root, ".local", "artifact-trash"));
  const manifest = JSON.parse(await fs.readFile(path.join(root, ".local", "artifact-trash", trash, "manifest.json"), "utf8"));
  assert.equal(manifest.status, "rolled-back");
  assert.equal(manifest.files.length, 2);
});
test("failed rollback reports recovery paths and preserves the recoverable files", async t => {
  const { root, library, request } = await fixture(t);
  const artifact = await library.artifacts.export(request), rename = fs.rename.bind(fs);
  const dir = library.artifacts.directory(request.name), metadataPath = path.join(dir, `${artifact.metadata.id}.json`);
  t.mock.method(fs, "rename", async (from, to) => {
    if (from === metadataPath || to === path.join(dir, artifact.metadata.fileName)) throw new Error("Move denied");
    return rename(from, to);
  });
  await assert.rejects(() => library.artifacts.remove(request.name, artifact.metadata.id), /recovery required at \.local\/artifact-trash\//);
  assert.equal(library.busy, false);
  const [trash] = await fs.readdir(path.join(root, ".local", "artifact-trash"));
  const trashPath = path.join(root, ".local", "artifact-trash", trash);
  const manifest = JSON.parse(await fs.readFile(path.join(trashPath, "manifest.json"), "utf8"));
  assert.equal(manifest.status, "rollback-incomplete");
  assert.equal(await fs.readFile(path.join(trashPath, "scores", artifact.metadata.fileName), "utf8"), artifact.script);
  await fs.access(metadataPath);
});
test("failed manifest updates preserve the original recovery map even if rollback fails", async t => {
  const { root, library, request } = await fixture(t);
  const artifact = await library.artifacts.export(request), rename = fs.rename.bind(fs), writeFile = fs.writeFile.bind(fs);
  t.mock.method(fs, "writeFile", async (file, ...args) => {
    if (String(file).endsWith(".tmp")) throw new Error("Manifest update denied");
    return writeFile(file, ...args);
  });
  t.mock.method(fs, "rename", async (from, to) => {
    if (String(from).includes("artifact-trash")) throw new Error("Rollback denied");
    return rename(from, to);
  });
  await assert.rejects(() => library.artifacts.remove(request.name, artifact.metadata.id), /recovery required/);
  const [trash] = await fs.readdir(path.join(root, ".local", "artifact-trash"));
  const dir = path.join(root, ".local", "artifact-trash", trash);
  const manifest = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8"));
  assert.equal(manifest.status, "pending");
  assert.equal(manifest.files.length, 2);
  for (const file of manifest.files) await fs.access(path.join(dir, file.backupPath));
  assert.equal(library.busy, false);
});
test("malformed metadata, unsafe filenames, invalid IDs and names cannot read or move files", async t => {
  const { root, library, request } = await fixture(t);
  const { metadata } = await library.artifacts.export(request);
  const dir = library.artifacts.directory(request.name), file = path.join(dir, `${metadata.id}.json`);
  const original = JSON.parse(await fs.readFile(file, "utf8"));
  for (const override of [
    { fileName: "../outside.ahk" }, { fileName: "..\\outside.ahk" }, { fileName: "C:\\outside.ahk" },
    { fileName: "/outside.ahk" }, { fileName: `foo:bar-${metadata.id.slice(0, 8)}.ahk` },
    { fileName: `${metadata.id}.ahk` }, { fileName: "wrong-00000000.ahk" },
    { fileName: `NUL.test-${metadata.id.slice(0, 8)}.ahk` }, { fileName: `COM¹.test-${metadata.id.slice(0, 8)}.ahk` },
    { fileName: metadata.fileName + " " },
    { fileName: metadata.fileName + "." }, { fileName: metadata.fileName + "\0" }, { fileName: 2 },
    { fileName: "曲".repeat(100) + `-${metadata.id.slice(0, 8)}.ahk` },
    { id: crypto.randomUUID() }, { scoreName: "other.score.json" }, { sourceSha: "stale" },
    { size: original.size + 1 }, { size: -1 }, { createdAt: null }, { voiceNames: [null] }
  ]) {
    await fs.writeFile(file, JSON.stringify({ ...original, ...override }));
    assert.deepEqual(await library.artifacts.list(request.name), []);
    await assert.rejects(() => library.artifacts.read(request.name, metadata.id));
    await assert.rejects(() => library.artifacts.remove(request.name, metadata.id));
    await fs.access(path.join(dir, metadata.fileName));
  }
  for (const value of [null, [], "bad"]) {
    await fs.writeFile(file, JSON.stringify(value));
    await assert.rejects(() => library.artifacts.read(request.name, metadata.id));
  }
  await fs.writeFile(file, JSON.stringify(original));
  for (const id of ["../secret", "..\\secret", metadata.id + "/x", "", null, {}, "a".repeat(36)]) {
    await assert.rejects(() => library.artifacts.remove(request.name, id));
    await assert.rejects(() => library.artifacts.read(request.name, id));
  }
  for (const name of ["../song.score.json", "song.score.json/..", null, "C:song.score.json"]) {
    await assert.rejects(() => library.artifacts.remove(name, metadata.id));
    await assert.rejects(() => library.artifacts.cleanStale(name));
  }
  await assert.rejects(fs.access(path.join(root, ".local", "artifact-trash")), { code: "ENOENT" });
  assert.equal(library.busy, false);
});
test("legacy filenames must remain UUIDs and oversized metadata and scripts are bounded", async t => {
  const { library, request } = await fixture(t);
  const legacy = await legacyPair(library, request), file = path.join(legacy.dir, `${legacy.metadata.id}.json`);
  await fs.writeFile(file, JSON.stringify({ ...legacy.metadata, fileName: `named-${legacy.metadata.id.slice(0, 8)}.ahk` }));
  await assert.rejects(() => library.artifacts.read(request.name, legacy.metadata.id), /metadata/);
  await fs.writeFile(file, " ".repeat(64 * 1024 + 1));
  await assert.rejects(() => library.artifacts.read(request.name, legacy.metadata.id), /too large/);
  await fs.writeFile(file, JSON.stringify(legacy.metadata));
  await fs.writeFile(path.join(legacy.dir, legacy.metadata.fileName), Buffer.alloc(16 * 1024 * 1024 + 1));
  assert.deepEqual(await library.artifacts.list(request.name), []);
  await assert.rejects(() => library.artifacts.remove(request.name, legacy.metadata.id), /too large/);
});
test("linked export and trash directories cannot redirect reads or removal", async t => {
  const { root, library, request } = await fixture(t);
  const { metadata } = await library.artifacts.export(request);
  const external = path.join(root, "external");
  await fs.mkdir(external);
  await fs.mkdir(path.join(root, ".local"));
  try { await fs.symlink(external, path.join(root, ".local", "artifact-trash"), "junction"); }
  catch (e) { if (e.code === "EPERM") { t.diagnostic("Junction creation unavailable"); return; } throw e; }
  await assert.rejects(() => library.artifacts.remove(request.name, metadata.id), /Symlink/);
  assert.equal((await library.artifacts.read(request.name, metadata.id)).metadata.id, metadata.id);
  assert.deepEqual(await fs.readdir(external), []);
  const linkedName = "linked.score.json";
  await fs.symlink(external, library.artifacts.directory(linkedName), "junction");
  await assert.rejects(() => library.artifacts.list(linkedName, request.expectedSha), /Symlink/);
  await assert.rejects(() => library.artifacts.read(linkedName, metadata.id));
});
test("linked metadata and script paths are excluded and cannot be read or deleted", async t => {
  const { root, library, request } = await fixture(t);
  const artifact = await library.artifacts.export(request), legacy = await legacyPair(library, request);
  const external = path.join(root, "external");
  await fs.mkdir(external);
  await fs.writeFile(path.join(external, "keep.txt"), "untouched");
  // Junctions also exercise the symlink check on Windows without file-link privileges.
  for (const [dir, metadata] of [[library.artifacts.directory(request.name), artifact.metadata], [legacy.dir, legacy.metadata]]) {
    const scriptPath = path.join(dir, metadata.fileName), metadataPath = path.join(dir, `${metadata.id}.json`);
    const script = await fs.readFile(scriptPath);
    await fs.unlink(scriptPath);
    try { await fs.symlink(external, scriptPath, "junction"); }
    catch (e) { if (e.code === "EPERM") { t.diagnostic("Junction creation unavailable"); return; } throw e; }
    assert.ok(!(await library.artifacts.list(request.name)).some(a => a.id === metadata.id));
    await assert.rejects(() => library.artifacts.read(request.name, metadata.id), /Symlink/);
    await assert.rejects(() => library.artifacts.remove(request.name, metadata.id), /Symlink/);
    if (process.platform === "win32") await fs.rmdir(scriptPath);
    else await fs.unlink(scriptPath);
    await fs.writeFile(scriptPath, script);
    await fs.unlink(metadataPath);
    await fs.symlink(external, metadataPath, "junction");
    assert.ok(!(await library.artifacts.list(request.name)).some(a => a.id === metadata.id));
    await assert.rejects(() => library.artifacts.read(request.name, metadata.id), /Symlink/);
    await assert.rejects(() => library.artifacts.remove(request.name, metadata.id), /Symlink/);
  }
  assert.equal(await fs.readFile(path.join(external, "keep.txt"), "utf8"), "untouched");
  await assert.rejects(fs.access(path.join(root, ".local", "artifact-trash")), { code: "ENOENT" });
});
test("artifact HTTP routes preserve existing local authorization and expose no execution route", async t => {
  const { root, request } = await fixture(t);
  const { server, token, library } = createServer(root);
  const launches = [];
  let launchError = null;
  t.mock.method(childProcess, "execFile", (executable, args, options, callback) => {
    launches.push({ executable, args, options });
    callback(launchError);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { "X-Score-Token": token, "Content-Type": "application/json" };
  const postTo = (route, body, requestHeaders = headers) => fetch(base + route, { method: "POST", headers: requestHeaders, body: JSON.stringify(body) });
  const post = body => postTo("/api/artifacts/export", body);
  assert.equal((await fetch(base + "/api/artifacts?name=song.score.json")).status, 403);
  const exported = await post(request);
  assert.equal(exported.status, 200);
  const { metadata, script } = await exported.json();
  const list = await (await fetch(base + "/api/artifacts?name=song.score.json", { headers })).json();
  assert.equal(list.artifacts[0].id, metadata.id);
  const read = await (await fetch(base + `/api/artifact?name=song.score.json&id=${metadata.id}`, { headers })).json();
  assert.equal(read.script, script);
  assert.equal(list.artifacts[0].relativePath, metadata.relativePath);
  const body = { name: request.name, id: metadata.id };
  for (const route of ["/api/artifacts/reveal", "/api/artifacts/delete", "/api/artifacts/clean-stale"]) {
    assert.equal((await postTo(route, body, { "Content-Type": "application/json" })).status, 403);
    assert.equal((await postTo(route, body, { ...headers, "X-Score-Token": "wrong" })).status, 403);
    assert.equal((await postTo(route, body, { ...headers, Origin: "https://evil.test" })).status, 403);
    const invalidHost = await new Promise((resolve, reject) => {
      const req = require("node:http").request(base + route, { method: "POST", headers: { ...headers, Host: "evil.test" } }, res => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });
    assert.equal(invalidHost, 403);
    assert.equal((await fetch(base + route, { headers })).status, 404);
    for (const invalid of [{ name: "../song.score.json", id: metadata.id }, null, [], {}])
      assert.equal((await postTo(route, invalid)).status, 400);
  }
  assert.equal(launches.length, 0);
  const metadataPath = path.join(library.artifacts.directory(request.name), `${metadata.id}.json`);
  const stored = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  await fs.writeFile(metadataPath, JSON.stringify({ ...stored, location: "../other", relativePath: "../outside.ahk" }));
  const reveal = await postTo("/api/artifacts/reveal", body);
  assert.equal(reveal.status, 200);
  assert.equal((await reveal.json()).relativePath, metadata.relativePath);
  assert.deepEqual(launches, [{ executable: "explorer.exe", args: [`/select,${path.join(root, metadata.relativePath)}`], options: { windowsHide: true } }]);
  for (const route of ["/api/artifacts/reveal", "/api/artifacts/delete"])
    for (const id of ["../bad", "..\\bad", null, crypto.randomUUID()])
      assert.equal((await postTo(route, { ...body, id })).status, 400);
  assert.equal(launches.length, 1);
  assert.deepEqual(await (await postTo("/api/artifacts/clean-stale", { name: request.name })).json(), { count: 0, removed: [] });
  const updated = { ...request.project, bpm: 90 }, saved = await library.save(request.name, updated, request.expectedSha);
  const current = await (await post({ ...request, project: updated, expectedSha: saved.sha })).json();
  const cleaned = await postTo("/api/artifacts/clean-stale", { name: request.name });
  assert.equal(cleaned.status, 200);
  const cleanup = await cleaned.json();
  assert.equal(cleanup.count, 1);
  assert.equal(cleanup.removed[0].id, metadata.id);
  await fs.access(path.join(root, cleanup.removed[0].manifestPath));
  assert.equal((await postTo("/api/artifacts/reveal", body)).status, 400);
  const currentBody = { name: request.name, id: current.metadata.id };
  launchError = new Error("Explorer unavailable");
  const failedReveal = await postTo("/api/artifacts/reveal", currentBody);
  assert.equal(failedReveal.status, 400);
  assert.equal((await failedReveal.json()).error, launchError.message);
  assert.equal((await library.artifacts.list(request.name)).length, 1);
  launchError = null;
  const deleted = await postTo("/api/artifacts/delete", currentBody);
  assert.equal(deleted.status, 200);
  const removal = await deleted.json();
  assert.equal(removal.removed, true);
  assert.equal(removal.id, current.metadata.id);
  await fs.access(path.join(root, removal.manifestPath));
  assert.equal((await postTo("/api/artifacts/delete", currentBody)).status, 400);
  assert.deepEqual(await library.artifacts.list(request.name), []);
  const legacy = await legacyPair(library, request);
  assert.equal((await postTo("/api/artifacts/reveal", { name: request.name, id: legacy.metadata.id })).status, 200);
  assert.deepEqual(launches.at(-1).args, [`/select,${path.join(legacy.dir, legacy.metadata.fileName)}`]);
  assert.equal((await postTo("/api/artifacts/delete", { name: request.name, id: legacy.metadata.id })).status, 200);
  assert.equal((await post({ ...request, project: { ...request.project, bpm: 100 } })).status, 400);
  assert.equal((await fetch(base + "/api/artifact?name=song.score.json&id=../bad", { headers })).status, 400);
  for (const action of ["execute", "run", "launch"])
    assert.equal((await postTo(`/api/artifacts/${action}`, currentBody)).status, 404);
});
