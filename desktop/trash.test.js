"use strict";
const { test, before, after } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const childProcess = require("node:child_process"), { promisify } = require("node:util");
const { ArtifactTrash } = require("./trash"), { Library } = require("./library"), C = require("../core");
const execFile = childProcess.execFile, exec = promisify(execFile);
let helperDirectory, helper, gatedHelper;
before(async () => {
  if (process.platform !== "win32") return;
  const temp = path.resolve(await fs.realpath(os.tmpdir()));
  helperDirectory = await fs.mkdtemp(path.join(temp, "score-trash-helper-test-"));
  helper = path.join(helperDirectory, "ScoreTrashDelete.exe");
  gatedHelper = path.join(helperDirectory, "ScoreTrashDelete-gated.exe");
  const compiler = path.join(process.env.WINDIR, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  const source = path.join(__dirname, "TrashDelete.cs"), gate = path.join(helperDirectory, "Gate.cs");
  await fs.writeFile(gate, `using System;
internal static partial class TrashDelete {
  static partial void BeforeDeleteForTest() {
    Console.WriteLine("guarded"); Console.Out.Flush();
    if (Console.In.ReadLine() != "continue") throw new Exception("Test gate cancelled");
  }
  static partial void BeforeManifestDeleteForTest() {
    Console.WriteLine("cleanup"); Console.Out.Flush();
    if (Console.In.ReadLine() != "continue") throw new Exception("Test gate cancelled");
  }
}`, "utf8");
  const flags = ["/nologo", "/target:exe", "/optimize+", "/reference:System.Runtime.Serialization.dll"];
  await exec(compiler, [...flags, "/out:" + helper, source], { windowsHide: true });
  await exec(compiler, [...flags, "/out:" + gatedHelper, source, gate], { windowsHide: true });
});
after(async () => {
  if (!helperDirectory) return;
  const temp = path.resolve(await fs.realpath(os.tmpdir())), target = path.resolve(helperDirectory);
  assert.equal(path.dirname(target), temp);
  assert.ok(path.basename(target).startsWith("score-trash-helper-test-"));
  assert.equal(await fs.realpath(target), target);
  assert.equal((await fs.lstat(target)).isSymbolicLink(), false);
  await fs.rm(target, { recursive: true, force: true });
});
async function gatedDelete(input, atBoundary) {
  const child = childProcess.spawn(gatedHelper, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let output = "", errors = "", boundaryError, pending = Promise.resolve();
  const timer = setTimeout(() => child.kill(), 15000);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", text => { errors += text; });
  child.stdin.on("error", () => {});
  child.stdout.on("data", text => {
    output += text;
    let newline;
    while ((newline = output.indexOf("\n")) !== -1) {
      const line = output.slice(0, newline).trim();
      output = output.slice(newline + 1);
      if (line === "guarded" || line === "cleanup") pending = pending.then(async () => {
        await atBoundary(line);
        child.stdin.write("continue\n");
      }).catch(error => { boundaryError = error; child.kill(); });
    }
  });
  child.stdin.write(input + "\n");
  try {
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    await pending;
    if (boundaryError) throw boundaryError;
    assert.equal(code, 0, errors);
  } finally { clearTimeout(timer); child.kill(); }
}
async function fixture(t) {
  const temp = path.resolve(await fs.realpath(os.tmpdir()));
  const sandbox = await fs.mkdtemp(path.join(temp, "score-trash-test-")), root = path.join(sandbox, "workspace");
  await fs.mkdir(root);
  t.after(async () => {
    const target = path.resolve(sandbox);
    assert.equal(path.dirname(target), temp);
    assert.ok(path.basename(target).startsWith("score-trash-test-"));
    assert.equal(await fs.realpath(target), target);
    assert.equal((await fs.lstat(target)).isSymbolicLink(), false);
    await fs.rm(target, { recursive: true, force: true });
  });
  const library = new Library(root, { snapshot() { throw new Error("Network forbidden"); } });
  const trash = new ArtifactTrash(library);
  if (process.platform === "win32") t.mock.method(childProcess, "execFile", (executable, args, options, callback) => {
    assert.equal(executable, path.resolve(__dirname, "..", "bin", "ScoreTrashDelete.exe"));
    assert.deepEqual(args, []);
    assert.equal(options.windowsHide, true);
    return execFile(helper, args, options, callback);
  });
  return { sandbox, root, library, trash, base: path.join(root, ".local", "artifact-trash") };
}
async function complete(f, options = {}) {
  const id = crypto.randomUUID(), name = options.name || crypto.randomUUID(), dir = path.join(f.base, name);
  const files = [
    { originalPath: `scores/song.exports/example-${id.slice(0, 8)}.ahk`, backupPath: `scores/example-${id.slice(0, 8)}.ahk` },
    { originalPath: `scores/song.exports/${id}.json`, backupPath: `scores/${id}.json` }
  ];
  const manifest = { version: 1, id, scoreName: "song.score.json", status: "complete",
    files: files.map(file => ({ ...file })), ...options.manifest };
  await fs.mkdir(path.join(dir, "scores"), { recursive: true });
  for (const file of files) await fs.writeFile(path.join(dir, file.backupPath), "backup " + file.backupPath);
  const manifestPath = path.join(dir, "manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const bytes = (await fs.stat(manifestPath)).size +
    (await Promise.all(files.map(file => fs.stat(path.join(dir, file.backupPath))))).reduce((sum, stat) => sum + stat.size, 0);
  return { dir, manifest, manifestPath, bytes, files };
}
async function writeManifest(entry) { await fs.writeFile(entry.manifestPath, JSON.stringify(entry.manifest)); }
async function link(t, target, destination, type = "junction") {
  try { await fs.symlink(target, destination, type); return true; }
  catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.skip("This host does not allow creating the link required by this test"); return false;
    }
    throw error;
  }
}
test("missing trash is empty, repeated empty is harmless and creates no directories", async t => {
  const f = await fixture(t), empty = { count: 0, bytes: 0, protectedCount: 0 };
  assert.deepEqual(await f.trash.summary(), empty);
  for (let i = 0; i < 2; i++)
    assert.deepEqual(await f.trash.empty({ confirm: true }), { ...empty, removedCount: 0, removedBytes: 0 });
  await assert.rejects(fs.access(f.base), { code: "ENOENT" });
});
test("clears complete manifests from the real remover, leaving zero entries and active scores and artifacts intact",
  { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t);
  const project = { version: 1, title: "Local", bpm: 120, meter: "4/4", gap: 40, keys: C.DEFAULT_KEYS.slice(),
    tempos: [], lengths: [], voices: [{ id: "lead", name: "Lead", source: "1 2 3 4" }] };
  const saved = await f.library.save("song.score.json", project);
  const request = { name: saved.name, expectedSha: saved.sha, project, selected: ["lead"], mode: "tap" };
  const removed = await f.library.artifacts.export(request), active = await f.library.artifacts.export(request);
  // Exercise a duplicated artifact in both supported storage layouts.
  const legacy = f.library.artifacts.legacyDirectory(saved.name);
  await fs.mkdir(legacy, { recursive: true });
  await fs.writeFile(path.join(legacy, `${removed.metadata.id}.ahk`), removed.script);
  await fs.writeFile(path.join(legacy, `${removed.metadata.id}.json`),
    JSON.stringify({ ...removed.metadata, fileName: `${removed.metadata.id}.ahk` }));
  const deletion = await f.library.artifacts.remove(saved.name, removed.metadata.id);
  const dir = path.join(f.root, deletion.trashPath);
  const manifest = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8"));
  assert.equal(manifest.files.length, 4);
  assert.notEqual(path.basename(dir), manifest.id);
  const bytes = (await fs.stat(path.join(dir, "manifest.json"))).size +
    (await Promise.all(manifest.files.map(file => fs.stat(path.join(dir, file.backupPath))))).reduce((sum, stat) => sum + stat.size, 0);
  const scorePath = path.join(f.root, "scores", saved.name), scoreBefore = await fs.readFile(scorePath);
  assert.deepEqual(await f.trash.summary(), { count: 1, bytes, protectedCount: 0 });
  assert.deepEqual(await f.trash.empty({ confirm: true }),
    { count: 0, bytes: 0, protectedCount: 0, removedCount: 1, removedBytes: bytes });
  assert.deepEqual(await fs.readdir(f.base), []);
  assert.deepEqual(await fs.readFile(scorePath), scoreBefore);
  assert.equal((await f.library.artifacts.read(saved.name, active.metadata.id)).script, active.script);
  assert.equal((await f.library.artifacts.list(saved.name)).length, 1);
  assert.deepEqual(await f.trash.empty({ confirm: true }),
    { count: 0, bytes: 0, protectedCount: 0, removedCount: 0, removedBytes: 0 });
});
test("explicit boolean confirmation is required before locking or scanning", async t => {
  const f = await fixture(t), entry = await complete(f);
  let locks = 0;
  t.mock.method(f.library, "exclusive", async callback => { locks++; return callback(); });
  for (const options of [undefined, null, {}, { confirm: false }, { confirm: 1 }, { confirm: "true" }, true, []])
    await assert.rejects(() => f.trash.empty(options), /confirm: true/);
  assert.equal(locks, 0);
  await fs.access(entry.manifestPath);
});
test("empty reenumerates under the library lock instead of trusting an earlier summary",
  { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), entry = await complete(f);
  assert.equal((await f.trash.summary()).count, 1);
  let locks = 0;
  t.mock.method(f.library, "exclusive", async callback => {
    locks++;
    entry.manifest.status = "pending";
    await writeManifest(entry);
    const second = await complete(f);
    const result = await callback();
    await assert.rejects(fs.access(second.dir), { code: "ENOENT" });
    return result;
  });
  const result = await f.trash.empty({ confirm: true });
  assert.equal(locks, 1);
  assert.equal(result.removedCount, 1);
  assert.deepEqual(await f.trash.summary(), { count: 0, bytes: 0, protectedCount: 1 });
  assert.equal(JSON.parse(await fs.readFile(entry.manifestPath, "utf8")).status, "pending");
});
test("pending, failed, rolled-back, rollback-incomplete and unrecognized entries are preserved",
  { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), entries = [];
  for (const status of ["pending", "failed", "rolled-back", "rollback-incomplete"])
    entries.push(await complete(f, { manifest: { status } }));
  const malformed = await complete(f);
  await fs.writeFile(malformed.manifestPath, "{broken");
  entries.push(malformed);
  await fs.mkdir(path.join(f.base, "unrecognized"));
  await fs.writeFile(path.join(f.base, "unrecognized", "recovery.txt"), "preserve");
  await fs.writeFile(path.join(f.base, "loose-file"), "preserve");
  const eligible = await complete(f);
  assert.deepEqual(await f.trash.summary(), { count: 1, bytes: eligible.bytes, protectedCount: 7 });
  assert.deepEqual(await f.trash.empty({ confirm: true }),
    { count: 0, bytes: 0, protectedCount: 7, removedCount: 1, removedBytes: eligible.bytes });
  for (const entry of entries) {
    await fs.access(entry.manifestPath);
    for (const file of entry.files) await fs.access(path.join(entry.dir, file.backupPath));
  }
  assert.equal(await fs.readFile(path.join(f.base, "unrecognized", "recovery.txt"), "utf8"), "preserve");
  assert.equal(await fs.readFile(path.join(f.base, "loose-file"), "utf8"), "preserve");
});
test("invalid manifests and recovery paths protect the entire directory", async t => {
  const f = await fixture(t);
  const cases = [
    entry => { entry.manifest.version = 2; },
    entry => { entry.manifest.id = "not-a-uuid"; },
    entry => { entry.manifest.id += "\n"; },
    entry => { entry.manifest.id = null; },
    entry => { entry.manifest.scoreName = "song.json"; },
    entry => { entry.manifest.scoreName = "../song.score.json"; },
    entry => { entry.manifest.files = []; },
    entry => { entry.manifest.files = {}; },
    entry => { entry.manifest.files[0] = null; },
    entry => { delete entry.manifest.files[0].originalPath; },
    entry => { entry.manifest.files[0].originalPath = "scores/song.score.json"; },
    entry => { entry.manifest.files[0].originalPath = "scores/elsewhere/file.ahk"; },
    entry => { entry.manifest.files[0].originalPath = "scores/other.exports/file.ahk"; },
    entry => { entry.manifest.files[0].originalPath = "../scores/song.exports/file.ahk"; },
    entry => { entry.manifest.files[0].originalPath = "scores/song.exports/../file.ahk"; },
    entry => { entry.manifest.files[0].originalPath = "/artifacts/song/file.ahk"; },
    entry => { entry.manifest.files[0].originalPath = "artifacts/other/file.ahk"; },
    entry => { entry.manifest.files[0].originalPath = "scores\\song.exports\\file.ahk"; },
    entry => { entry.manifest.files[0].backupPath = "../outside.txt"; },
    entry => { entry.manifest.files[0].backupPath = "scores/../../outside.txt"; },
    entry => { entry.manifest.files[0].backupPath = "scores/nested/file.ahk"; },
    entry => { entry.manifest.files[0].backupPath = "artifacts/" + path.basename(entry.files[0].backupPath); },
    entry => { entry.manifest.files[0].backupPath = "scores/other.ahk"; },
    entry => { entry.manifest.files[0].backupPath = "C:/outside.txt"; },
    entry => { entry.manifest.files[0].backupPath = "scores/file.ahk:stream"; },
    entry => { entry.manifest.files.push({ ...entry.manifest.files[0] }); },
    entry => { entry.manifest.files.push({ originalPath: "scores/song.exports/UPPER.ahk", backupPath: "scores/UPPER.ahk" },
      { originalPath: "scores/song.exports/upper.ahk", backupPath: "scores/upper.ahk" }); }
  ];
  const entries = [];
  for (const mutate of cases) {
    const entry = await complete(f);
    mutate(entry);
    await writeManifest(entry);
    entries.push(entry);
  }
  entries.push(await complete(f, { name: "invalid-directory-id" }));
  const result = await f.trash.empty({ confirm: true });
  assert.deepEqual(result, { count: 0, bytes: 0, protectedCount: entries.length, removedCount: 0, removedBytes: 0 });
  for (const entry of entries) {
    await fs.access(entry.manifestPath);
    for (const file of entry.files) await fs.access(path.join(entry.dir, file.backupPath));
  }
});
test("missing backups, oversized manifests, extra files and unexpected nested directories are preserved", async t => {
  const f = await fixture(t), entries = [];
  const missing = await complete(f);
  await fs.unlink(path.join(missing.dir, missing.files[0].backupPath)); entries.push(missing);
  const oversized = await complete(f);
  await fs.writeFile(oversized.manifestPath, " ".repeat(64 * 1024 + 1)); entries.push(oversized);
  const loose = await complete(f);
  await fs.writeFile(path.join(loose.dir, "extra.txt"), "preserve"); entries.push(loose);
  const backupExtra = await complete(f);
  await fs.writeFile(path.join(backupExtra.dir, "scores", "extra.txt"), "preserve"); entries.push(backupExtra);
  const nested = await complete(f);
  await fs.mkdir(path.join(nested.dir, "scores", "unexpected")); entries.push(nested);
  const unknown = await complete(f);
  await fs.mkdir(path.join(unknown.dir, "unknown")); entries.push(unknown);
  assert.deepEqual(await f.trash.empty({ confirm: true }),
    { count: 0, bytes: 0, protectedCount: entries.length, removedCount: 0, removedBytes: 0 });
  for (const entry of entries) await fs.access(entry.manifestPath);
});
for (const level of ["workspace", "ancestor", ".local", "artifact-trash"]) {
  test(`rejects a linked ${level} root or ancestor without touching the target`, async t => {
    const f = await fixture(t), outside = path.join(f.sandbox, "outside");
    await fs.mkdir(outside);
    const sentinel = path.join(outside, "sentinel.txt");
    await fs.writeFile(sentinel, "preserve");
    let trash = f.trash;
    if (level === "workspace") {
      const linked = path.join(f.sandbox, "linked-workspace");
      if (!await link(t, f.root, linked)) return;
      trash = new ArtifactTrash({ root: linked, exclusive: callback => callback() });
    } else if (level === "ancestor") {
      const linked = path.join(f.sandbox, "linked-ancestor");
      if (!await link(t, f.sandbox, linked)) return;
      trash = new ArtifactTrash({ root: path.join(linked, "workspace"), exclusive: callback => callback() });
    } else {
      const destination = level === ".local" ? path.join(f.root, ".local") : f.base;
      await fs.mkdir(path.dirname(destination), { recursive: true });
      if (!await link(t, outside, destination)) return;
    }
    await assert.rejects(() => trash.summary(), /unsafe/);
    await assert.rejects(() => trash.empty({ confirm: true }), /unsafe/);
    assert.equal(await fs.readFile(sentinel, "utf8"), "preserve");
  });
}
for (const level of ["entry", "storage", "backup", "manifest"]) {
  test(`protects a linked ${level}, preserving its target and recovery data`, async t => {
    const f = await fixture(t), entry = await complete(f), outside = path.join(f.sandbox, "outside");
    await fs.mkdir(outside);
    const sentinel = path.join(outside, "sentinel.txt");
    await fs.writeFile(sentinel, "preserve");
    let destination, target = outside;
    if (level === "entry") {
      target = path.join(outside, "trash-target");
      await fs.rename(entry.dir, target);
      destination = entry.dir;
    }
    else if (level === "storage") {
      target = path.join(outside, "scores");
      await fs.rename(path.join(entry.dir, "scores"), target);
      destination = path.join(entry.dir, "scores");
    } else {
      destination = level === "backup" ? path.join(entry.dir, entry.files[0].backupPath) : entry.manifestPath;
      await fs.unlink(destination);
    }
    if (!await link(t, target, destination)) return;
    const summary = await f.trash.summary();
    assert.equal(summary.protectedCount, 1);
    assert.equal(summary.count, 0);
    await f.trash.empty({ confirm: true });
    assert.equal(await fs.readFile(sentinel, "utf8"), "preserve");
    assert.equal((await fs.lstat(destination)).isSymbolicLink(), true);
    if (level === "entry") {
      await fs.access(path.join(target, "manifest.json"));
      for (const file of entry.files) await fs.access(path.join(target, file.backupPath));
    }
    if (level !== "entry" && level !== "manifest") await fs.access(entry.manifestPath);
  });
}
test("rejects a file symlink backup without unlinking it or its target", async t => {
  const f = await fixture(t), entry = await complete(f), target = path.join(f.sandbox, "outside.txt");
  await fs.writeFile(target, "preserve");
  const destination = path.join(entry.dir, entry.files[0].backupPath);
  await fs.unlink(destination);
  if (!await link(t, target, destination, "file")) return;
  assert.deepEqual(await f.trash.empty({ confirm: true }),
    { count: 0, bytes: 0, protectedCount: 1, removedCount: 0, removedBytes: 0 });
  assert.equal(await fs.readFile(target, "utf8"), "preserve");
  assert.equal((await fs.lstat(destination)).isSymbolicLink(), true);
});
test("rechecks manifest before the first mutation and preserves changed entries", async t => {
  const f = await fixture(t), entry = await complete(f), scan = f.trash.scan.bind(f.trash);
  t.mock.method(f.trash, "scan", async () => {
    const result = await scan();
    entry.manifest.status = "pending";
    await writeManifest(entry);
    return result;
  });
  await assert.rejects(() => f.trash.empty({ confirm: true }), /changed|unsafe/);
  for (const file of entry.files) await fs.access(path.join(entry.dir, file.backupPath));
  assert.equal(f.library.busy, false);
});
test("rechecks backup identity and exact directory contents before mutation", async t => {
  const f = await fixture(t), entry = await complete(f), scan = f.trash.scan.bind(f.trash);
  const backup = path.join(entry.dir, entry.files[0].backupPath);
  t.mock.method(f.trash, "scan", async () => {
    const result = await scan();
    await fs.writeFile(backup, "changed backup");
    return result;
  });
  await assert.rejects(() => f.trash.empty({ confirm: true }), /changed|unsafe/);
  assert.equal(await fs.readFile(backup, "utf8"), "changed backup");
  await fs.access(entry.manifestPath);
});
test("unexpected files added after enumeration prevent any deletion", async t => {
  const f = await fixture(t), entry = await complete(f), scan = f.trash.scan.bind(f.trash);
  const extra = path.join(entry.dir, "scores", "recovery.txt");
  t.mock.method(f.trash, "scan", async () => {
    const result = await scan();
    await fs.writeFile(extra, "preserve");
    return result;
  });
  await assert.rejects(() => f.trash.empty({ confirm: true }), /changed|unsafe/);
  for (const file of entry.files) await fs.access(path.join(entry.dir, file.backupPath));
  assert.equal(await fs.readFile(extra, "utf8"), "preserve");
  await fs.access(entry.manifestPath);
});
test("a storage junction installed after enumeration cannot redirect deletion", async t => {
  const f = await fixture(t), entry = await complete(f), scan = f.trash.scan.bind(f.trash);
  const outside = path.join(f.sandbox, "outside");
  await fs.mkdir(outside);
  const storage = path.join(entry.dir, "scores"), moved = path.join(outside, "scores");
  await fs.rename(storage, moved);
  // Establish that junctions are available before injecting the race.
  if (!await link(t, moved, storage)) return;
  await fs.unlink(storage);
  await fs.rename(moved, storage);
  t.mock.method(f.trash, "scan", async () => {
    const result = await scan();
    await fs.rename(storage, moved);
    await fs.symlink(moved, storage, "junction");
    return result;
  });
  await assert.rejects(() => f.trash.empty({ confirm: true }), /changed|unsafe/);
  for (const file of entry.files) await fs.access(path.join(moved, path.basename(file.backupPath)));
  await fs.access(entry.manifestPath);
});
test("a write handle prevents deletion and preserves all recovery data and releases the lock",
  { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), entry = await complete(f);
  const writer = await fs.open(path.join(entry.dir, entry.files[1].backupPath), "r+");
  try { await assert.rejects(() => f.trash.empty({ confirm: true }), /deletion failed/); }
  finally { await writer.close(); }
  await fs.access(entry.manifestPath);
  for (const file of entry.files) await fs.access(path.join(entry.dir, file.backupPath));
  assert.equal(f.library.busy, false);
  assert.deepEqual(await f.trash.summary(), { count: 1, bytes: entry.bytes, protectedCount: 0 });
});
for (const level of ["storage", "entry", "artifact-trash", ".local", "workspace", "ancestor"]) {
  test(`native guards stop ${level} replacement at the final deletion boundary`, { skip: process.platform !== "win32" }, async t => {
    const f = await fixture(t), entry = await complete(f), outside = path.join(f.sandbox, "outside");
    await fs.mkdir(outside);
    for (const file of entry.files) await fs.writeFile(path.join(outside, path.basename(file.backupPath)), "outside sentinel");
    const source = { storage: path.join(entry.dir, "scores"), entry: entry.dir, "artifact-trash": f.base,
      ".local": path.dirname(f.base), workspace: f.root, ancestor: f.sandbox }[level];
    const moved = source + "-moved";
    let boundaries = 0;
    t.mock.method(f.trash, "invokeDelete", input => gatedDelete(input, async stage => {
      boundaries++;
      if (stage === "guarded") {
        // This is immediately before SetFileInformationByHandle, after the
        // helper's final validation. The rename must fail while guards are held.
        await assert.rejects(fs.rename(source, moved), error => ["EPERM", "EACCES", "EBUSY"].includes(error.code));
        await assert.rejects(fs.writeFile(entry.manifestPath, '{"status":"pending"}'),
          error => ["EPERM", "EACCES", "EBUSY"].includes(error.code));
        for (const file of entry.files)
          await assert.rejects(fs.writeFile(path.join(entry.dir, file.backupPath), "changed"),
            error => ["EPERM", "EACCES", "EBUSY"].includes(error.code));
        await fs.access(entry.manifestPath);
      } else {
        await assert.rejects(fs.rename(entry.dir, entry.dir + "-moved"),
          error => ["EPERM", "EACCES", "EBUSY"].includes(error.code));
        await fs.access(entry.manifestPath);
      }
      for (const file of entry.files)
        assert.equal(await fs.readFile(path.join(outside, path.basename(file.backupPath)), "utf8"), "outside sentinel");
    }));
    const result = await f.trash.empty({ confirm: true });
    assert.equal(result.removedCount, 1);
    assert.equal(boundaries, 2);
    await assert.rejects(fs.access(entry.dir), { code: "ENOENT" });
  });
}
test("a junction switched after the final Node check is refused by the helper", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), entry = await complete(f), outside = path.join(f.sandbox, "outside");
  await fs.mkdir(outside);
  for (const file of entry.files) await fs.writeFile(path.join(outside, path.basename(file.backupPath)), "outside sentinel");
  const storage = path.join(entry.dir, "scores"), moved = path.join(entry.dir, "scores-moved");
  const invoke = f.trash.invokeDelete.bind(f.trash);
  t.mock.method(f.trash, "invokeDelete", async input => {
    await fs.rename(storage, moved);
    await fs.symlink(outside, storage, "junction");
    return invoke(input);
  });
  await assert.rejects(() => f.trash.empty({ confirm: true }), /deletion failed/);
  await fs.access(entry.manifestPath);
  for (const file of entry.files) {
    assert.equal(await fs.readFile(path.join(outside, path.basename(file.backupPath)), "utf8"), "outside sentinel");
    await fs.access(path.join(moved, path.basename(file.backupPath)));
  }
});
test("helper failure never falls back to path deletion", async t => {
  const f = await fixture(t), entry = await complete(f);
  t.mock.method(f.trash, "invokeDelete", async () => { throw new Error("Helper unavailable"); });
  t.mock.method(fs, "unlink", async () => { throw new Error("Unsafe fallback used"); });
  t.mock.method(fs, "rmdir", async () => { throw new Error("Unsafe fallback used"); });
  await assert.rejects(() => f.trash.empty({ confirm: true }), /Helper unavailable|requires Windows/);
  await fs.access(entry.manifestPath);
  for (const file of entry.files) await fs.access(path.join(entry.dir, file.backupPath));
});
test("exact file identities survive JSON without numeric inode rounding", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), entry = await complete(f);
  let verified = false;
  t.mock.method(f.trash, "invokeDelete", async input => {
    const plan = JSON.parse(input), stat = await fs.lstat(path.join(entry.dir, entry.files[0].backupPath), { bigint: true });
    assert.equal(plan.files[0].ino, stat.ino.toString());
    assert.equal(plan.files[0].dev, stat.dev.toString());
    verified = true;
    throw new Error("Checked only");
  });
  await assert.rejects(() => f.trash.empty({ confirm: true }), /Checked only/);
  assert.equal(verified, true);
  await fs.access(entry.manifestPath);
});
test("a backup replaced after the last Node check is refused before any mutation",
  { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), entry = await complete(f), invoke = f.trash.invokeDelete.bind(f.trash);
  const backup = path.join(entry.dir, entry.files[0].backupPath), moved = path.join(entry.dir, "original-backup");
  t.mock.method(f.trash, "invokeDelete", async input => {
    await fs.rename(backup, moved);
    await fs.writeFile(backup, "replacement sentinel");
    return invoke(input);
  });
  await assert.rejects(() => f.trash.empty({ confirm: true }), /deletion failed/);
  assert.equal(await fs.readFile(backup, "utf8"), "replacement sentinel");
  await fs.access(entry.manifestPath);
  await fs.access(moved);
  await fs.access(path.join(entry.dir, entry.files[1].backupPath));
});
test("manifest edits after the last Node check are refused by native validation",
  { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), entry = await complete(f), invoke = f.trash.invokeDelete.bind(f.trash);
  t.mock.method(f.trash, "invokeDelete", async input => {
    entry.manifest.status = "pending";
    await writeManifest(entry);
    return invoke(input);
  });
  await assert.rejects(() => f.trash.empty({ confirm: true }), /deletion failed/);
  assert.equal(JSON.parse(await fs.readFile(entry.manifestPath, "utf8")).status, "pending");
  for (const file of entry.files) await fs.access(path.join(entry.dir, file.backupPath));
});
test("an unexpected storage addition at disposition preserves the manifest after partial deletion",
  { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), entry = await complete(f), original = await fs.readFile(entry.manifestPath);
  const extra = path.join(entry.dir, "scores", "unexpected.txt");
  t.mock.method(f.trash, "invokeDelete", input => gatedDelete(input, async stage => {
    assert.equal(stage, "guarded");
    await fs.writeFile(extra, "preserve unexpected");
  }));
  await assert.rejects(() => f.trash.empty({ confirm: true }));
  assert.deepEqual(await fs.readFile(entry.manifestPath), original);
  assert.equal(await fs.readFile(extra, "utf8"), "preserve unexpected");
  for (const file of entry.files) await assert.rejects(fs.access(path.join(entry.dir, file.backupPath)), { code: "ENOENT" });
  assert.equal(f.library.busy, false);
  assert.equal((await f.trash.summary()).protectedCount, 1);
});
test("a final directory cleanup failure restores the exact manifest without removing unknown files",
  { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), entry = await complete(f), original = await fs.readFile(entry.manifestPath);
  const extra = path.join(entry.dir, "unexpected.txt");
  t.mock.method(f.trash, "invokeDelete", input => gatedDelete(input, async stage => {
    if (stage === "cleanup") await fs.writeFile(extra, "preserve unexpected");
  }));
  await assert.rejects(() => f.trash.empty({ confirm: true }));
  assert.deepEqual(await fs.readFile(entry.manifestPath), original);
  assert.equal(await fs.readFile(extra, "utf8"), "preserve unexpected");
  assert.equal(f.library.busy, false);
  assert.equal((await f.trash.summary()).protectedCount, 1);
});
test("native helper refuses a traversal plan rather than touching a sentinel",
  { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), entry = await complete(f), sentinel = path.join(f.sandbox, "outside.txt");
  await fs.writeFile(sentinel, "preserve");
  const invoke = f.trash.invokeDelete.bind(f.trash);
  t.mock.method(f.trash, "invokeDelete", input => {
    const plan = JSON.parse(input);
    plan.files[0].path = "../../../outside.txt";
    return invoke(JSON.stringify(plan));
  });
  await assert.rejects(() => f.trash.empty({ confirm: true }), /deletion failed/);
  assert.equal(await fs.readFile(sentinel, "utf8"), "preserve");
  await fs.access(entry.manifestPath);
  for (const file of entry.files) await fs.access(path.join(entry.dir, file.backupPath));
});
test("missing helper and invalid success output fail closed without unlink fallback",
  { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), entry = await complete(f);
  const { PassThrough } = require("node:stream");
  for (const outcome of ["missing", "invalid", "failure"]) {
    t.mock.method(childProcess, "execFile", (executable, args, options, callback) => {
      assert.equal(executable, path.resolve(__dirname, "..", "bin", "ScoreTrashDelete.exe"));
      const stdin = new PassThrough();
      stdin.resume();
      process.nextTick(() => {
        if (outcome === "missing") {
          stdin.emit("error", Object.assign(new Error("Missing"), { code: "EPIPE" }));
          callback(Object.assign(new Error("Missing"), { code: "ENOENT" }), "", "");
        } else callback(outcome === "failure" ? new Error("Denied") : null, '{"removed":true}', "");
      });
      return { stdin };
    });
    await assert.rejects(() => f.trash.empty({ confirm: true }), /deletion failed|changed|unsafe/);
    await fs.access(entry.manifestPath);
    for (const file of entry.files) await fs.access(path.join(entry.dir, file.backupPath));
  }
});
test("unsupported hosts refuse permanent deletion before invoking a helper", async t => {
  const f = await fixture(t), entry = await complete(f);
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  t.mock.method(f.trash, "invokeDelete", async () => { throw new Error("Helper unexpectedly invoked"); });
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: "linux" });
    await assert.rejects(() => f.trash.empty({ confirm: true }), /requires Windows/);
  } finally { Object.defineProperty(process, "platform", descriptor); }
  await fs.access(entry.manifestPath);
  for (const file of entry.files) await fs.access(path.join(entry.dir, file.backupPath));
});
