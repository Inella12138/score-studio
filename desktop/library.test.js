"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { Library, gitSha, safeName } = require("./library"), { createServer } = require("./server");
const data = title => Buffer.from(JSON.stringify({ version: 1, title, bpm: 74, meter: "4/4", gap: 40,
  keys: ["ZXCVBNM", "ASDFGHJ", "QWERTYU"], tempos: [], lengths: [], voices: [{ id: "v", name: "声部", source: "0===" }] }, null, 2) + "\n");
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "score-library-"));
  t.after(async () => {
    const rel = path.relative(os.tmpdir(), root);
    assert.ok(!rel.startsWith("..") && !path.isAbsolute(rel) && path.basename(root).startsWith("score-library-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const state = { head: "a", files: new Map(), calls: [] };
  const remote = {
    repoPath: "/repos/test/repo",
    credential: async () => "test-secret",
    snapshot: async () => ({ head: state.head, tree: "tree", files: [...state.files].map(([name, bytes]) => ({ path: `scores/${name}`, sha: gitSha(bytes) })) }),
    blob: async sha => [...state.files.values()].find(d => gitSha(d) === sha),
    api: async (route, options) => {
      state.calls.push({ route, options });
      if (route.endsWith("/blobs")) return { sha: gitSha(Buffer.from(options.body.content, "base64")) };
      if (route.endsWith("/trees")) return { sha: "new-tree" };
      if (route.endsWith("/commits")) return { sha: "new-head" };
      if (route.includes("/refs/")) {
        assert.equal(options.body.force, false); state.head = options.body.sha; return {};
      }
      throw new Error("Unexpected request");
    }
  };
  return { root, remote, state, library: new Library(root, remote) };
}
test("curve saves use expected hash; filenames and invalid JSON cannot escape scores", async t => {
  const { library, root } = await fixture(t);
  const project = JSON.parse(data("第一版"));
  const saved = await library.save("曲谱.score.json", project);
  assert.ok(saved.sha); assert.equal((await library.list()).length, 1);
  await assert.rejects(() => library.save("曲谱.score.json", project), /同名/);
  await library.save("曲谱.score.json", { ...project, title: "第二版" }, saved.sha);
  assert.equal((await library.read("曲谱.score.json")).project.title, "第二版");
  for (const name of ["../secret.score.json", "a/b.score.json", "C:foo.score.json", ".score.json", "NUL.score.json"])
    assert.throws(() => safeName(name));
  await assert.rejects(() => library.save("bad.score.json", {}));
  assert.equal((await fs.readdir(path.join(root, "scores"))).length, 1);
  assert.equal(safeName("secret base Ver..score.json"), "secret base Ver..score.json");
});
test("Windows case-insensitive names cannot create a remote library collision", async t => {
  const { library, state } = await fixture(t);
  state.files.set("A.score.json", data("remote"));
  await library.save("a.score.json", JSON.parse(data("local")));
  await assert.rejects(() => library.prepare(), /大小写/);
  await assert.rejects(() => library.update(), /大小写/);
});
test("anonymous update preserves local edits and saves both sides of true conflicts", async t => {
  const { library, state, root } = await fixture(t);
  state.files.set("a.score.json", data("remote initial"));
  let r = await library.update(); assert.equal(r.downloaded.length, 1);
  const local = await library.read("a.score.json");
  await library.save("a.score.json", JSON.parse(data("local edited")), local.sha);
  r = await library.update(); assert.equal(r.conflicts.length, 0);
  assert.equal((await library.read("a.score.json")).project.title, "local edited");
  state.files.set("a.score.json", data("remote edited")); state.head = "b";
  r = await library.update(); assert.deepEqual(r.conflicts, ["a.score.json"]);
  assert.equal((await library.read("a.score.json")).project.title, "local edited");
  assert.equal((await fs.readdir(path.join(root, ".local", "conflicts"))).length, 1);
  await assert.rejects(() => library.prepare(), /远程已修改/);
});
test("upload requires review then uses one atomic non-forced commit; stale reviews cannot overwrite", async t => {
  const { library, state } = await fixture(t);
  await library.save("new.score.json", JSON.parse(data("new")));
  const preview = await library.prepare();
  assert.deepEqual(preview.changes, [{ name: "new.score.json", action: "新增" }]);
  assert.equal(state.calls.length, 0); assert.ok(!JSON.stringify(preview).includes("test-secret"));
  const r = await library.upload(preview.id); assert.equal(r.commit, "new-head");
  assert.equal(state.calls.filter(c => c.route.endsWith("/commits")).length, 1);
  await assert.rejects(() => library.upload(preview.id), /过期/);
  state.files.set("new.score.json", data("new"));
  const local = await library.read("new.score.json");
  await library.save("new.score.json", JSON.parse(data("changed")), local.sha);
  const second = await library.prepare();
  state.head = "another-head";
  await assert.rejects(() => library.upload(second.id), /远程在预览后/);
});
test("remote invalid content aborts update before writing any downloaded file", async t => {
  const { library, state } = await fixture(t);
  state.files.set("good.score.json", data("good")); state.files.set("bad.score.json", Buffer.from("{}"));
  await assert.rejects(() => library.update());
  assert.deepEqual(await library.list(), []);
});
test("local HTTP API rejects cross origin, missing token, traversal and writes without authorization", async t => {
  const { root } = await fixture(t);
  await fs.writeFile(path.join(root, "index.html"), "<!doctype html><title>test</title>");
  const { server, token } = createServer(root);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base)).status, 200);
  assert.equal((await fetch(base + "/api/list")).status, 403);
  const headers = { "X-Score-Token": token, "Content-Type": "application/json" };
  assert.equal((await fetch(base + "/api/list", { headers: { ...headers, Origin: "https://evil.test" } })).status, 403);
  const save = await fetch(base + "/api/save", { method: "POST", headers, body: JSON.stringify({ name: "a.score.json", project: JSON.parse(data("saved")) }) });
  assert.equal(save.status, 200);
  const list = await (await fetch(base + "/api/list", { headers })).json();
  assert.equal(list.files[0].title, "saved");
  assert.equal((await fetch(base + "/api/read?name=../secret.score.json", { headers })).status, 400);
  assert.equal((await fetch(base + "/desktop/github.js", { headers })).status, 404);
});
