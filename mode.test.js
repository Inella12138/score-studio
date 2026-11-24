"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), C = require("./core");
const fs = require("node:fs"), { JSDOM } = require("./.test-runtime/node_modules/jsdom");
const project = (source, modes) => ({version:1,title:"模式切换",bpm:120,meter:"4/4",gap:40,keys:C.DEFAULT_KEYS.slice(),tempos:[],lengths:[],modes,voices:[{id:"v",name:"A",source}]});
const plan = (p, mode="tap") => C.makeEvents(p,C.compile(p),["v"],mode);
test("range and single mode exceptions restore default without shifting timing", () => {
  const p=project("1===|2===|3===|4===",[{bar:2,endBar:3,scope:"range",mode:"hold"}]);
  assert.deepEqual(plan(p).events,[{t:0,type:"tap",keys:"a"},{t:2000,type:"down",keys:"s"},{t:4000,type:"up",keys:"s"},{t:4000,type:"down",keys:"d"},{t:6000,type:"up",keys:"d"},{t:6000,type:"tap",keys:"f"}]);
  assert.equal(plan(p).totalMs,8000);
  p.modes=[{bar:2,scope:"onward",mode:"hold"},{bar:3,scope:"single",mode:"tap"}];
  assert.deepEqual(plan(p).events.filter(e=>e.type==="down").map(e=>e.keys),["s","f"]);
});
test("mode boundary releases and restarts ties while unchanged mode preserves ties", () => {
  const p=project("1===|~1===|~1===",[{bar:2,scope:"single",mode:"tap"}]);
  assert.deepEqual(plan(p,"hold").events,[{t:0,type:"down",keys:"a"},{t:2000,type:"up",keys:"a"},{t:2000,type:"tap",keys:"a"},{t:4000,type:"down",keys:"a"},{t:6000,type:"up",keys:"a"}]);
  assert.deepEqual(plan(p).events,[{t:0,type:"tap",keys:"a"}]);
});
test("ornaments and conflicts use the mode of each bar, invalid rules block export", () => {
  const p=project("2'===|[531];===",[{bar:2,scope:"single",mode:"hold"}]);
  const r=plan(p); assert.equal(r.errors.length,0);assert.equal(r.warnings.length,1);
  assert.deepEqual(r.events.slice(-2),[{t:2000,type:"down",keys:"a"},{t:4000,type:"up",keys:"a"}]);
  p.voices[0].source="{1=== & 1===}|{1=== & 1===}";
  assert.ok(plan(p).errors.length);assert.ok(plan(p).errors.every(e=>e.bar===1));
  p.modes=[{bar:1,mode:"invalid"}];assert.ok(plan(p).errors.length);
});
test("export dialog creates editable persisted mode rules and exposes hold parameters", t => {
  const dom=new JSDOM(fs.readFileSync(`${__dirname}/index.html`,"utf8"),{url:"https://score.test/",runScripts:"outside-only",pretendToBeVisual:true});
  t.after(()=>dom.window.close());const w=dom.window,d=w.document,$=id=>d.getElementById(id);
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  w.HTMLDialogElement.prototype.close=function(){this.open=false;};
  w.localStorage.setItem("score-studio.project.v1",JSON.stringify(project("1===|2===",[])));
  w.eval(fs.readFileSync(`${__dirname}/core.js`,"utf8"));w.eval(fs.readFileSync(`${__dirname}/app.js`,"utf8"));
  $("openExport").click();$("addMode").click();
  assert.equal($("holdSettings").hidden,false);assert.equal($("downloadAhk").disabled,false);
  const scope=$("modeRows").querySelector("select");scope.value="range";scope.dispatchEvent(new w.Event("change"));
  const end=$("modeRows").querySelector('input[aria-label$="结束小节（含）"]');end.value="2";end.dispatchEvent(new w.Event("input"));
  const saved=JSON.parse(w.localStorage.getItem("score-studio.project.v1"));
  assert.deepEqual(saved.modes,[{bar:1,scope:"range",mode:"hold",endBar:2}]);
  $("previewCode").click();assert.ok($("codePreview").textContent.includes('[0, "down", "a"]'));
  end.value="0";end.dispatchEvent(new w.Event("input"));assert.equal($("downloadAhk").disabled,true);
});
