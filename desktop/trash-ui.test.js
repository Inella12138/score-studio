"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs");
const { JSDOM } = require("../.test-runtime/node_modules/jsdom");
test("empty recycle bin explains permanence, requires confirmation and refreshes its counts", async t => {
  const dom = new JSDOM(fs.readFileSync(`${__dirname}/../index.html`, "utf8"), {
    url: "http://127.0.0.1:18761/#token=test", runScripts: "outside-only", pretendToBeVisual: true
  });
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document, $ = id => d.getElementById(id);
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  let count = 2, clears = 0, accepted = false, question = "";
  w.confirm = s => { question = s; return accepted; };
  w.fetch = async (route, opts) => ({ ok: true, json: async () => {
    if (route === "/api/list") return { files: [] };
    if (route === "/api/artifacts/trash") return { count, bytes: count * 1024, protectedCount: 1 };
    if (route === "/api/artifacts/trash/empty") {
      assert.equal(JSON.parse(opts.body).confirm, true); clears++; count = 0;
      return { message: "已清空本地回收区" };
    }
    throw new Error("Unexpected route");
  } });
  w.eval(fs.readFileSync(`${__dirname}/../core.js`, "utf8")); w.eval(fs.readFileSync(`${__dirname}/../app.js`, "utf8"));
  $("openArtifactTrash").click(); await new Promise(r => setImmediate(r));
  assert.equal($("trashDialog").open, true);
  assert.match($("trashSummary").textContent, /2 份已删除脚本/);
  assert.match($("trashSummary").textContent, /1 项未完成/);
  $("emptyArtifactTrash").click(); await new Promise(r => setImmediate(r));
  assert.equal(clears, 0); assert.match(question, /永久删除.*无法撤销/);
  accepted = true; $("emptyArtifactTrash").click(); await new Promise(r => setImmediate(r));
  assert.equal(clears, 1); assert.equal($("emptyArtifactTrash").disabled, true);
  assert.match($("trashStatus").textContent, /已清空/);
});
