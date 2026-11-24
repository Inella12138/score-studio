"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
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
test("exports immutable local script pairs using core ordering and score voice order", async t => {
  const { root, library, project, request } = await fixture(t);
  for (const mode of ["tap", "hold"]) {
    const result = await library.artifacts.export({ ...request, mode, script: "malicious raw script" });
    const expected = C.ahk(project, C.makeEvents(project, C.compile(project), request.selected, mode), request.options);
    assert.equal(result.script, expected);
    assert.deepEqual(result.metadata.voiceNames, ["旋律", "低音"]);
    assert.equal(result.metadata.size, Buffer.byteLength(expected));
    assert.equal(result.metadata.stale, false);
    const dir = path.join(root, "artifacts", "song");
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
  const stored = JSON.parse(await fs.readFile(path.join(root, "artifacts", "song", `${metadata.id}.json`), "utf8"));
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
  assert.equal((await fs.readdir(path.join(root, "artifacts", "song"))).length, 2);
  for (const id of ["../secret", "abc", "", null, "0".repeat(36), "00000000-0000-0000-0000-000000000000"])
    await assert.rejects(() => library.artifacts.read(request.name, id));
  const invalid = { ...project, voices: [{ id: "bad", name: "bad", source: "1" }] };
  const saved = await library.save("invalid.score.json", invalid);
  await assert.rejects(() => library.artifacts.export({ ...request, ...saved, expectedSha: saved.sha, project: invalid, selected: ["bad"] }));
});
test("exports only selected voices with scheduling options and avoids Windows stem aliases", async t => {
  const { library, project, request } = await fixture(t);
  const options = { schedule: "20261201083000", startDelay: 0 };
  const result = await library.artifacts.export({ ...request, selected: ["bass"], options });
  assert.deepEqual(result.metadata.voiceNames, ["低音"]);
  assert.equal(result.script, C.ahk(project, C.makeEvents(project, C.compile(project), ["bass"], "tap"), options));
  assert.notEqual(library.artifacts.directory("song..score.json"), library.artifacts.directory("song%2E.score.json"));
  assert.notEqual(library.artifacts.directory("song .score.json"), library.artifacts.directory("song%20.score.json"));
  assert.ok(Buffer.byteLength(path.basename(library.artifacts.directory("%".repeat(160) + ".score.json"))) <= 240);
  await assert.rejects(() => library.artifacts.export(null), /Invalid export request/);
});
test("symlink storage and score reads are rejected; damaged pairs are excluded", async t => {
  const { root, library, request } = await fixture(t);
  const { metadata } = await library.artifacts.export(request);
  const dir = path.join(root, "artifacts", "song");
  await fs.writeFile(path.join(dir, metadata.fileName), "damaged");
  assert.deepEqual(await library.artifacts.list(request.name), []);
  await assert.rejects(() => library.artifacts.read(request.name, metadata.id), /size/i);
  const external = path.join(root, "other");
  await fs.mkdir(external);
  try { await fs.symlink(external, path.join(root, "artifacts", "linked"), "junction"); }
  catch (e) { if (e.code === "EPERM") { t.diagnostic("Symlink creation unavailable"); return; } throw e; }
  await assert.rejects(() => library.artifacts.list("linked.score.json", request.expectedSha), /Symlink/);
  try { await fs.symlink(path.join(root, "scores", request.name), path.join(root, "scores", "linked.score.json"), "file"); }
  catch (e) { if (e.code === "EPERM") { t.diagnostic("File symlink creation unavailable"); return; } throw e; }
  await assert.rejects(() => library.read("linked.score.json"), /Symlink/);
});
test("artifact HTTP routes preserve existing local authorization and expose no execution route", async t => {
  const { root, request } = await fixture(t);
  const { server, token } = createServer(root);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { "X-Score-Token": token, "Content-Type": "application/json" };
  const post = body => fetch(base + "/api/artifacts/export", { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal((await fetch(base + "/api/artifacts?name=song.score.json")).status, 403);
  const exported = await post(request);
  assert.equal(exported.status, 200);
  const { metadata, script } = await exported.json();
  const list = await (await fetch(base + "/api/artifacts?name=song.score.json", { headers })).json();
  assert.equal(list.artifacts[0].id, metadata.id);
  const read = await (await fetch(base + `/api/artifact?name=song.score.json&id=${metadata.id}`, { headers })).json();
  assert.equal(read.script, script);
  assert.equal((await post({ ...request, project: { ...request.project, bpm: 100 } })).status, 400);
  assert.equal((await fetch(base + "/api/artifact?name=song.score.json&id=../bad", { headers })).status, 400);
  assert.equal((await fetch(base + "/api/artifacts/execute", { method: "POST", headers, body: "{}" })).status, 404);
});
