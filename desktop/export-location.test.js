"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs");
const { JSDOM } = require("../.test-runtime/node_modules/jsdom");
test("export shows the actual saved file with a copyable path even when the sidebar is collapsed or refresh fails", async t => {
  const dom = new JSDOM(fs.readFileSync(`${__dirname}/../index.html`, "utf8"), {
    url: "http://127.0.0.1:18761/#token=test", runScripts: "outside-only", pretendToBeVisual: true
  });
  t.after(() => dom.window.close());
  const w = dom.window, $ = id => w.document.getElementById(id);
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  w.localStorage.setItem("score-studio.sidebar-collapsed", "true");
  const absolutePath = "D:\\Music App\\scores\\无中生有 Ex Nihilo.exports\\无中生有-高声部+低声部-tap-12345678.ahk";
  let exported = false, copied, lastRequest;
  Object.defineProperty(w.navigator, "clipboard", { value: { writeText: async text => { copied = text; } } });
  w.fetch = async (route, options) => {
    let result;
    if (route === "/api/list") {
      if (exported) throw new Error("refresh unavailable");
      result = { files: [] };
    } else if (route === "/api/save") {
      lastRequest = JSON.parse(options.body);
      result = { name: lastRequest.name, sha: "saved" };
    } else if (route === "/api/artifacts/export") {
      exported = true;
      result = { script: "#Requires AutoHotkey v2.0", metadata: {
        id: "artifact", scoreName: lastRequest.name, title: "无中生有", voiceNames: ["高声部", "低声部"],
        mode: "tap", absolutePath, fileName: absolutePath.split("\\").pop()
      } };
    } else if (route === "/api/artifacts/reveal") {
      return { ok: false, json: async () => ({ error: "文件管理器暂不可用" }) };
    } else throw new Error(`Unexpected route ${route}`);
    return { ok: true, json: async () => result };
  };
  w.eval(fs.readFileSync(`${__dirname}/../core.js`, "utf8"));
  w.eval(fs.readFileSync(`${__dirname}/../app.js`, "utf8"));
  await new Promise(resolve => setImmediate(resolve));
  $("openExport").click(); $("downloadAhk").click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal($("artifactDialog").open, true);
  assert.equal($("exportDialog").open, false);
  assert.equal($("artifactPath").value, absolutePath);
  assert.equal($("artifactPath").readOnly, true);
  assert.match($("artifactActionStatus").textContent, /脚本已保存.*刷新曲库失败/);
  $("copyArtifactPath").click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(copied, absolutePath);
  $("downloadArtifact").click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal($("artifactActionStatus").textContent, "文件管理器暂不可用");
  assert.equal($("artifactPath").value, absolutePath);
  assert.equal($("downloadArtifact").disabled, false);
  w.navigator.clipboard.writeText = async () => { throw new Error("denied"); };
  $("copyArtifactPath").click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal($("artifactPath").selectionEnd, absolutePath.length);
  assert.match($("artifactActionStatus").textContent, /Ctrl\+C/);
  const normalFetch = w.fetch;
  let finishReveal;
  w.fetch = (route, options) => route === "/api/artifacts/reveal" ?
    new Promise(resolve => { finishReveal = () => resolve({ ok: true, json: async () => ({ revealed: true }) }); }) :
    normalFetch(route, options);
  $("downloadArtifact").click();
  $("artifactDialog").close();
  $("openExport").click(); $("downloadAhk").click();
  await new Promise(resolve => setImmediate(resolve));
  const status = $("artifactActionStatus").textContent;
  assert.match(status, /脚本已保存/);
  finishReveal(); await new Promise(resolve => setImmediate(resolve));
  assert.equal($("artifactActionStatus").textContent, status, "an old reveal must not change a newer export preview");
  assert.equal($("downloadArtifact").disabled, false);
});
