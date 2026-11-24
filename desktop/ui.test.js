"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs");
const { JSDOM } = require("../.test-runtime/node_modules/jsdom");
test("desktop page saves to scores, lists library and requires an explicit upload confirmation", async t => {
  const dom = new JSDOM(fs.readFileSync(`${__dirname}/../index.html`, "utf8"), {
    url: "http://127.0.0.1:18761/#token=test-token", runScripts: "outside-only", pretendToBeVisual: true
  });
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document, $ = id => d.getElementById(id), requests = [];
  w.confirm = () => true;
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const fixture = { version: 1, title: "曲库测试", bpm: 74, meter: "4/4", gap: 40, keys: ["ZXCVBNM", "ASDFGHJ", "QWERTYU"],
    tempos: [], lengths: [], voices: [{ id: "v", name: "旋律", source: "1===" }] };
  w.fetch = async (route, options) => {
    requests.push({ route, options }); assert.equal(options.headers["X-Score-Token"], "test-token");
    let result;
    if (route === "/api/list") result = { files: [{ name: "曲库测试.score.json", title: "曲库测试", voices: 1, valid: true }] };
    else if (route.startsWith("/api/read")) result = { name: "曲库测试.score.json", sha: "old", project: fixture };
    else if (route === "/api/save") { assert.equal(JSON.parse(options.body).expectedSha, "old"); result = { name: "曲库测试.score.json", sha: "new" }; }
    else if (route === "/api/preview") result = { id: "preview", changes: [{ name: "曲库测试.score.json", action: "修改" }] };
    else if (route === "/api/upload") result = { message: "已上传 1 首曲谱" };
    else throw new Error("Unexpected request");
    return { ok: true, json: async () => result };
  };
  w.eval(fs.readFileSync(`${__dirname}/../core.js`, "utf8")); w.eval(fs.readFileSync(`${__dirname}/../app.js`, "utf8"));
  assert.equal($("openLibrary").hidden, false); assert.equal($("saveProject").textContent, "保存到曲库");
  $("openLibrary").click(); await new Promise(resolve => setImmediate(resolve));
  $("libraryFiles").querySelector("button").click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal($("title").value, "曲库测试");
  $("saveProject").click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.parse(requests.find(r => r.route === "/api/save").options.body).project.title, "曲库测试");
  $("uploadLibrary").click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.some(r => r.route === "/api/upload"), false);
  assert.ok($("uploadFiles").textContent.includes("修改：曲库测试.score.json"));
  $("confirmUpload").click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.filter(r => r.route === "/api/upload").length, 1);
  assert.equal($("uploadStatus").textContent, "已上传 1 首曲谱");
  $("uploadDialog").close();
  let finishSave, secondSave;
  w.fetch = async (route, options) => {
    if (!finishSave) return new Promise(resolve => { finishSave = () => resolve({ ok: true, json: async () => ({ name: "曲库测试.score.json", sha: "late-sha" }) }); });
    secondSave = JSON.parse(options.body);
    return { ok: true, json: async () => ({ name: secondSave.name, sha: "fresh" }) };
  };
  $("saveProject").click();
  $("newProject").click();
  finishSave(); await new Promise(resolve => setImmediate(resolve));
  $("saveProject").click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(secondSave.name, "未命名曲谱.score.json");
  assert.equal(secondSave.expectedSha, null);
});
