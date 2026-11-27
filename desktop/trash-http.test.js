"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { createServer } = require("./server"), C = require("../core");
test("trash HTTP routes require local authorization and explicit destructive confirmation", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "score-trash-http-"));
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith("score-trash-http-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const { server, library, token } = createServer(root);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`, headers = { "X-Score-Token": token, "Content-Type": "application/json" };
  const p = { version: 1, title: "回收测试", bpm: 74, meter: "4/4", gap: 40, keys: C.DEFAULT_KEYS, tempos: [], lengths: [], voices: [{ id: "v", name: "高声部", source: "1===" }] };
  const saved = await library.save("song.score.json", p);
  const a = await library.artifacts.export({ name: saved.name, expectedSha: saved.sha, project: p, selected: ["v"], mode: "tap" });
  await library.artifacts.remove(saved.name, a.metadata.id);
  assert.equal((await fetch(base + "/api/artifacts/trash")).status, 403);
  assert.equal((await fetch(base + "/api/artifacts/trash/empty", { method: "POST", body: '{"confirm":true}' })).status, 403);
  const summary = await (await fetch(base + "/api/artifacts/trash", { headers })).json();
  assert.equal(summary.count, 1);
  assert.equal((await fetch(base + "/api/artifacts/trash/empty", { method: "POST", headers, body: "{}" })).status, 400);
  const cleared = await fetch(base + "/api/artifacts/trash/empty", { method: "POST", headers, body: '{"confirm":true}' });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).count, 0);
  assert.equal((await library.read(saved.name)).project.title, p.title);
});
