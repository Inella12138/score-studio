"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs");
const { JSDOM } = require("../.test-runtime/node_modules/jsdom");
test("explorer keeps the draft editor visible, collapses without losing edits and lists scripts below songs", async t => {
  const dom = new JSDOM(fs.readFileSync(`${__dirname}/../index.html`, "utf8"), { url: "http://127.0.0.1:18761/#token=test", runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document, $ = id => d.getElementById(id);
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const draft = { version: 1, title: "未保存草稿", bpm: 74, meter: "4/4", gap: 40, keys: ["ZXCVBNM","ASDFGHJ","QWERTYU"], tempos: [], lengths: [], voices: [{ id: "v", name: "人声", source: "1===" }] };
  w.localStorage.setItem("score-studio.project.v1", JSON.stringify(draft));
  const artifact = { id: "id", voiceNames: ["高声部"], mode: "tap", createdAt: new Date().toISOString(), stale: true, fileName: "test.ahk" };
  const files = [
    { name: "a.score.json", title: "曲子甲", voices: 1, voiceNames: ["人声"], valid: true, bars: 1, bpm: 74, meter: "4/4", artifacts: [] },
    { name: "b.score.json", title: "曲子乙", voices: 1, voiceNames: ["高声部"], valid: true, bars: 1, bpm: 74, meter: "4/4", artifactCount: 1, artifacts: [artifact] }
  ];
  w.fetch = async route => ({ ok: true, json: async () => route === "/api/list" ? { files } : { script: "#Requires AutoHotkey v2.0", metadata: artifact } });
  w.eval(fs.readFileSync(`${__dirname}/../core.js`, "utf8")); w.eval(fs.readFileSync(`${__dirname}/../app.js`, "utf8"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal($("editorMain").hidden, false); assert.equal($("libraryGrid").children.length, 2);
  $("toggleSidebar").click();
  assert.equal($("libraryHome").hidden, true);
  assert.equal(w.localStorage.getItem("score-studio.sidebar-collapsed"), "true");
  assert.equal($("editorMain").hidden, false); assert.equal($("title").value, "未保存草稿");
  $("openLibrary").click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal($("editorMain").hidden, false); assert.equal($("libraryHome").hidden, false);
  assert.equal($("toggleSidebar").getAttribute("aria-expanded"), "true");
  $("librarySearch").value = "人声"; $("librarySearch").dispatchEvent(new w.Event("input"));
  assert.equal($("libraryGrid").children.length, 1);
  assert.ok($("libraryGrid").textContent.includes("曲子甲"));
  $("librarySearch").value = ""; $("librarySearch").dispatchEvent(new w.Event("input"));
  $("filterArtifacts").click(); assert.equal($("libraryGrid").children.length, 1);
  $("libraryGrid").querySelector(".tree-expand").click();
  assert.ok($("libraryGrid").textContent.includes("曲谱已更新"));
  $("libraryGrid").querySelector(".artifact-item button").click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal($("artifactDialog").open, true);
  assert.equal($("artifactCode").textContent, "#Requires AutoHotkey v2.0");
  assert.equal(JSON.parse(w.localStorage.getItem("score-studio.project.v1")).title, "未保存草稿");
});
