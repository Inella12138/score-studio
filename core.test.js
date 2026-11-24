"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const C = require("./core");
function project(sources, extra = {}) {
  return { version: 1, title: "测试", bpm: 120, meter: "4/4", gap: 40, keys: C.DEFAULT_KEYS.slice(),
    tempos: [], lengths: [], voices: sources.map((source, i) => ({ id: String(i), name: `声部${i}`, source })), ...extra };
}
const build = (p, mode = "tap", selected = p.voices.map(v => v.id)) => C.makeEvents(p, C.compile(p), selected, mode);
test("whole-measure parallel branches match independent voices without shifting later bars", () => {
  const source = "1 2 3 4 | { 1= 3= & 19 59 39 59 } | 5 6 7 1";
  const p = project([source]), c = C.compile(p);
  assert.equal(c.errors.length, 0);
  assert.deepEqual(c.voices[0].branchBars.map(b => b.length), [1, 2, 1]);
  assert.equal(c.totalBeats, 12); assert.equal(c.totalMs, 6000);
  const independent = project(["1 2 3 4|1= 3=|5 6 7 1", "0===|19 59 39 59|0==="]);
  for (const mode of ["tap", "hold"]) assert.deepEqual(build(p, mode).events, build(independent, mode).events);
  const formatted = C.autoBars(p, source);
  assert.equal(formatted.count, 3); assert.equal(formatted.missing, 0);
  assert.deepEqual(build(project([formatted.source])).events, build(p).events);
});
test("parallel branches independently validate beats and held-key conflicts", () => {
  const mismatch = C.compile(project(["{ 1= & 19=== }"]));
  assert.ok(mismatch.errors.some(e => e.message.includes("分支 1") && e.message.includes("缺少")));
  const conflict = project(["{ 1=== & 0 1 0= }"]);
  assert.equal(build(conflict).errors.length, 0);
  assert.ok(build(conflict, "hold").errors.some(e => e.message.includes("冲突")));
  for (const source of ["{1=== & }", "1 {2=== & 3===}", "{{1=== & 2===} & 3===}", "{1=== & 2===} 3", "{1=== & 2===}-"]) {
    assert.ok(C.compile(project([source])).errors.length, source);
    assert.throws(() => C.autoBars(project([source]), source), source);
  }
});
test("parallel branches retain tuplets, ornaments, duration groups and lane-local ties", () => {
  const source = "{ 1= ~1= & (405060) <50>60 {40506070}- } | { ~1=== & [193959];=== } | ~1===";
  const p = project([source]), c = C.compile(p);
  assert.equal(c.errors.length, 0);
  assert.equal(build(p).errors.length, 0);
  assert.equal(build(p, "hold").errors.length, 0);
  const a = c.voices[0].branchBars[0][0][0];
  assert.equal(a.sustainEnd, 12);
  assert.equal(c.voices[0].branchBars[0][1][0].tieFrom, undefined);
  const formatted = C.autoBars(p, source).source;
  assert.equal(C.compile(project([formatted])).errors.length, 0);
  assert.deepEqual(build(project([formatted])).events, build(p).events);
  assert.equal(C.autoBars(p, formatted).source, formatted);
  const invalid = C.compile(project(["1=== | { ~1=== & ~1=== }"]));
  assert.ok(invalid.errors.some(e => e.message.includes("延音")));
});
test("parallel automatic bars honor special lengths and reject a partial preceding bar", () => {
  const p = project(["{1= & 19=}|2==="], { lengths: [{ bar: 1, meter: "2/4" }] });
  assert.equal(C.compile(p).errors.length, 0);
  assert.equal(C.autoBars(p, p.voices[0].source).count, 2);
  assert.throws(() => C.autoBars(project(["0==="]), "1 | {2=== & 3===}"), /尚未填满/);
  const start = project(["{1=== & 19===}"]);
  assert.equal(build(start).events[0].keys, "az");
});
test("breaths on a parallel measure boundary normalize into its continuing first branch", () => {
  const b = String.fromCharCode(96), source = `{1=== & 19===} | ${b}2===`;
  const p = project([source]), c = C.compile(p);
  assert.equal(c.errors.length, 0);
  assert.equal(c.voices[0].branchBars[0][0][0].breath, true);
  assert.equal(c.voices[0].branchBars[0][1][0].breath, false);
  const events = build(p, "hold").events;
  assert.ok(events.some(e => e.t === 1970 && e.type === "up" && e.keys === "a"));
  assert.ok(events.some(e => e.t === 2000 && e.type === "up" && e.keys === "z"));
  const output = C.autoBars(p, source).source;
  assert.ok(output.includes(`1===${b} &`));
  assert.deepEqual(build(project([output]), "hold").events, events);
  assert.equal(C.autoBars(p, output).source, output);
});
test("breaths normalize across bar lines and duration groups without changing timing", () => {
  const b = String.fromCharCode(96);
  for (const [source, normalized] of [
    [`1=== | ${b}2===`, `1===${b} | 2===`],
    [`1=== | ${b}{23456712}-`, `1===${b} | {23456712}-`],
    [`{12345671}- | ${b}2===`, `{12345671}-${b} | 2===`],
    [`1- ${b}{2345671}-`, `1-${b} {2345671}-`],
    [`{1234}-- ${b}2 3 4`, `{1234}--${b} 2 3 4`]
  ]) {
    const p = project([source]), q = project([normalized]);
    assert.equal(C.compile(p).errors.length, 0, source);
    assert.equal(C.compile(q).errors.length, 0, normalized);
    assert.deepEqual(build(p, "hold").events, build(q, "hold").events);
    const output = C.autoBars(p, source).source;
    assert.equal(C.compile(project([output])).errors.length, 0, output);
    assert.deepEqual(build(project([output]), "hold").events, build(p, "hold").events);
    assert.equal(C.autoBars(p, output).source, output);
    assert.ok(!output.includes(`|\n${b}`));
  }
});
test("breath before a following note normalizes to the previous note during automatic bars", () => {
  const mark = String.fromCharCode(96);
  const source = `0 0 0 0 | 0 0 0 0 | 3- 1-- 5-- ~5- 6-- 4-- ~4 0- 2-- 3-- | 4 ~4- ${mark}3-- 2-- 3=`;
  const p = project([source]);
  assert.equal(C.compile(p).errors.length, 0);
  const normalized = source.replace(`${mark}3--`, `3--`).replace("~4- 3--", `~4-${mark} 3--`);
  assert.deepEqual(build(p, "hold").events, build(project([normalized]), "hold").events);
  const output = C.autoBars(p, source).source;
  assert.ok(output.includes(`~4-${mark} 3--`));
  assert.equal(C.compile(project([output])).errors.length, 0);
  assert.deepEqual(build(project([output]), "hold").events, build(p, "hold").events);
  assert.equal(C.autoBars(p, output).source, output);
  assert.equal(C.parseBar(`1 ${mark}[135] 0=`)[0].breath, true);
  assert.throws(() => C.parseBar(`${mark}1`));
});
test("breath marks shorten held notes even before different pitches and survive formatting", () => {
  const mark = String.fromCharCode(96);
  const p = project([`1${mark} 2 0=`]);
  assert.ok(build(p, "hold").events.some(e => e.type === "up" && e.keys === "a" && e.t === 470));
  assert.deepEqual(build(p).events, build(project(["1 2 0="])).events);
  const tied = project([`1 ~1${mark} 2 0`]);
  assert.ok(build(tied, "hold").events.some(e => e.type === "up" && e.keys === "a" && e.t === 970));
  assert.ok(C.compile(project([`1${mark} ~1 0=`])).errors.length);
  const group = C.parseBar(`(123)${mark}`);
  assert.deepEqual(group.map(n => n.breath), [false, false, true]);
  const source = `0== 1=${mark} 0==`;
  const formatted = C.autoBars(project([source]), source).source;
  assert.equal((formatted.match(/`/g) || []).length, 1);
  const notes = formatted.split("|").flatMap(s => C.parseBar(s));
  assert.equal(notes.filter(n => n.breath).length, 1);
  assert.ok(notes.find(n => n.breath).tie);
  assert.throws(() => C.parseBar(`1${mark}${mark}`));
});
test("repeat separation respects configurable minimum hold, ties and per-key chord releases", () => {
  const p = project(["1 1 0="], { repeatGapMs: 200, minHoldPercent: 80 });
  assert.ok(build(p, "hold").events.some(e => e.type === "up" && e.keys === "a" && e.t === 400));
  assert.equal(build(p, "hold").totalMs, 2000);
  assert.ok(build({ ...p, minHoldPercent: 90 }, "hold").events.some(e => e.type === "up" && e.t === 450));
  assert.ok(build({ ...p, repeatGapMs: 15 }, "hold").events.some(e => e.type === "up" && e.t === 485));
  for (const settings of [{ repeatGapMs: 0 }, { minHoldPercent: 100 }]) {
    const events = build({ ...p, ...settings }, "hold").events;
    assert.deepEqual(events.filter(e => e.t === 500).map(e => e.type), ["up", "down"]);
  }
  const tied = build(project(["1 ~1 0="]), "hold");
  assert.deepEqual(tied.events, [{ t: 0, type: "down", keys: "a" }, { t: 1000, type: "up", keys: "a" }]);
  const chord = build(project(["[135] [146] 0="]), "hold").events;
  assert.ok(chord.some(e => e.t === 470 && e.keys === "a" && e.type === "up"));
  assert.ok(chord.some(e => e.t === 500 && e.keys === "dg" && e.type === "up"));
  for (const settings of [{ repeatGapMs: -1 }, { minHoldPercent: 0 }, { minHoldPercent: 101 }, { repeatGapMs: Infinity }])
    assert.ok(build({ ...p, ...settings }, "hold").errors.length);
  assert.deepEqual(build(p).events, build({ ...p, repeatGapMs: 0 }).events);
});
test("octaves, halving, extensions, dots, chords and triplets", () => {
  assert.deepEqual(C.parseBar("19 1 10").map(n => n.pitches[0].octave), [0, 1, 2]);
  assert.deepEqual(C.parseBar("1 1- 1-- 1= 1== 1. 1-.").map(n => n.duration), [1, .5, .25, 2, 3, 1.5, .75]);
  assert.equal(C.parseBar("[193959]")[0].pitches.length, 3);
  assert.equal(C.parseBar("(123)=").reduce((n, v) => n + v.duration, 0), 2);
  assert.throws(() => C.parseBar("(12)"));
  assert.throws(() => C.parseBar("#4"));
  assert.throws(() => C.parseBar("[11]"));
});
test("bar lengths are global and missing bars are errors", () => {
  const p = project(["1= | 1===", "0= | 0==="], { lengths: [{ bar: 1, beats: 2 }] });
  assert.equal(C.compile(p).errors.length, 0);
  p.voices[1].source = "0===";
  assert.equal(C.compile(p).errors.length, 2);
});
test("tempo changes and selected voice preserve initial rests", () => {
  const p = project(["1=== | 1===", "0=== | 5==="], { tempos: [{ bar: 2, bpm: 60 }] });
  const c = C.compile(p);
  assert.equal(c.totalMs, 6000);
  assert.equal(c.timeAt(5), 3000);
  assert.equal(build(p, "tap", ["1"]).events[0].t, 2000);
});
test("ties sustain across tempo changes and never retrigger", () => {
  const p = project(["1=== | ~1==="], { tempos: [{ bar: 2, bpm: 60 }] });
  assert.deepEqual(build(p).events, [{ t: 0, type: "tap", keys: "a" }]);
  assert.deepEqual(build(p, "hold").events, [{ t: 0, type: "down", keys: "a" }, { t: 6000, type: "up", keys: "a" }]);
  assert.ok(C.compile(project(["1=== | ~2==="])).errors.length);
  assert.equal(build(project(["[135]=== | ~[531]==="]), "hold").errors.length, 0);
});
test("ornaments remain within duration; hold keeps principal or final note", () => {
  const p = project(["2' 0 [531]; 0"]);
  assert.deepEqual(build(p).events.slice(0, 3).map(e => e.t), [0, 40, 80]);
  assert.deepEqual(build(p, "hold").events.map(e => e.keys), ["s", "s", "a", "a"]);
  assert.equal(build(p, "hold").warnings.length, 2);
  assert.ok(build(project(["2'(300) 0 0 0"])).errors.length);
  assert.equal(build(project(["2'(300) 0 0 0"]), "hold").errors.length, 0);
  assert.ok(build(project(["70' 0 0 0"])).errors.length);
  assert.equal(build(project(["70' 0 0 0"]), "hold").errors.length, 0);
});
test("held key conflicts only apply to selected voices; boundaries release before down", () => {
  const p = project(["1=== ", "0 1 0 0"]);
  assert.ok(build(p, "hold").errors.some(e => e.message.includes("冲突")));
  assert.equal(build(p, "hold", ["0"]).errors.length, 0);
  const e = build(project(["1 1 0 0"]), "hold").events;
  assert.deepEqual(e.filter(x => x.t === 500).map(x => x.type), ["down"]);
  assert.ok(e.some(x => x.t === 470 && x.type === "up"));
});
test("simultaneous tapped keys merge and rest-only songs preserve duration", () => {
  assert.deepEqual(build(project(["1===", "1==="])).events, [{ t: 0, type: "tap", keys: "a" }]);
  const rest = build(project(["0==="]));
  assert.equal(rest.events.length, 0); assert.equal(rest.totalMs, 2000);
});
test("input validation rejects duplicate keys, invalid settings, malformed syntax", () => {
  for (const source of ["[1", "(123", "1-=", "0'", "~0", "[10]", "1'(0)", "1...(40)"]) {
    if (source === "[10]") continue;
    assert.throws(() => C.parseBar(source), source);
  }
  assert.ok(C.compile(project(["1==="], { keys: ["AAAAAAA", "ASDFGHJ", "QWERTYU"] })).errors.length);
  assert.ok(C.compile(project(["1==="], { tempos: [{ bar: 1, bpm: 60 }, { bar: 1, bpm: 80 }] })).errors.length);
  assert.equal(C.fraction("3/2"), 1.5);
  assert.throws(() => C.fraction("1/0"));
  assert.ok(C.compile(project(["2==="], { keys: [["ZXCVBNM"], ["ASDFGHJ"], ["QWERTYU"]] })).errors.length);
});
test("sub-millisecond hold duration never quantizes into up before down", () => {
  const source = ["0--------", "1--------", ...Array(254).fill("0--------")].join(" ");
  const p = project([source], { bpm: 400, meter: "1/4" });
  const plan = build(p, "hold");
  assert.equal(plan.errors.length, 0);
  assert.equal(plan.events[0].type, "down");
  assert.equal(plan.events[1].type, "up");
  assert.ok(plan.events[1].t > plan.events[0].t);
});
test("AHK output includes cleanup, clock scheduling, pause and absolute event timings", () => {
  const p = project(["[135]==="]), output = C.ahk(p, build(p, "hold"), { schedule: "20261029203000" });
  for (const text of ["#Requires AutoHotkey v2.0", "QueryPerformanceCounter", "OnExit ReleaseOnExit", 'ScheduledTime := "20261029203000"', '[2000, "up", "adg"]', "^#Esc::StopPlayback()"]) assert.ok(output.includes(text), text);
  assert.ok(output.includes("if !A_IsAdmin"));
  assert.ok(output.includes("Run '*RunAs"));
  for (const text of ["^#t::OpenSchedulePanel()", "SchedulePicker.Value := A_Now", "SetScheduleOffset.Bind(30)", "SetScheduleOffset.Bind(60)", "SetScheduleOffset.Bind(300)", "DateAdd(A_Now, seconds", "if target <= A_Now", "SchedulePanel.Hide()", "RefreshScheduleStatus()"])
    assert.ok(output.includes(text), text);
  for (const text of ["BuildScheduleNodeTimes(now)", "5 - Mod(seconds, 5)", "Loop 24", "SelectScheduleNode.Bind(A_Index)", "SchedulePicker.Value := target", "SetTimer RefreshScheduleNodes, 1000", "SetTimer RefreshScheduleNodes, 0"])
    assert.ok(output.includes(text), text);
  assert.ok(output.includes("StartDelayMs := 3000"));
  assert.ok(output.includes("StartPlayback(true)"));
  assert.ok(output.includes("scheduled ? 0 : StartDelayMs"));
  assert.ok(C.ahk(p, build(p), { startDelay: 1.5 }).includes("StartDelayMs := 1500"));
  assert.throws(() => C.ahk(p, build(p), { startDelay: -1 }));
  assert.throws(() => C.ahk(p, build(p), { schedule: 'bad"' }));
});
test("shared duration groups are equivalent to explicit suffixes, including chords and octaves", () => {
  const compact = project(["{12345671}- | {[193959] 5 10 0}-- 0=="]);
  const expanded = project(["1- 2- 3- 4- 5- 6- 7- 1- | [193959]-- 5-- 10-- 0-- 0=="]);
  assert.equal(build(compact).errors.length, 0);
  assert.deepEqual(build(compact).events, build(expanded).events);
  assert.deepEqual(build(compact, "hold").events, build(expanded, "hold").events);
  assert.equal(C.parseBar("{1 2-}--")[1].duration, 1 / 8);
  assert.equal(C.parseBar("{1=}--")[0].duration, .5);
  for (const [source, duration, dots, halves] of [["{1==}-", 1.5, 1, 0], ["{1==}--", .75, 1, 1]]) {
    const n = C.parseBar(source)[0];
    assert.equal(n.duration, duration); assert.equal(n.dots, dots); assert.equal(n.halves, halves);
  }
  assert.equal(C.parseBar("{1====}---")[0].exactDuration, .625);
  assert.equal(C.parseBar("{(123)}-").reduce((n, v) => n + v.duration, 0), .5);
  for (const source of ["{123", "{}-", "{123}", "{1}---------", "{1--------}-", "{{{{{1}-}-}-}-}-"]) {
    assert.throws(() => C.parseBar(source), source);
  }
});
test("grace notes occupy principal duration and simplify to principal in hold mode", () => {
  const p = project(["<2>3 5 0="]);
  const tap = build(p);
  assert.equal(tap.errors.length, 0);
  assert.deepEqual(tap.events, [{ t: 0, type: "tap", keys: "s" }, { t: 40, type: "tap", keys: "d" }, { t: 500, type: "tap", keys: "g" }]);
  assert.deepEqual(build(p, "hold").events.slice(0, 2), [{ t: 0, type: "down", keys: "d" }, { t: 500, type: "up", keys: "d" }]);
  assert.ok(build(p, "hold").warnings[0].message.includes("主音"));
  const multi = build(project(["<1929>(25)[135] 0=="]));
  assert.deepEqual(multi.events.slice(0, 3).map(e => [e.t, e.keys]), [[0, "z"], [25, "x"], [50, "adg"]]);
  assert.ok(build(project(["<2>(500)3 0=="])).errors.length);
  assert.equal(build(project(["<2>(500)3 0=="]), "hold").errors.length, 0);
  const tied = build(project(["<2>3=== | ~3==="]));
  assert.equal(tied.events.length, 2);
  // A tie must not make additional room for ornaments in the principal's own slot.
  assert.ok(build(project(["<2>(600)3 ~3 0="])).errors.length);
  for (const source of ["<>3", "<0>3", "<2", "<2>0", "<2>(0)3", "<2>3'", "<2>(123)", "~<2>3"]) {
    assert.throws(() => C.parseBar(source), source);
  }
});
test("beaming follows metric beats, respects rests, mixed subdivisions and compound meter", () => {
  const p = project(["{12345671}- | {1234}-- {5671}-- 0= | 1-. 2-- 3- 4- 0="]);
  const c = C.compile(p);
  assert.equal(c.errors.length, 0);
  assert.deepEqual(C.beamGroups(c.voices[0].bars[0], c.bars[0], p.meter), [[0, 1], [2, 3], [4, 5], [6, 7]]);
  assert.deepEqual(C.beamGroups(c.voices[0].bars[1], c.bars[1], p.meter), [[0, 1, 2, 3], [4, 5, 6, 7]]);
  assert.deepEqual(C.beamGroups(c.voices[0].bars[2], c.bars[2], p.meter), [[0, 1], [2, 3]]);
  assert.equal(C.beamDepth(c.voices[0].bars[2][0]), 1);
  assert.equal(C.beamDepth(c.voices[0].bars[2][1]), 2);
  const rest = C.compile(project(["1- 0- 2- 3- 0="]));
  assert.deepEqual(C.beamGroups(rest.voices[0].bars[0], rest.bars[0], "4/4"), [[2, 3]]);
  const compound = C.compile(project(["{123456}-"], { meter: "6/8" }));
  assert.deepEqual(C.beamGroups(compound.voices[0].bars[0], compound.bars[0], "6/8"), [[0, 1, 2], [3, 4, 5]]);
});
test("automatic bars use meter and special lengths and preserve compact short-note groups", () => {
  const p = project(["0==="]);
  const result = C.autoBars(p, "12345671");
  assert.equal(result.source, "1 2 3 4 |\n5 6 7 1");
  assert.equal(result.count, 2); assert.equal(result.missing, 0);
  assert.equal(C.autoBars(p, "1|2|3|4").source, "1 2 3 4");
  const grouped = C.autoBars(p, "{1234567112345671}-");
  assert.equal(grouped.count, 2);
  assert.ok(grouped.source.includes("{1 2 3 4 5 6 7 1}-"));
  assert.equal(C.compile(project([grouped.source])).errors.length, 0);
  const special = project(["0==="], { lengths: [{ bar: 1, beats: 2 }] });
  assert.equal(C.autoBars(special, "123456").source, "1 2 |\n3 4 5 6");
  assert.equal(C.autoBars(project(["0=="], { meter: "6/8" }), "{123456123456}-").count, 2);
  assert.equal(C.autoBars(p, "12345").missing, 3);
});
test("automatic bar splitting preserves sustained notes and rests without retriggering", () => {
  const p = project(["0==="]);
  const result = C.autoBars(p, "0== [135]==== 0====");
  assert.equal(result.splits, 2);
  const output = project([result.source]);
  assert.equal(C.compile(output).errors.length, 1); // final bar is intentionally incomplete
  const completed = project([result.source + " 0=="]);
  assert.equal(C.compile(completed).errors.length, 0);
  assert.deepEqual(build(completed).events, [{ t: 1500, type: "tap", keys: "adg" }]);
  assert.deepEqual(build(completed, "hold").events, [{ t: 1500, type: "down", keys: "adg" }, { t: 4000, type: "up", keys: "adg" }]);
  const dotted = C.autoBars(p, "0== 1.");
  assert.equal(dotted.source, "0== 1 |\n~1-");
});
test("automatic bars keep tuplets and ornaments intact or reject crossing without modifying source", () => {
  const p = project(["0==="]);
  const source = "(123) <2>(30)3 [531]; 2'";
  const result = C.autoBars(p, source);
  assert.equal(C.compile(project([result.source])).errors.length, 0);
  assert.deepEqual(build(project([result.source])).events, build(project([source])).events);
  for (const text of ["0== 1- (123)", "0== 1- <2>3", "0== 1- [531];", "0== 1- 2'", "{123", ""]) {
    assert.throws(() => C.autoBars(p, text), text);
  }
});
test("automatic bars format chord pitches without changing order, timing or ornaments", () => {
  const p = project(["0==="]);
  for (const source of [
    "[692919]=== ", "[692919];(35) 0==", "{[692919] [135] 2 3}- 0=",
    "([692919][135]2) 0==", "<2>[692919] 0==", "[692919]=== ~[692919]===",
    "0== [692919]===="
  ]) {
    const result = C.autoBars(p, source);
    assert.ok(result.source.includes("[69 29 19]"));
    assert.equal(C.autoBars(p, result.source).source, result.source);
    const a = C.parseBar(source), b = result.source.split("|").flatMap(text => C.parseBar(text));
    assert.ok(Math.abs(a.reduce((sum, n) => sum + n.duration, 0) - b.reduce((sum, n) => sum + n.duration, 0)) < 1e-7);
    assert.deepEqual(b.find(n => n.pitches.length === 3).pitches, a.find(n => n.pitches.length === 3).pitches);
  }
  const source = "[692919];(35) 0==";
  const output = C.autoBars(p, source).source;
  assert.deepEqual(build(project([output])).events, build(project([source])).events);
});
test("tempo rules support single bars, inclusive ranges, onward changes and restoration", () => {
  const p = project(Array(1).fill(Array(8).fill("1===").join("|")), {
    tempos: [
      { bar: 2, bpm: 90, scope: "onward" },
      { bar: 3, endBar: 5, bpm: 68, scope: "range" },
      { bar: 4, bpm: 55, scope: "single" },
      { bar: 5, bpm: 80, scope: "onward" },
      { bar: 7, bpm: 68, scope: "single" }
    ]
  });
  const c = C.compile(p);
  assert.equal(c.errors.length, 0);
  assert.deepEqual(c.bars.map(b => b.bpm), [120, 90, 68, 55, 68, 80, 68, 80]);
  assert.deepEqual(c.bars.map(b => b.tempoChange), Array(8).fill(true));
  assert.ok(Math.abs(c.totalMs - c.bars.reduce((s, b) => s + 240000 / b.bpm, 0)) < 1e-6);
  const same = C.compile(project(["1===|1===|1==="], { tempos: [{ bar: 2, scope: "single", bpm: 120 }] }));
  assert.deepEqual(same.bars.map(b => b.tempoChange), [true, false, false]);
});
test("meter ranges control durations, restoration, automatic bars and beat grouping", () => {
  const p = project(["1===|1=|1=|1=|1===|1=|1="], {
    lengths: [{ bar: 2, endBar: 4, meter: "2/4", scope: "range" }, { bar: 6, meter: "2/4", scope: "onward" }]
  });
  const c = C.compile(p);
  assert.equal(c.errors.length, 0);
  assert.deepEqual(c.bars.map(b => b.meter), ["4/4", "2/4", "2/4", "2/4", "4/4", "2/4", "2/4"]);
  assert.deepEqual(c.bars.map(b => b.meterChange), [true, true, false, false, true, true, false]);
  assert.deepEqual(c.bars.map(b => b.duration), [4, 2, 2, 2, 4, 2, 2]);
  const result = C.autoBars(p, "1=== 1= 1= 1= 1=== 1= 1=");
  assert.equal(result.count, 7); assert.equal(result.missing, 0);
  assert.equal(C.compile(project([result.source], { lengths: p.lengths })).errors.length, 0);
  const compound = project(["{123456}-|{123456}-"], { lengths: [{ bar: 1, meter: "6/8", scope: "onward" }] });
  const cc = C.compile(compound);
  assert.equal(cc.errors.length, 0);
  assert.deepEqual(C.beamGroups(cc.voices[0].bars[0], cc.bars[0], cc.bars[0].meter), [[0, 1, 2], [3, 4, 5]]);
});
test("nested temporary rules override ranges, persistent baselines restore independently", () => {
  const p = project(["0==="], {
    lengths: [
      { bar: 2, scope: "onward", meter: "3/4" },
      { bar: 3, endBar: 8, scope: "range", meter: "2/4" },
      { bar: 4, endBar: 6, scope: "range", meter: "6/8" },
      { bar: 5, scope: "single", meter: "1/4" },
      { bar: 7, scope: "onward", meter: "5/4" }
    ]
  });
  C.validateProject(p);
  assert.deepEqual(Array.from({ length: 9 }, (_, i) => C.barSettings(p, i + 1).meter),
    ["4/4", "3/4", "2/4", "6/8", "1/4", "6/8", "2/4", "2/4", "5/4"]);
  assert.deepEqual(Array.from({ length: 9 }, (_, i) => C.barSettings({ ...p, lengths: p.lengths.slice().reverse() }, i + 1).meter),
    ["4/4", "3/4", "2/4", "6/8", "1/4", "6/8", "2/4", "2/4", "5/4"]);
  p.voices[0].source = Array.from({ length: 9 }, (_, i) => `0${"=".repeat(C.barSettings(p, i + 1).duration - 1)}`).join("|");
  const c = C.compile(p);
  assert.equal(c.errors.length, 0);
  for (let i = 0; i < 9; i++) assert.deepEqual(
    { meter: c.bars[i].meter, duration: c.bars[i].duration, bpm: c.bars[i].bpm },
    { meter: C.barSettings(p, i + 1).meter, duration: C.barSettings(p, i + 1).duration, bpm: C.barSettings(p, i + 1).bpm }
  );
});
test("scoped-rule validation rejects invalid or crossing ranges but accepts nested exceptions", () => {
  for (const tempos of [
    [{ bar: 2, bpm: 68, scope: "range", endBar: 1 }],
    [{ bar: 2, bpm: 68, scope: "range", endBar: 2.5 }],
    [{ bar: 2, bpm: 68, scope: "unknown" }],
    [{ bar: 2, bpm: 68, scope: "single" }, { bar: 2, bpm: 74, scope: "range", endBar: 2 }],
    [{ bar: 2, bpm: 68, scope: "range", endBar: 5 }, { bar: 4, bpm: 74, scope: "range", endBar: 7 }]
  ]) assert.throws(() => C.validateProject(project(["0==="], { tempos })));
  assert.throws(() => C.validateProject(project(["0==="], { lengths: [{ bar: 1, meter: "2/0" }] })));
  assert.throws(() => C.validateProject(project(["0==="], { lengths: [{ bar: 1, meter: "2/4", beats: 2 }] })));
  assert.doesNotThrow(() => C.validateProject(project(["0==="], { tempos: [
    { bar: 2, bpm: 80, scope: "onward" }, { bar: 2, bpm: 68, scope: "single" }
  ] })));
});
test("legacy rule meanings and custom short measures survive scoped settings", () => {
  const p = project(["0===|0=|0==="], { tempos: [{ bar: 2, bpm: 68 }], lengths: [{ bar: 2, beats: 2 }] });
  const c = C.compile(JSON.parse(JSON.stringify(p)));
  assert.equal(c.errors.length, 0);
  assert.deepEqual(c.bars.map(b => b.bpm), [120, 68, 68]);
  assert.deepEqual(c.bars.map(b => b.duration), [4, 2, 4]);
  assert.deepEqual(c.bars.map(b => b.meter), ["4/4", "4/4", "4/4"]);
  assert.equal(c.bars[1].customLength, true);
  assert.equal(build(p).errors.length, 0);
});
test("scoped meter and tempo share export timing across voices and sustained notes", () => {
  const p = project(["1===|~1=|~1=|2===", "0===|0=|0=|5==="], {
    lengths: [{ bar: 2, endBar: 3, meter: "2/4", scope: "range" }],
    tempos: [{ bar: 3, bpm: 60, scope: "single" }]
  });
  const c = C.compile(p);
  assert.equal(c.errors.length, 0);
  assert.equal(c.bars[3].ms, 5000);
  assert.equal(c.totalMs, 7000);
  assert.deepEqual(build(p, "hold", ["0"]).events.slice(0, 3), [
    { t: 0, type: "down", keys: "a" }, { t: 5000, type: "up", keys: "a" }, { t: 5000, type: "down", keys: "s" }
  ]);
  assert.deepEqual(build(p, "tap", ["1"]).events, [{ t: 5000, type: "tap", keys: "g" }]);
});
test("ties inside triplets preserve time, suppress retriggers and sustain in hold mode", () => {
  const p = project(["(10~1010) 0=="]), c = C.compile(p);
  assert.equal(c.errors.length, 0);
  assert.equal(c.voices[0].notes[1].tie, true);
  assert.equal(c.voices[0].notes[1].tieFrom, c.voices[0].notes[0]);
  assert.deepEqual(build(p).events, [{ t: 0, type: "tap", keys: "q" }, { t: 333.333333, type: "tap", keys: "q" }]);
  assert.deepEqual(build(p, "hold").events, [
    { t: 0, type: "down", keys: "q" }, { t: 303.333333, type: "up", keys: "q" },
    { t: 333.333333, type: "down", keys: "q" }, { t: 500, type: "up", keys: "q" }
  ]);
  const allTied = project(["([135]~[531]~[153]) 0=="]);
  assert.equal(build(allTied, "hold").events.length, 2);
  assert.equal(build(allTied).events.length, 1);
  assert.ok(C.compile(project(["(1~23) 0=="])).errors.length);
  assert.throws(() => C.parseBar("(1~03)"));
  assert.ok(C.compile(project(["(~111) 0=="])).errors.length);
  assert.equal(C.compile(project(["1 (~112) 0="])).errors.length, 0);
  assert.equal(C.compile(project(["(111) ~1 0="])).errors.length, 0);
  const formatted = C.autoBars(p, "(10~1010) 0==").source;
  assert.deepEqual(build(project([formatted])).events, build(p).events);
});
test("grace notes inside triplets occupy only their own slot and preserve group duration", () => {
  const p = project(["(4050<40>50) 0=="]), c = C.compile(p), notes = c.voices[0].notes;
  assert.equal(c.errors.length, 0);
  assert.deepEqual(notes.slice(0, 3).map(n => n.grace.length), [0, 0, 1]);
  assert.deepEqual(notes[2].grace, [{ degree: 4, octave: 2 }]);
  const tap = build(p);
  assert.equal(tap.errors.length, 0);
  assert.deepEqual(tap.events, [
    { t: 0, type: "tap", keys: "r" }, { t: 166.666667, type: "tap", keys: "t" },
    { t: 333.333333, type: "tap", keys: "r" }, { t: 373.333333, type: "tap", keys: "t" }
  ]);
  assert.equal(tap.totalMs, 2000);
  const hold = build(p, "hold");
  assert.equal(hold.errors.length, 0);
  assert.equal(hold.warnings.length, 1);
  assert.deepEqual(hold.events.filter(e => e.type === "down").map(e => e.keys), ["r", "t", "t"]);
  const custom = build(project(["(<1>2 <23>(25)[135] 4) 0=="]));
  assert.equal(custom.errors.length, 0);
  assert.ok(custom.events.some(e => e.t === 216.666667 && e.keys === "adg"));
  assert.equal(C.compile(project(["{(4050<40>50)}- 0.. 0. 0--"])).errors.length, 0);
  const tooSlow = project(["(40 50 <40>(200)50) 0=="]);
  assert.ok(build(tooSlow).errors.some(e => e.message.includes("排不开")));
  assert.equal(build(tooSlow, "hold").errors.length, 0);
  assert.throws(() => C.parseBar("(1 <2>0 3)"));
  assert.throws(() => C.parseBar("(1 ~<2>1 3)"));
  assert.throws(() => C.parseBar("(1 <0>2 3)"));
  assert.deepEqual(build(project([C.autoBars(p, p.voices[0].source).source])).events, tap.events);
});
test("arpeggio final pitch may tie forward while ordinary partial chord ties remain invalid", () => {
  const p = project(["[2 79 59 29];= | ~29="], { meter: "2/4" }), c = C.compile(p);
  assert.equal(c.errors.length, 0);
  assert.equal(c.voices[0].notes[0].sustainEnd, 4);
  const tap = build(p);
  assert.equal(tap.errors.length, 0);
  assert.deepEqual(tap.events, [
    { t: 0, type: "tap", keys: "s" }, { t: 40, type: "tap", keys: "m" },
    { t: 80, type: "tap", keys: "b" }, { t: 120, type: "tap", keys: "x" }
  ]);
  assert.deepEqual(build(p, "hold").events, [{ t: 0, type: "down", keys: "x" }, { t: 2000, type: "up", keys: "x" }]);
  const chain = project(["[2 79 59 29];=|~29=|~29="], { meter: "2/4", tempos: [{ bar: 2, bpm: 60 }] });
  assert.equal(build(chain).events.length, 4);
  assert.equal(build(chain, "hold").events[1].t, 5000);
  for (const source of ["[2 79 59 29];=|~59=", "[2 79 59 29]=|~29=", "[2 79 59 29];=|~[2 79 59 29]="])
    assert.ok(C.compile(project([source], { meter: "2/4" })).errors.length, source);
  const tooSlow = project(["[2 79 59 29];(400)=|~29="], { meter: "2/4" });
  assert.ok(build(tooSlow).errors.some(e => e.message.includes("排不开")));
  assert.equal(build(tooSlow, "hold").errors.length, 0);
});
