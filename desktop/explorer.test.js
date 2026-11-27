"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), { JSDOM } = require("../.test-runtime/node_modules/jsdom");
test("sidebar switches the same editor, warns about unsaved changes and persists collapse", async t => {
  const dom = new JSDOM(fs.readFileSync(`${__dirname}/../index.html`, "utf8"), {
    url: "http://127.0.0.1:18761/#token=test", runScripts: "outside-only", pretendToBeVisual: true
  });
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document, $ = id => d.getElementById(id);
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const project = title => ({ version: 1, title, bpm: 74, meter: "4/4", gap: 40, keys: ["ZXCVBNM","ASDFGHJ","QWERTYU"], tempos: [], lengths: [], voices: [{ id: "v", name: "高声部", source: "1===" }] });
  const first = project("曲子甲"), second = project("曲子乙"), questions = [];
  let accepted = true;
  w.confirm = q => { questions.push(q); return accepted; };
  w.fetch = async (route, opts) => {
    let result;
    if (route === "/api/list") result = { files: ["曲子甲", "曲子乙"].map((title, i) => ({ name: `${i}.score.json`, title, voices: 1, valid: true, artifacts: [] })) };
    else if (route.startsWith("/api/read")) {
      const name = new URL(route, w.location.origin).searchParams.get("name");
      result = { name, sha: name, project: name === "0.score.json" ? first : second };
    } else if (route === "/api/save") {
      const body = JSON.parse(opts.body); result = { name: body.name, sha: "new" };
    } else throw new Error("Unexpected route");
    return { ok: true, json: async () => result };
  };
  w.localStorage.setItem("score-studio.sidebar-collapsed", "true");
  w.eval(fs.readFileSync(`${__dirname}/../core.js`, "utf8")); w.eval(fs.readFileSync(`${__dirname}/../app.js`, "utf8"));
  await new Promise(r => setImmediate(r));
  assert.equal($("libraryHome").hidden, true); assert.equal($("editorMain").hidden, false);
  $("toggleSidebar").click(); assert.equal($("libraryHome").hidden, false);
  const editor = $("editorMain");
  const open = index => $("libraryGrid").querySelectorAll(".tree-song-open")[index].click();
  open(0); await new Promise(r => setImmediate(r));
  assert.equal($("title").value, "曲子甲"); assert.equal($("editorMain"), editor);
  assert.ok($("libraryGrid").querySelector(".tree-song-row.selected"));
  assert.equal(questions.length, 1);
  open(1); await new Promise(r => setImmediate(r));
  assert.equal(questions.length, 1); assert.equal($("title").value, "曲子乙");
  $("title").value = "未保存修改"; $("title").dispatchEvent(new w.Event("input"));
  accepted = false; open(0); await new Promise(r => setImmediate(r));
  assert.equal($("title").value, "未保存修改"); assert.equal(questions.length, 2);
  accepted = true; open(0); await new Promise(r => setImmediate(r));
  assert.equal($("title").value, "曲子甲");
  const normalFetch = w.fetch;
  let resolveSecond;
  w.fetch = (route, opts) => route.startsWith("/api/read") && route.includes("1.score.json") ?
    new Promise(resolve => { resolveSecond = resolve; }) : normalFetch(route, opts);
  open(1); open(0);
  resolveSecond({ ok: true, json: async () => ({ name: "1.score.json", sha: "b", project: second }) });
  await new Promise(r => setImmediate(r));
  assert.equal($("title").value, "曲子甲", "reselecting the active song cancels a pending different-song read");
  w.fetch = normalFetch;
  let olderList, lists = 0;
  const rows = artifactCount => ["曲子甲","曲子乙"].map((title,i) => ({ name:`${i}.score.json`,title,voices:1,valid:true,artifactCount:i===0?artifactCount:0,artifacts:[] }));
  w.fetch = (route, opts) => {
    if (route === "/api/list") {
      lists++;
      if (lists === 1) return new Promise(resolve => { olderList = resolve; });
      return Promise.resolve({ ok:true,json:async()=>({files:rows(1)}) });
    }
    return normalFetch(route, opts);
  };
  $("saveProject").click(); await new Promise(r => setImmediate(r));
  $("refreshLibrary").click(); await new Promise(r => setImmediate(r));
  assert.equal($("navArtifactCount").textContent, "1");
  olderList({ok:true,json:async()=>({files:rows(0)})}); await new Promise(r => setImmediate(r));
  assert.equal($("navArtifactCount").textContent, "1", "late list results must not hide newly created scripts");
  w.fetch = normalFetch;
  $("title").value = "还在编辑"; $("title").dispatchEvent(new w.Event("input"));
  const expand = $("libraryGrid").querySelector(".tree-expand");
  expand.click(); assert.equal($("title").value, "还在编辑");
  $("toggleSidebar").click(); assert.equal($("editorMain").hidden, false);
  assert.equal($("title").value, "还在编辑");
  assert.equal(w.localStorage.getItem("score-studio.sidebar-collapsed"), "true");
});
