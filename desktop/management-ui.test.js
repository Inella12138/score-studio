"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs");
const { JSDOM } = require("../.test-runtime/node_modules/jsdom");
test("artifact management locates existing files, confirms deletion and cleans only stale variants", async t => {
  const dom = new JSDOM(fs.readFileSync(`${__dirname}/../index.html`, "utf8"), {
    url: "http://127.0.0.1:18761/#token=test", runScripts: "outside-only", pretendToBeVisual: true
  });
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document, $ = id => d.getElementById(id), requests = [], confirmations = [];
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  let accept = false;
  w.confirm = text => { confirmations.push(text); return accept; };
  const stale = { id: "stale", scoreName: "test.score.json", title: "合奏", voiceNames: ["高声部"], mode: "tap", stale: true, fileName: "合奏-高声部-点按-stale.ahk", createdAt: new Date().toISOString() };
  const fresh = { ...stale, id: "fresh", stale: false, fileName: "合奏-高声部-点按-fresh.ahk" };
  let variants = [stale, fresh];
  w.fetch = async (route, options) => {
    requests.push({ route, options });
    let result;
    if (route === "/api/list") result = { files: [{ name: "test.score.json", title: "合奏", valid: true, voices: 1, voiceNames: ["高声部"], artifactCount: variants.length, artifacts: variants }] };
    else if (route.startsWith("/api/artifact?")) result = { script: "#Requires AutoHotkey v2.0", metadata: fresh };
    else if (route === "/api/artifacts/reveal") result = { ok: true };
    else if (route === "/api/artifacts/delete") { const { id } = JSON.parse(options.body); variants = variants.filter(a => a.id !== id); result = { message: "已移到回收区" }; }
    else if (route === "/api/artifacts/clean-stale") { variants = variants.filter(a => !a.stale); result = { message: "已清理" }; }
    else throw new Error("Unexpected route");
    return { ok: true, json: async () => result };
  };
  w.eval(fs.readFileSync(`${__dirname}/../core.js`, "utf8")); w.eval(fs.readFileSync(`${__dirname}/../app.js`, "utf8"));
  await new Promise(resolve => setImmediate(resolve));
  $("libraryGrid").querySelector(".tree-expand").click();
  const itemButton = (index, text) => [...$("libraryGrid").querySelectorAll(".artifact-item")][index].querySelectorAll("button")["预览|定位文件|删除".split("|").indexOf(text)];
  itemButton(0, "定位文件").click(); await new Promise(resolve => setImmediate(resolve));
  assert.ok(requests.some(r => r.route === "/api/artifacts/reveal"));
  itemButton(0, "删除").click();
  assert.ok(!requests.some(r => r.route === "/api/artifacts/delete"));
  accept = true; itemButton(1, "预览").click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal($("downloadArtifact").textContent, "定位文件");
  $("downloadArtifact").click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.filter(r => r.route === "/api/artifacts/reveal").length, 2);
  $("artifactDialog").close();
  $("libraryGrid").querySelector(".artifact-clean").click(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(variants.map(v => v.id), ["fresh"]);
  assert.equal($("libraryGrid").querySelectorAll(".artifact-item").length, 1);
  assert.equal($("libraryGrid").querySelector(".artifact-clean"), null);
  itemButton(0, "删除").click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(variants.length, 0); assert.ok(confirmations.every(s => s.includes("回收区")));
  const links = [...d.querySelectorAll(".git-install-help a")];
  assert.equal(links.length, 2);
  assert.ok(links.every(a => a.href === "https://git-scm.com/install/windows" && a.rel.includes("noopener")));
});
