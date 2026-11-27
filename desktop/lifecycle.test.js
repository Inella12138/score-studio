"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { JSDOM } = require("../.test-runtime/node_modules/jsdom");
const { createServer } = require("./server");

test("shutdown notifies every authenticated editor, including late connections", async t => {
  const { server, token, notifyShutdown } = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { notifyShutdown(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + "/api/lifecycle")).status, 403);
  const headers = { "X-Score-Token": token };
  const responses = await Promise.all([fetch(base + "/api/lifecycle", { headers }), fetch(base + "/api/lifecycle", { headers })]);
  let received = false;
  const waiting = Promise.all(responses.map(response => response.json())).then(result => { received = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(received, false);
  notifyShutdown();
  assert.deepEqual(await waiting, [{ shutdown: true }, { shutdown: true }]);
  assert.deepEqual(await (await fetch(base + "/api/lifecycle", { headers })).json(), { shutdown: true });
});

for (const outcome of ["shutdown", "disconnect", "normal-tab"]) {
  test(`editor lifecycle: ${outcome}`, async t => {
    const dom = new JSDOM(fs.readFileSync(path.join(__dirname, "../index.html"), "utf8"), {
      url: `http://127.0.0.1:18761/#token=test${outcome === "normal-tab" ? "" : "&managed=1"}`,
      runScripts: "outside-only", pretendToBeVisual: true
    });
    const w = dom.window;
    const closeDom = w.close.bind(w);
    t.after(closeDom);
    let closed = 0, finish, fail, lifecycleCalls = 0;
    w.close = () => { closed++; };
    w.fetch = async (route, options) => {
      assert.equal(options.headers["X-Score-Token"], "test");
      if (route === "/api/lifecycle") {
        lifecycleCalls++;
        return new Promise((resolve, reject) => {
          finish = () => resolve({ ok: true, json: async () => ({ shutdown: true }) });
          fail = () => reject(new TypeError("connection lost"));
        });
      }
      assert.equal(route, "/api/list");
      return { ok: true, json: async () => ({ files: [] }) };
    };
    w.eval(fs.readFileSync(path.join(__dirname, "../core.js"), "utf8"));
    w.eval(fs.readFileSync(path.join(__dirname, "../app.js"), "utf8"));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, 0);
    if (outcome === "normal-tab") { assert.equal(lifecycleCalls, 0); return; }
    assert.equal(lifecycleCalls, 1);
    assert.equal(w.sessionStorage.getItem("score-desktop-managed"), "1");
    if (outcome === "shutdown") finish(); else fail();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, outcome === "shutdown" ? 1 : 0);
    if (outcome === "shutdown") assert.ok(w.localStorage.getItem("score-studio.project.v1"));
  });
}
