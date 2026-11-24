"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const github = require("./github"), fs = require("node:fs"), { JSDOM } = require("../.test-runtime/node_modules/jsdom");
test("GitHub transport failures and anonymous rate limits have distinct useful messages", async t => {
  const previous = global.fetch; t.after(() => { global.fetch = previous; });
  global.fetch = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(() => github.api("/test"), /本地服务正常.*无法连接 GitHub/);
  global.fetch = async () => ({ ok: false, status: 403, headers: new Headers({ "x-ratelimit-remaining": "0" }) });
  await assert.rejects(() => github.api("/test"), /请求次数已达上限/);
  global.fetch = async () => { const error = new Error("timeout"); error.name = "TimeoutError"; throw error; };
  await assert.rejects(() => github.api("/test"), /连接 GitHub 超时/);
});
test("desktop explains that the local service disconnected instead of displaying Failed to fetch", async t => {
  const dom = new JSDOM(fs.readFileSync(`${__dirname}/../index.html`, "utf8"), { url: "http://127.0.0.1:18761/#token=test", runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document;
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.fetch = async () => { throw new TypeError("Failed to fetch"); };
  w.eval(fs.readFileSync(`${__dirname}/../core.js`, "utf8")); w.eval(fs.readFileSync(`${__dirname}/../app.js`, "utf8"));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(d.getElementById("homeStatus").textContent, /无法连接本地曲库服务/);
  d.getElementById("updateLibrary").click(); await new Promise(resolve => setImmediate(resolve));
  assert.match(d.getElementById("libraryStatus").textContent, /重新运行 ScoreStudio.exe/);
  assert.ok(!d.getElementById("libraryStatus").textContent.includes("Failed to fetch"));
});
