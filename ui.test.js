"use strict";
// Optional DOM test dependency: npm install --prefix .test-runtime --no-save --no-package-lock jsdom
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { JSDOM } = require("./.test-runtime/node_modules/jsdom");
async function waitForDom(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("DOM rendering did not settle");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
test("offline page: demo, live errors, selected export, simplification and project data", async () => {
  const errors = [];
  const dom = new JSDOM(fs.readFileSync(`${__dirname}/index.html`, "utf8"), {
    url: "https://score-studio.test/", runScripts: "outside-only", pretendToBeVisual: true
  });
  const w = dom.window, d = w.document;
  w.addEventListener("error", e => errors.push(e.message));
  w.confirm = () => true;
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  w.eval(fs.readFileSync(`${__dirname}/core.js`, "utf8"));
  w.eval(fs.readFileSync(`${__dirname}/app.js`, "utf8"));
  const $ = id => d.getElementById(id);
  assert.equal($("compileBadge").textContent, "✓ 实时编译");
  assert.equal(d.querySelectorAll(".voice-card").length, 2);
  assert.ok(d.querySelectorAll(".measure").length >= 8);
  assert.ok(d.querySelectorAll(".tied").length >= 2);
  assert.ok(d.querySelectorAll(".pitch.low").length);
  assert.ok(d.querySelectorAll(".pitch.high").length);
  $("openExport").click();
  assert.equal($("downloadAhk").disabled, false);
  d.querySelector('input[name="mode"][value="hold"]').click();
  assert.equal($("holdSettings").hidden, false);
  assert.equal($("repeatGapMs").value, "30");
  assert.equal($("minHoldPercent").value, "80");
  $("repeatGapMs").value = "25";
  $("repeatGapMs").dispatchEvent(new w.Event("input", { bubbles: true }));
  $("minHoldPercent").value = "85";
  $("minHoldPercent").dispatchEvent(new w.Event("input", { bubbles: true }));
  assert.equal(JSON.parse(w.localStorage.getItem("score-studio.project.v1")).repeatGapMs, 25);
  assert.equal(JSON.parse(w.localStorage.getItem("score-studio.project.v1")).minHoldPercent, 85);
  assert.ok($("exportStatus").textContent.includes("琶音末音"));
  $("previewCode").click();
  assert.ok($("codePreview").textContent.includes("QueryPerformanceCounter"));
  d.querySelector('input[name="scope"][value="selected"]').click();
  const checks = $("exportVoices").querySelectorAll("input");
  checks[0].click(); checks[1].click();
  assert.equal($("downloadAhk").disabled, true);
  checks[0].click();
  assert.equal($("downloadAhk").disabled, false);
  $("exportDialog").close();
  const source = d.querySelector("textarea");
  source.value = "1"; source.dispatchEvent(new w.Event("input", { bubbles: true }));
  await new Promise(r => setTimeout(r, 200));
  assert.ok($("diagnostics").textContent.includes("缺少"));
  assert.ok($("compileBadge").textContent.includes("待修正"));
  $("openExport").click();
  assert.equal($("downloadAhk").disabled, true);
  $("exportDialog").close();
  $("loadDemo").click();
  assert.equal($("compileBadge").textContent, "✓ 实时编译");
  $("settingsButton").click();
  assert.equal(d.querySelectorAll("#tempoRows .setting-row").length, 1);
  $("addTempo").click();
  assert.equal(d.querySelectorAll("#tempoRows .setting-row").length, 2);
  $("settingsDone").click();
  assert.equal($("compileBadge").textContent, "✓ 实时编译");
  assert.ok(w.localStorage.getItem("score-studio.project.v1"));
  const allSources = [...d.querySelectorAll("textarea")];
  allSources[0].value = "{1234}-- {5671}-- <2>3 0";
  allSources[1].value = "0===";
  for (const input of allSources) input.dispatchEvent(new w.Event("input", { bubbles: true }));
  await new Promise(r => setTimeout(r, 230));
  assert.equal($("compileBadge").textContent, "✓ 实时编译");
  assert.equal(d.querySelectorAll(".grace-notes").length, 1);
  assert.equal(d.querySelectorAll(".beamed").length, 8);
  await waitForDom(() => d.querySelectorAll(".beam-layer line").length === 4);
  assert.equal(d.querySelectorAll(".beam-layer line").length, 4);
  allSources[0].value = "{1234}-- {5671}-- (4050<40>50) 0";
  allSources[0].dispatchEvent(new w.Event("input", { bubbles: true }));
  await new Promise(r => setTimeout(r, 230));
  assert.equal($("compileBadge").textContent, "✓ 实时编译");
  assert.equal(d.querySelectorAll(".grace-notes").length, 1);
  assert.equal(d.querySelector(".grace-notes .grace-pitch.high").textContent, "4");
  assert.equal(d.querySelectorAll(".beamed").length, 11);
  await waitForDom(() => d.querySelectorAll(".beam-layer line").length === 5);
  assert.equal(d.querySelectorAll(".beam-layer line").length, 5);
  $("openExport").click();
  assert.equal($("downloadAhk").disabled, false);
  d.querySelector('input[name="mode"][value="hold"]').click();
  assert.ok($("exportStatus").textContent.includes("主音"));
  $("exportDialog").close();
  allSources[0].value = "12345671";
  allSources[0].dispatchEvent(new w.Event("input", { bubbles: true }));
  d.querySelector(".auto-bars").click();
  assert.equal(allSources[0].value, "1 2 3 4 |\n5 6 7 1");
  assert.equal(d.querySelector(".undo-bars").hidden, false);
  d.querySelector(".undo-bars").click();
  assert.equal(allSources[0].value, "12345671");
  assert.equal(d.querySelector(".undo-bars").hidden, true);
  d.querySelector(".auto-bars").click();
  allSources[0].value += " 2";
  d.querySelector(".undo-bars").click();
  assert.ok(allSources[0].value.endsWith(" 2"));
  $("newProject").click();
  assert.equal(d.querySelectorAll(".voice-card").length, 2);
  assert.deepEqual([...d.querySelectorAll(".voice-head input")].map(input => input.value), ["高声部", "低声部"]);
  assert.deepEqual([...d.querySelectorAll("textarea")].map(input => input.value), ["0===", "0==="]);
  assert.equal($("compileBadge").textContent, "✓ 实时编译");
  const fresh = JSON.parse(w.localStorage.getItem("score-studio.project.v1"));
  assert.equal(new Set(fresh.voices.map(voice => voice.id)).size, 2);
  assert.deepEqual(fresh.tempos, []);
  assert.deepEqual(fresh.lengths, []);
  $("addVoice").click();
  const thirdName = d.querySelectorAll(".voice-head input")[2];
  thirdName.value = "人声部"; thirdName.dispatchEvent(new w.Event("input", { bubbles: true }));
  const thirdSource = d.querySelectorAll("textarea")[2];
  thirdSource.value = "1==="; thirdSource.dispatchEvent(new w.Event("input", { bubbles: true }));
  const originalIds = JSON.parse(w.localStorage.getItem("score-studio.project.v1")).voices.map(v => v.id);
  d.querySelectorAll(".voice-card")[2].querySelectorAll(".move-voice")[0].click();
  d.querySelectorAll(".voice-card")[1].querySelectorAll(".move-voice")[0].click();
  assert.deepEqual([...d.querySelectorAll(".voice-head input")].map(input => input.value), ["人声部", "高声部", "低声部"]);
  assert.equal(d.querySelector("textarea").value, "1===");
  assert.equal(d.querySelector(".move-voice").disabled, true);
  assert.equal(d.querySelectorAll(".voice-card")[2].querySelectorAll(".move-voice")[1].disabled, true);
  const reordered = JSON.parse(w.localStorage.getItem("score-studio.project.v1"));
  assert.deepEqual(reordered.voices.slice(1).map(v => v.id), originalIds.slice(0, 2));
  assert.equal(reordered.voices[0].id, originalIds[2]);
  assert.equal(d.querySelector(".system-label").textContent, "人声部");
  $("openExport").click();
  assert.deepEqual([...$("exportVoices").querySelectorAll("label")].map(label => label.textContent), ["人声部", "高声部", "低声部"]);
  $("exportDialog").close();
  d.querySelector(".voice-card").querySelectorAll(".move-voice")[1].click();
  assert.deepEqual([...d.querySelectorAll(".voice-head input")].map(input => input.value), ["高声部", "人声部", "低声部"]);
  assert.equal(d.querySelectorAll("textarea")[1].value, "1===");
  assert.deepEqual(errors, []);
  dom.window.close();
});
test("scoped settings UI edits ranges, restores score marks and preserves project data", async t => {
  const dom = new JSDOM(fs.readFileSync(`${__dirname}/index.html`, "utf8"), {
    url: "https://score-studio.test/", runScripts: "outside-only", pretendToBeVisual: true
  });
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document, $ = id => d.getElementById(id), errors = [];
  w.addEventListener("error", e => errors.push(e.message));
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  w.localStorage.setItem("score-studio.project.v1", JSON.stringify({
    version: 1, title: "范围测试", bpm: 74, meter: "4/4", gap: 40,
    keys: ["ZXCVBNM", "ASDFGHJ", "QWERTYU"],
    voices: [{ id: "v", name: "声部", source: "1===|1=|1=|1=|1===" }],
    tempos: [{ bar: 3, bpm: 68, scope: "single" }],
    lengths: [{ bar: 2, endBar: 4, meter: "2/4", scope: "range" }]
  }));
  w.eval(fs.readFileSync(`${__dirname}/core.js`, "utf8")); w.eval(fs.readFileSync(`${__dirname}/app.js`, "utf8"));
  assert.equal($("compileBadge").textContent, "✓ 实时编译");
  assert.deepEqual([...d.querySelectorAll(".tempo")].map(e => e.textContent), ["♩=74", "♩=68", "♩=74"]);
  assert.equal(d.querySelectorAll(".meter-mark").length, 0);
  assert.deepEqual([...d.querySelectorAll(".special")].map(e => e.textContent), ["2 拍", "2 拍", "2 拍"]);
  $("settingsButton").click();
  assert.equal(d.querySelector('#tempoRows select').value, "single");
  assert.equal(d.querySelector('#lengthRows select').value, "range");
  assert.equal(d.querySelector('#lengthRows input[aria-label$="结束小节"]').value, "4");
  const scope = d.querySelector("#tempoRows select");
  scope.value = "range"; scope.dispatchEvent(new w.Event("change", { bubbles: true }));
  const end = d.querySelector('#tempoRows input[aria-label$="结束小节"]');
  assert.equal(end.disabled, false);
  end.value = "4"; end.dispatchEvent(new w.Event("input", { bubbles: true }));
  $("settingsDone").click();
  assert.deepEqual([...d.querySelectorAll(".tempo")].map(e => e.textContent), ["♩=74", "♩=68", "♩=74"]);
  assert.equal(d.querySelectorAll(".measure-meta")[4].querySelector(".tempo").textContent, "♩=74");
  $("settingsButton").click();
  $("addTempo").click();
  assert.equal(d.querySelectorAll("#tempoRows select")[1].value, "onward");
  const invalidEnd = d.querySelector('#tempoRows input[aria-label$="结束小节"]');
  invalidEnd.value = "1"; invalidEnd.dispatchEvent(new w.Event("input", { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok($("settingsStatus").textContent.includes("范围结束小节"));
  invalidEnd.value = "4"; invalidEnd.dispatchEvent(new w.Event("input", { bubbles: true }));
  $("settingsDone").click();
  const saved = JSON.parse(w.localStorage.getItem("score-studio.project.v1"));
  assert.equal(saved.tempos[0].endBar, 4);
  assert.equal(saved.tempos[0].scope, "range");
  assert.equal(saved.lengths[0].meter, "2/4");
  $("settingsButton").click();
  const second = d.querySelectorAll("#tempoRows .rule-row")[1];
  const start = second.querySelector('input[aria-label$="起始小节"]'), secondScope = second.querySelector("select");
  start.value = "6"; start.dispatchEvent(new w.Event("input", { bubbles: true }));
  secondScope.value = "range"; secondScope.dispatchEvent(new w.Event("change", { bubbles: true }));
  assert.equal(second.querySelector('input[aria-label$="结束小节"]').value, "6");
  assert.equal($("settingsStatus").textContent, "");
  assert.deepEqual(errors, []);
});
test("voice measure counters use each source independently and track the editing cursor", async t => {
  const dom = new JSDOM(fs.readFileSync(`${__dirname}/index.html`, "utf8"), {
    url: "https://score-studio.test/", runScripts: "outside-only", pretendToBeVisual: true
  });
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document;
  w.localStorage.setItem("score-studio.project.v1", JSON.stringify({
    version: 1, title: "声部定位", bpm: 74, meter: "4/4", gap: 40, keys: ["ZXCVBNM", "ASDFGHJ", "QWERTYU"],
    tempos: [], lengths: [], voices: [
      { id: "low", name: "低声部", source: Array(60).fill("1===").join(" | ") },
      { id: "high", name: "高声部", source: "1=== | 2=== | 3===" }
    ]
  }));
  w.eval(fs.readFileSync(`${__dirname}/core.js`, "utf8")); w.eval(fs.readFileSync(`${__dirname}/app.js`, "utf8"));
  const inputs = d.querySelectorAll("textarea"), counters = d.querySelectorAll(".voice-count");
  assert.ok(counters[0].textContent.startsWith("60 小节"));
  assert.ok(counters[1].textContent.startsWith("3 小节"));
  inputs[1].setSelectionRange(9, 9);
  inputs[1].dispatchEvent(new w.Event("keyup"));
  assert.equal(counters[1].textContent, "3 小节 · 当前第 2 小节");
  inputs[1].value += " | ";
  inputs[1].setSelectionRange(inputs[1].value.length, inputs[1].value.length);
  inputs[1].dispatchEvent(new w.Event("input", { bubbles: true }));
  assert.equal(counters[1].textContent, "3 小节 · 当前第 4 小节");
  inputs[1].value = " | 1=== | 2=== |";
  inputs[1].setSelectionRange(4, 4);
  inputs[1].dispatchEvent(new w.Event("input", { bubbles: true }));
  assert.equal(counters[1].textContent, "2 小节 · 当前第 1 小节");
  inputs[1].setSelectionRange(11, 11);
  inputs[1].dispatchEvent(new w.Event("select"));
  assert.equal(counters[1].textContent, "2 小节 · 当前第 2 小节");
  inputs[1].value = "";
  inputs[1].dispatchEvent(new w.Event("input", { bubbles: true }));
  assert.equal(counters[1].textContent, "0 小节 · 当前第 1 小节");
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(counters[0].textContent.startsWith("60 小节"));
  assert.equal(counters[1].textContent, "0 小节 · 当前第 1 小节");
});
test("parallel measures expand in the score without creating permanent voices", async t => {
  const dom = new JSDOM(fs.readFileSync(`${__dirname}/index.html`, "utf8"), {
    url: "https://score-studio.test/", runScripts: "outside-only", pretendToBeVisual: true
  });
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document, errors = [];
  w.addEventListener("error", e => errors.push(e.message));
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  w.localStorage.setItem("score-studio.project.v1", JSON.stringify({
    version: 1, title: "临时分支", bpm: 120, meter: "4/4", gap: 40, keys: ["ZXCVBNM", "ASDFGHJ", "QWERTYU"],
    tempos: [], lengths: [], voices: [{ id: "v", name: "混音", source: "1=== | { 1= ~1= & (4050<40>50) 0== } | ~1===" }]
  }));
  w.eval(fs.readFileSync(`${__dirname}/core.js`, "utf8")); w.eval(fs.readFileSync(`${__dirname}/app.js`, "utf8"));
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(d.getElementById("compileBadge").textContent, "✓ 实时编译");
  assert.equal(d.querySelectorAll(".voice-card").length, 1);
  assert.equal(d.querySelectorAll(".measure").length, 3);
  assert.deepEqual([...d.querySelectorAll(".voice-measure")].map(e => e.querySelectorAll(".staff-bar").length), [1, 2, 1]);
  assert.equal(d.querySelectorAll(".branch-label").length, 2);
  assert.equal(d.querySelectorAll(".grace-notes").length, 1);
  assert.equal(d.querySelectorAll(".tie-layer path").length > 0, true);
  assert.equal(d.querySelectorAll(".beam-layer line").length, 1);
  d.querySelector(".auto-bars").click();
  assert.ok(d.querySelector("textarea").value.includes(" & "));
  d.getElementById("openExport").click();
  assert.equal(d.querySelectorAll("#exportVoices input").length, 1);
  assert.equal(d.getElementById("downloadAhk").disabled, false);
  d.querySelector('input[name="mode"][value="hold"]').click();
  assert.equal(d.getElementById("downloadAhk").disabled, false);
  assert.deepEqual(errors, []);
});
