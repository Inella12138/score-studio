"use strict";
(() => {
  const C = window.ScoreCore, $ = id => document.getElementById(id);
  const STORAGE = "score-studio.project.v1";
  const demo = () => ({
    version: 1, title: "微风练习曲", bpm: 74, meter: "4/4", gap: 40,
    keys: C.DEFAULT_KEYS.slice(),
    tempos: [{ bar: 4, bpm: 55 }], lengths: [{ bar: 3, beats: "2" }],
    voices: [
      { id: "melody", name: "高声部", source: "1- 2- 3 5= | 6. 5- 3 2 | (123) 5 | 5= 6 7 | 10= 7 6 | 5=== | ~5= 3 2 | 1===" },
      { id: "bass", name: "低声部", source: "[193959];=== | 49= 59= | [193959]= | 49= 59= | [193959];=== | 19=== | ~19= 59= | 19===" }
    ]
  });
  const blank = () => ({ ...demo(), title: "未命名曲谱", tempos: [], lengths: [], voices: [
    { id: "melody", name: "高声部", source: "0===" },
    { id: "bass", name: "低声部", source: "0===" }
  ] });
  let project = demo(), compiled, timer, toastTimer;
  let libraryFile = null, librarySha = null, uploadPreview = null;
  let homeFiles = [], homeFilter = "all", selectedSong = null, artifactPreview = null;
  const expandedSongs = new Set();
  let lastSavedProject = null, songOpenSequence = 0, libraryReadSequence = 0, sidebarCollapsed = false;
  const desktop = location.hostname === "127.0.0.1" && /^http:$/.test(location.protocol);
  let desktopToken = "";
  let managedWindow = false;
  if (desktop) {
    document.querySelector(".brand").onclick = event => { event.preventDefault(); setSidebarCollapsed(false); };
    try {
      const parameters = new URLSearchParams(location.hash.slice(1));
      managedWindow = parameters.get("managed") === "1" || sessionStorage.getItem("score-desktop-managed") === "1";
      if (managedWindow) sessionStorage.setItem("score-desktop-managed", "1");
      desktopToken = parameters.get("token") || sessionStorage.getItem("score-desktop-token") || "";
      if (desktopToken) sessionStorage.setItem("score-desktop-token", desktopToken);
      history.replaceState(null, "", location.pathname);
    } catch {}
  }
  async function libraryApi(route, body) {
    let response;
    try {
      response = await fetch(`/api/${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "X-Score-Token": desktopToken, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch { throw new Error("无法连接本地曲库服务。请重新运行 ScoreStudio.exe，并在新打开的应用窗口重试；当前草稿仍保存在浏览器中。"); }
    let result;
    try { result = await response.json(); }
    catch { throw new Error("本地服务没有返回有效响应，请重新打开 ScoreStudio.exe 后重试。"); }
    if (!response.ok) throw new Error(result.error || "曲库操作失败");
    return result;
  }
  try {
    const saved = localStorage.getItem(STORAGE);
    if (saved) project = C.validateProject(JSON.parse(saved));
  } catch { /* A fresh demo remains available when storage is unavailable. */ }
  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function toast(text) {
    $("toast").textContent = text; $("toast").classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => $("toast").classList.remove("show"), 3500);
  }
  function persist() {
    try { localStorage.setItem(STORAGE, JSON.stringify(project)); $("saveStatus").textContent = "草稿已保存 · 本机"; }
    catch { $("saveStatus").textContent = "自动保存不可用，请保存项目文件"; }
  }
  function update() {
    compiled = C.compile(project);
    renderScore();
    showDiagnostics($("diagnostics"), compiled.errors, compiled.warnings);
    $("compileBadge").textContent = compiled.errors.length ? `${compiled.errors.length} 处待修正` : "✓ 实时编译";
    $("compileBadge").classList.toggle("error", !!compiled.errors.length);
    $("scoreMeta").textContent = `${project.meter} 拍 · ♩ = ${project.bpm} · ${project.voices.length} 个声部`;
    const seconds = Math.round((compiled.totalMs || 0) / 1000);
    $("stats").textContent = `${compiled.bars.length} 小节 · ${compiled.voices.reduce((n, v) => n + v.notes.length, 0)} 组音符 · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    document.querySelectorAll(".voice-card textarea").forEach(updateVoicePosition);
    persist();
    if ($("settingsDialog").open) {
      try { C.validateProject(project); $("settingsStatus").textContent = ""; }
      catch (e) { $("settingsStatus").textContent = e.message; }
    }
    if ($("exportDialog").open) updateExport();
  }
  function scheduleUpdate() { clearTimeout(timer); timer = setTimeout(update, 160); }
  function flush() { clearTimeout(timer); update(); }
  function mount() {
    for (const id of ["title", "bpm", "meter", "gap"]) $(id).value = project[id];
    $("startDelay").value = project.startDelay ?? 3;
    $("repeatGapMs").value = project.repeatGapMs ?? 30;
    $("minHoldPercent").value = project.minHoldPercent ?? 80;
    document.querySelector(`input[name="mode"][value="${project.exportMode === "hold" ? "hold" : "tap"}"]`).checked = true;
    renderVoices(); update();
  }
  function editorView() {
    $("editorMain").hidden = false;
    if (desktop) {
      document.body.classList.add("desktop-workspace");
      $("libraryHome").hidden = sidebarCollapsed;
      $("openLibrary").textContent = "曲库";
    }
  }
  function setSidebarCollapsed(collapsed) {
    sidebarCollapsed = collapsed;
    document.body.classList.toggle("explorer-collapsed", collapsed);
    $("libraryHome").hidden = collapsed;
    $("toggleSidebar").setAttribute("aria-expanded", String(!collapsed));
    $("toggleSidebar").setAttribute("aria-label", collapsed ? "展开曲库侧边栏" : "收起曲库侧边栏");
    try { localStorage.setItem("score-studio.sidebar-collapsed", String(collapsed)); } catch {}
    requestAnimationFrame(renderScore);
  }
  async function homeView() {
    editorView();
    $("homeStatus").textContent = "正在读取本地曲库…";
    try { await showLibrary(); $("homeStatus").textContent = ""; }
    catch (e) { $("homeStatus").textContent = e.message; }
  }
  function updateVoicePosition(input) {
    const output = input.closest(".voice-card")?.querySelector(".voice-count");
    if (!output) return;
    const source = input.value, cursor = input.selectionStart;
    const count = source.trim() ? C.splitBars(source).length : 0;
    let current = 1 + (source.slice(0, cursor).match(/\|/g) || []).length;
    // An optional opening bar line does not create an extra measure.
    const opening = /^\s*\|/.exec(source);
    if (opening && cursor >= opening[0].length) current--;
    output.textContent = `${count} 小节 · 当前第 ${Math.max(1, current)} 小节`;
  }
  function renderVoices() {
    $("voices").replaceChildren();
    project.voices.forEach((voice, index) => {
      const card = el("section", "voice-card"), head = el("div", "voice-head");
      head.append(el("span", "voice-dot"));
      const name = el("input"); name.value = voice.name; name.maxLength = 60; name.setAttribute("aria-label", `声部 ${index + 1} 名称`);
      name.addEventListener("input", () => { voice.name = name.value; scheduleUpdate(); });
      head.append(name, el("small", "", `${String(index + 1).padStart(2, "0")}`));
      for (const [direction, symbol, label] of [[-1, "↑", "上移声部"], [1, "↓", "下移声部"]]) {
        const move = el("button", "move-voice", symbol);
        move.title = label; move.setAttribute("aria-label", `${label}：${voice.name}`);
        move.disabled = index + direction < 0 || index + direction >= project.voices.length;
        move.onclick = () => {
          const target = index + direction;
          if (target < 0 || target >= project.voices.length) return;
          [project.voices[index], project.voices[target]] = [project.voices[target], project.voices[index]];
          renderVoices(); flush();
          const moved = document.querySelectorAll(".voice-card")[target];
          moved.querySelectorAll(".move-voice")[direction === -1 ? 0 : 1].focus();
        };
        head.append(move);
      }
      const remove = el("button", "", "×"); remove.title = "删除声部"; remove.disabled = project.voices.length === 1;
      remove.onclick = () => {
        if (voice.source.trim() && !confirm(`删除声部「${voice.name}」及其内容？`)) return;
        project.voices.splice(index, 1); renderVoices(); flush();
      };
      head.append(remove);
      const input = el("textarea"); input.value = voice.source; input.spellcheck = false;
      input.setAttribute("aria-label", `${voice.name} 简谱代码`); input.dataset.voice = String(index);
      input.addEventListener("input", () => { voice.source = input.value; updateVoicePosition(input); scheduleUpdate(); });
      for (const event of ["click", "keyup", "select", "focus", "selectionchange"])
        input.addEventListener(event, () => updateVoicePosition(input));
      const auto = el("button", "auto-bars", "自动分小节");
      auto.title = "按拍号与特殊小节长度重新分小节；不自动补休止";
      const undo = el("button", "undo-bars", "撤销分小节"); undo.hidden = true;
      let beforeAuto = null, afterAuto = null;
      auto.onclick = () => {
        try {
          const result = C.autoBars(project, input.value);
          beforeAuto = input.value; afterAuto = result.source;
          voice.source = input.value = result.source; undo.hidden = false; flush();
          toast(`已分为 ${result.count} 小节${result.splits ? `，${result.splits} 个跨小节长音或休止已拆分` : ""}${result.missing > 1e-7 ? `；末小节还差 ${C.pretty(result.missing)} 拍` : ""}`);
        } catch (e) { toast(`无法自动分小节：${e.message}`); }
      };
      undo.onclick = () => {
        if (input.value !== afterAuto) return toast("分小节后已有新编辑，未撤销，以免覆盖修改");
        voice.source = input.value = beforeAuto; undo.hidden = true; flush(); toast("已恢复分小节前的代码");
      };
      head.insertBefore(auto, remove); head.insertBefore(undo, remove);
      const hint = el("div", "voice-hint");
      hint.append(el("span", "", "用 | 划分小节 · 换行仅用于排版"), el("small", "voice-count"));
      card.append(head, input, hint); $("voices").append(card);
      updateVoicePosition(input);
    });
  }
  function noteView(note, index, bar, voice) {
    const slot = el("div", `note-slot${note.tie ? " tied" : ""}`);
    slot.style.flex = `${note.duration} 0 0`;
    slot.dataset.note = `${voice}:${bar}:${index}`;
    slot.title = `${note.source} · ${C.pretty(note.duration)} 拍`;
    const stack = el("span", `note-stack${note.pitches.length > 1 ? " chord" : ""}${note.dots ? note.dots === 2 ? " dotted double-dotted" : " dotted" : ""}`);
    note.pitches.slice().sort((a, b) => b.octave - a.octave || b.degree - a.degree).forEach(p => {
      stack.append(el("span", `pitch${p.degree && p.octave !== 1 ? p.octave === 0 ? " low" : " high" : ""}`, String(p.degree)));
    });
    // Three eighth-note triplets occupy one quarter-note beat.
    const halves = C.beamDepth(note);
    if (halves) {
      const lines = el("span", "underlines");
      for (let i = 0; i < halves; i++) lines.append(el("i"));
      stack.append(lines);
    }
    slot.append(stack);
    if (note.breath) slot.append(el("span", "breath-mark", "’"));
    const wholeBeats = note.duration / (2 - 1 / 2 ** note.dots);
    if (!note.tuplet && wholeBeats >= 2) slot.append(el("span", "extension", "−".repeat(Math.floor(wholeBeats) - 1)));
    if (note.ornament) slot.append(el("span", "ornament", note.ornament === "wave" ? "∿" : "↗"));
    if (note.grace?.length) {
      const grace = el("span", "grace-notes");
      note.grace.forEach(p => grace.append(el("span", `grace-pitch${p.octave === 0 ? " low" : p.octave === 2 ? " high" : ""}`, String(p.degree))));
      slot.append(grace);
    }
    if (note.tuplet) slot.append(el("span", `tuplet-tag${note.tupletPart === 1 ? "" : " cont"}`, "3"));
    if (note.exactDuration) slot.append(el("span", "duration-label", `${C.pretty(note.exactDuration)}拍`));
    return slot;
  }
  function renderScore() {
    const score = $("score");
    score.replaceChildren(el("h2", "score-title", project.title || "未命名曲谱"), el("div", "score-subtitle", `1 = 当前乐器调式　${project.meter}　♩ = ${project.bpm}`));
    if (!compiled.bars.length) return;
    const available = Math.max(300, $("score").clientWidth - 90);
    const groups = [];
    let group = [], used = 0;
    compiled.bars.forEach((bar, j) => {
      const maxNotes = Math.max(1, ...compiled.voices.map(v => v.bars[j]?.length || 0));
      const extensions = Math.max(0, ...compiled.voices.map(v => (v.bars[j] || []).reduce((n, x) => n + Math.max(0, x.extensions - 1), 0)));
      const width = Math.max(132, maxNotes * 35 + extensions * 13 + 16);
      if (group.length && used + width > available) { groups.push(group); group = []; used = 0; }
      group.push({ bar, j, width }); used += width;
    });
    if (group.length) groups.push(group);
    groups.forEach(items => {
      const system = el("div", "score-system"), labels = el("div", "system-labels");
      const rowCounts = compiled.voices.map(v => Math.max(1, ...items.map(({j}) => v.branchBars[j]?.length || 1)));
      compiled.voices.forEach((v, vi) => {
        const label = el("div", "system-label", v.name); label.style.height = `${107 * rowCounts[vi]}px`; labels.append(label);
      });
      system.append(labels);
      items.forEach(({ bar, j, width }) => {
        const measure = el("div", "measure"); measure.style.minWidth = `${width}px`;
        const meta = el("div", "measure-meta"); meta.append(el("span", "", String(j + 1).padStart(2, "0")));
        if (bar.tempoChange) meta.append(el("span", "tempo", `♩=${bar.bpm}`));
        if (bar.special) meta.append(el("span", "special", `${C.pretty(bar.duration)} 拍`));
        measure.append(meta);
        compiled.voices.forEach((v, vi) => {
          const bad = compiled.errors.some(e => e.voice === vi && e.bar === j);
          const container = el("div", "voice-measure"); container.style.height = `${107 * rowCounts[vi]}px`;
          const branches = v.branchBars[j] || [[]];
          branches.forEach((branchNotes, branchIndex) => {
          const staff = el("div", `staff-bar${bad ? " invalid" : ""}`);
          const notes = branchNotes;
          staff.dataset.voice = String(vi); staff.dataset.bar = String(j);
          const beamGroups = C.beamGroups(notes, bar, bar.meter).map(group => group.map(i => v.bars[j].indexOf(notes[i])));
          if (branches.length > 1) staff.append(el("span", "branch-label", `分支 ${branchIndex + 1}`));
          // Absolute positions keep unequal voice rhythms aligned to the same beat.
          notes.forEach((n, ni) => {
            const globalIndex = v.bars[j].indexOf(n);
            const slot = noteView(n, globalIndex, j, vi);
            slot.style.position = "absolute";
            slot.style.left = `${(n.start - bar.beat) / bar.duration * 100}%`;
            slot.style.width = `${n.duration / bar.duration * 100}%`;
            slot.style.height = "100%";
            if (beamGroups.some(group => group.includes(globalIndex))) slot.classList.add("beamed");
            staff.append(slot);
          });
          staff._beamGroups = beamGroups;
          container.append(staff);
          });
          measure.append(container);
        });
        system.append(measure);
      });
      score.append(system);
    });
    requestAnimationFrame(() => { drawTies(); drawBeams(); });
  }
  function drawBeams() {
    const ns = "http://www.w3.org/2000/svg", scale = Number($("zoom").value) / 100;
    $("score").querySelectorAll(".staff-bar").forEach(staff => {
      staff.querySelector(".beam-layer")?.remove();
      if (!staff._beamGroups?.length) return;
      const svg = document.createElementNS(ns, "svg");
      svg.classList.add("beam-layer");
      const rect = staff.getBoundingClientRect();
      svg.setAttribute("width", String(rect.width / scale)); svg.setAttribute("height", "107");
      const notes = compiled.voices[Number(staff.dataset.voice)].bars[Number(staff.dataset.bar)];
      staff._beamGroups.forEach(group => {
        const points = group.map(i => {
          const box = staff.querySelector(`[data-note$=":${i}"] .note-stack`).getBoundingClientRect();
          const n = notes[i];
          return { left: (box.left - rect.left) / scale, right: (box.right - rect.left) / scale,
            bottom: (box.bottom - rect.top) / scale + (n.pitches.some(p => p.octave === 0 && p.degree) ? 10 : 4),
            depth: C.beamDepth(n) };
        });
        const baseY = Math.max(...points.map(p => p.bottom));
        const levels = Math.max(...points.map(p => p.depth));
        for (let level = 1; level <= levels; level++) {
          let run = [];
          const finish = () => {
            if (!run.length) return;
            const line = document.createElementNS(ns, "line");
            line.setAttribute("x1", String(run[0].left));
            line.setAttribute("x2", String(run[run.length - 1].right));
            line.setAttribute("y1", String(baseY + (level - 1) * 4));
            line.setAttribute("y2", String(baseY + (level - 1) * 4));
            line.dataset.level = String(level);
            svg.append(line); run = [];
          };
          for (const point of points) { if (point.depth >= level) run.push(point); else finish(); }
          finish();
        }
      });
      staff.append(svg);
    });
  }
  function drawTies() {
    const score = $("score"); score.querySelector(".tie-layer")?.remove();
    const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg");
    svg.classList.add("tie-layer"); svg.setAttribute("width", String(score.scrollWidth)); svg.setAttribute("height", String(score.scrollHeight));
    const base = score.getBoundingClientRect(), scale = Number($("zoom").value) / 100;
    const point = node => {
      const r = node.querySelector(".note-stack").getBoundingClientRect();
      return { x: (r.left + r.width / 2 - base.left) / scale, y: (r.top - base.top) / scale - 8 };
    };
    const path = d => { const p = document.createElementNS(ns, "path"); p.setAttribute("d", d); svg.append(p); };
    compiled.voices.forEach((v, vi) => v.bars.forEach((notes, bi) => notes.forEach((n, ni) => {
      if (!n.tieFrom) return;
      const previous = n.tieFrom, pIndex = v.bars[previous.bar].indexOf(previous);
      const from = score.querySelector(`[data-note="${vi}:${previous.bar}:${pIndex}"]`);
      const to = score.querySelector(`[data-note="${vi}:${bi}:${ni}"]`);
      if (!from || !to) return;
      const a = point(from), b = point(to);
      if (from.closest(".score-system") === to.closest(".score-system")) path(`M ${a.x} ${a.y} Q ${(a.x + b.x) / 2} ${Math.min(a.y, b.y) - 22} ${b.x} ${b.y}`);
      else {
        const systemRect = from.closest(".score-system").getBoundingClientRect();
        const edge = (systemRect.right - base.left) / scale;
        path(`M ${a.x} ${a.y} Q ${(a.x + edge) / 2} ${a.y - 17} ${edge} ${a.y - 5}`);
        path(`M 70 ${b.y - 5} Q ${(70 + b.x) / 2} ${b.y - 17} ${b.x} ${b.y}`);
      }
    })));
    score.append(svg);
  }
  function showDiagnostics(target, errors, warnings) {
    target.replaceChildren();
    if (!errors.length && !warnings.length) target.append(el("div", "diag-ok", "节拍检查通过，声部已对齐"));
    [...errors.map(x => ({ ...x, error: true })), ...warnings].forEach(issue => {
      const item = el(issue.voice !== undefined ? "button" : "div", `diag-item${issue.error ? "" : " warning"}`);
      const prefix = `${issue.name ? `${issue.name} · ` : ""}${issue.bar !== undefined ? `第 ${issue.bar + 1} 小节：` : ""}`;
      item.textContent = prefix + issue.message;
      if (issue.voice !== undefined) item.onclick = () => {
        const input = document.querySelector(`textarea[data-voice="${issue.voice}"]`);
        if (!input) return;
        input.focus();
        const parts = input.value.split("|"), offset = parts.slice(0, issue.bar).reduce((n, s) => n + s.length + 1, 0);
        input.setSelectionRange(offset, offset + (parts[issue.bar]?.length || 0));
      };
      target.append(item);
    });
  }
  function renderSettings() {
    const rows = (field, target) => {
      $(target).replaceChildren();
      project[field].forEach((r, i) => {
        const tempo = field === "tempos", prefix = `${tempo ? "曲速" : "节拍"}规则 ${i + 1}`;
        const row = el("div", "setting-row rule-row"), bar = el("input"), end = el("input"),
          value = el("input"), scope = el("select"), type = el("select"), remove = el("button", "", "删除");
        const control = (name, input) => { const label = el("label", "", name); label.append(input); row.append(label); };
        for (const [id, text] of [["single", "仅此小节"], ["range", "指定范围"], ["onward", "从此小节起"]]) {
          const option = el("option", "", text); option.value = id; scope.append(option);
        }
        scope.value = r.scope ?? (tempo ? "onward" : "single");
        scope.setAttribute("aria-label", `${prefix}生效范围`);
        control("生效方式", scope);
        bar.type = end.type = "number"; bar.min = end.min = "1"; bar.max = end.max = "10000";
        bar.value = r.bar; end.value = r.endBar ?? r.bar;
        bar.setAttribute("aria-label", `${prefix}起始小节`); end.setAttribute("aria-label", `${prefix}结束小节`);
        control("起始小节", bar); control("结束小节（含）", end);
        end.disabled = scope.value !== "range";
        if (!tempo) {
          for (const [id, text] of [["meter", "拍号"], ["beats", "自定义拍数"]]) {
            const option = el("option", "", text); option.value = id; type.append(option);
          }
          type.value = r.meter !== undefined ? "meter" : "beats"; type.setAttribute("aria-label", `${prefix}设置类型`);
          control("设置类型", type);
        }
        const valueName = tempo ? "bpm" : r.meter !== undefined ? "meter" : "beats";
        value.value = r[valueName]; value.setAttribute("aria-label", `${prefix}${tempo ? "BPM" : valueName === "meter" ? "拍号" : "拍数"}`);
        if (tempo) { value.type = "number"; value.min = "1"; value.max = "400"; }
        else value.placeholder = valueName === "meter" ? "2/4" : "2 或 3/2";
        control(tempo ? "BPM" : valueName === "meter" ? "拍号" : "四分音符拍数", value);
        scope.onchange = () => {
          r.scope = scope.value;
          if (r.scope === "range") {
            r.endBar = Math.max(Number(r.bar), Number(end.value) || Number(r.bar));
            end.value = r.endBar;
          }
          else delete r.endBar;
          end.disabled = r.scope !== "range"; flush();
        };
        end.oninput = () => { r.endBar = Number(end.value); scheduleUpdate(); };
        type.onchange = () => {
          delete r.meter; delete r.beats;
          if (type.value === "meter") r.meter = "2/4"; else r.beats = "2";
          renderSettings(); flush();
        };
        bar.oninput = () => { r.bar = Number(bar.value); scheduleUpdate(); };
        value.oninput = () => { r[valueName] = tempo ? Number(value.value) : value.value; scheduleUpdate(); };
        remove.onclick = () => { project[field].splice(i, 1); renderSettings(); flush(); };
        row.append(remove);
        $(target).append(row);
      });
    };
    rows("tempos", "tempoRows");
    rows("lengths", "lengthRows");
    $("keyRows").replaceChildren();
    ["低音 19～79", "中音 1～7", "高音 10～70"].forEach((name, i) => {
      const label = el("label", "", name), input = el("input");
      input.value = project.keys[i]; input.maxLength = 7; input.setAttribute("aria-label", name);
      input.oninput = () => { project.keys[i] = input.value.toUpperCase(); scheduleUpdate(); };
      label.append(input); $("keyRows").append(label);
    });
  }
  function exportSelection() {
    return document.querySelector('input[name="scope"]:checked').value === "all" ? project.voices.map(v => v.id) :
      [...$("exportVoices").querySelectorAll("input:checked")].map(i => i.value);
  }
  function renderModeRows() {
    $("modeRows").replaceChildren();
    (project.modes || []).forEach((r, i) => {
      const row = el("div", "setting-row rule-row"), scope = el("select"), start = el("input"), end = el("input"), mode = el("select");
      for (const [value, name] of [["single", "仅此小节"], ["range", "指定范围"], ["onward", "从此小节起"]]) {
        const option = el("option", "", name); option.value = value; scope.append(option);
      }
      for (const [value, name] of [["tap", "点按"], ["hold", "按住"]]) {
        const option = el("option", "", name); option.value = value; mode.append(option);
      }
      scope.value = r.scope ?? "onward"; mode.value = r.mode;
      start.type = end.type = "number"; start.min = end.min = "1"; start.max = end.max = "10000";
      start.value = r.bar; end.value = r.endBar ?? r.bar; end.disabled = scope.value !== "range";
      for (const [name, control] of [["生效方式", scope], ["起始小节", start], ["结束小节（含）", end], ["模式", mode]]) {
        const label = el("label", "", name); control.setAttribute("aria-label", `模式规则 ${i + 1} ${name}`); label.append(control); row.append(label);
      }
      scope.onchange = () => {
        r.scope = scope.value;
        if (r.scope === "range") { r.endBar = Math.max(Number(start.value), Number(end.value) || Number(start.value)); end.value = r.endBar; }
        else delete r.endBar;
        end.disabled = r.scope !== "range"; persist(); updateExport();
      };
      start.oninput = () => { r.bar = Number(start.value); persist(); updateExport(); };
      end.oninput = () => { r.endBar = Number(end.value); persist(); updateExport(); };
      mode.onchange = () => { r.mode = mode.value; persist(); updateExport(); };
      const remove = el("button", "", "删除"); remove.onclick = () => { project.modes.splice(i, 1); renderModeRows(); persist(); updateExport(); };
      row.append(remove); $("modeRows").append(row);
    });
  }
  function plan() {
    return C.makeEvents(project, compiled, exportSelection(), document.querySelector('input[name="mode"]:checked').value);
  }
  function scheduleValue() {
    if (!$("scheduled").checked) return "";
    const text = $("startTime").value;
    if (!text || !Number.isFinite(new Date(text).getTime())) throw new Error("请选择有效的本地开始时间");
    if (new Date(text).getTime() <= Date.now()) throw new Error("定时开始必须设置为未来时间");
    return text.replace(/[-T:]/g, "").padEnd(14, "0");
  }
  function updateExport() {
    const hold = document.querySelector('input[name="mode"]:checked').value === "hold" || (project.modes || []).some(r => r.mode === "hold");
    $("holdSettings").hidden = !hold;
    compiled = C.compile(project);
    const p = plan();
    if (hold && ["repeatGapMs", "minHoldPercent"].some(id => $(id).value === "")) p.errors.push({ message: "请填写重复音松键间隔和前音最低保留比例" });
    try { scheduleValue(); } catch (e) { p.errors.push({ message: e.message }); }
    const delay = Number($("startDelay").value);
    if ($("startDelay").value === "" || !Number.isFinite(delay) || delay < 0 || delay > 60) p.errors.push({ message: "开演延迟应为 0～60 秒" });
    showDiagnostics($("exportStatus"), p.errors, p.warnings);
    $("downloadAhk").disabled = $("previewCode").disabled = !!p.errors.length;
    const all = document.querySelector('input[name="scope"]:checked').value === "all";
    $("exportVoices").querySelectorAll("input").forEach(i => i.disabled = all);
    $("codePreview").hidden = true;
    return p;
  }
  function download(filename, text, mime) {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = el("a"); a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function filename() {
    const clean = (project.title || "曲谱").replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, "_").trim();
    let name = "";
    for (const character of clean) {
      if (name.length + character.length > 150) break;
      name += character;
    }
    name = name.replace(/[. ]+$/, "") || "曲谱";
    if (/^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(name)) name = "曲谱-" + name;
    return name;
  }
  for (const id of ["title", "bpm", "meter", "gap"]) $(id).addEventListener("input", () => {
    project[id] = ["bpm", "gap"].includes(id) ? Number($(id).value) : $(id).value; scheduleUpdate();
  });
  $("addVoice").onclick = () => {
    if (project.voices.length >= 16) return toast("最多支持 16 个声部");
    const source = compiled.bars.map(b => b.duration >= 1 && Number.isInteger(b.duration) ? `0${"=".repeat(b.duration - 1)}` : "").join(" | ");
    project.voices.push({ id: `voice-${Date.now()}`, name: `声部 ${project.voices.length + 1}`, source });
    renderVoices(); flush();
  };
  $("settingsButton").onclick = () => { renderSettings(); $("settingsDialog").showModal(); };
  $("settingsDone").onclick = () => { flush(); $("settingsDialog").close(); };
  $("addTempo").onclick = () => {
    const used = new Set(project.tempos.map(r => Number(r.bar))); let bar = 2;
    while (used.has(bar)) bar++;
    project.tempos.push({ bar, bpm: project.bpm, scope: "onward" }); renderSettings(); flush();
  };
  $("addLength").onclick = () => {
    const used = new Set(project.lengths.map(r => Number(r.bar))); let bar = 1;
    while (used.has(bar)) bar++;
    project.lengths.push({ bar, meter: "2/4", scope: "single" }); renderSettings(); flush();
  };
  async function saveToLibrary() {
    const savedProject = project;
    const savedJson = JSON.stringify(project);
    const result = await libraryApi("save", { name: libraryFile || `${filename()}.score.json`, project, expectedSha: librarySha });
    if (project !== savedProject) throw new Error("已保存刚才的项目；当前项目已切换，请重新操作。");
    libraryFile = result.name; librarySha = result.sha;
    lastSavedProject = savedJson; selectedSong = result.name; expandedSongs.add(result.name);
    showLibrary().catch(e => { $("homeStatus").textContent = e.message; });
    return result;
  }
  $("saveProject").onclick = async () => {
    flush();
    if (!desktop) { download(`${filename()}.score.json`, JSON.stringify(project, null, 2), "application/json;charset=utf-8"); toast("项目文件已导出"); return; }
    try {
      await saveToLibrary();
      toast("已保存到应用目录 scores；上传曲谱后其他设备才会获取更新");
    } catch (e) { toast(e.message); }
  };
  $("importProject").onclick = () => $("fileInput").click();
  $("fileInput").onchange = async () => {
    const file = $("fileInput").files[0]; if (!file) return;
    try {
      if (file.size > 4 * 1024 * 1024) throw new Error("项目文件不能超过 4MB");
      const next = C.validateProject(JSON.parse(await file.text()));
      if (!confirm("打开项目将替换当前草稿。建议先保存当前项目，是否继续？")) return;
      project = next; libraryFile = librarySha = lastSavedProject = null; selectedSong = null; mount(); editorView(); renderCollection(); toast("项目已打开");
    } catch (e) { toast(`无法打开：${e.message}`); }
    finally { $("fileInput").value = ""; }
  };
  $("newProject").onclick = () => { if (confirm("新建将替换当前草稿，是否继续？")) { songOpenSequence++; project = blank(); libraryFile = librarySha = lastSavedProject = null; selectedSong = null; mount(); editorView(); renderCollection(); } };
  $("loadDemo").onclick = () => { if (confirm("载入示例将替换当前草稿，是否继续？")) { songOpenSequence++; project = demo(); libraryFile = librarySha = lastSavedProject = null; selectedSong = null; mount(); editorView(); renderCollection(); } };
  $("openExport").onclick = () => {
    flush(); $("exportVoices").replaceChildren();
    renderModeRows();
    project.voices.forEach(v => {
      const label = el("label"), input = el("input"); input.type = "checkbox"; input.value = v.id; input.checked = true;
      input.onchange = updateExport; label.append(input, document.createTextNode(v.name)); $("exportVoices").append(label);
    });
    updateExport(); $("exportDialog").showModal();
  };
  document.querySelectorAll('input[name="mode"],input[name="scope"]').forEach(input => input.onchange = () => {
    project.exportMode = document.querySelector('input[name="mode"]:checked').value; persist(); updateExport();
  });
  $("addMode").onclick = () => {
    project.modes ??= [];
    let bar = 1; while (project.modes.some(r => Number(r.bar) === bar)) bar++;
    project.modes.push({ bar, scope: "single", mode: document.querySelector('input[name="mode"]:checked').value === "hold" ? "tap" : "hold" });
    renderModeRows(); persist(); updateExport();
  };
  $("scheduled").onchange = () => { $("startTime").disabled = !$("scheduled").checked; updateExport(); };
  $("startTime").oninput = updateExport;
  $("startDelay").oninput = () => { project.startDelay = Number($("startDelay").value); persist(); updateExport(); };
  for (const id of ["repeatGapMs", "minHoldPercent"]) $(id).oninput = () => {
    project[id] = $(id).value === "" ? null : Number($(id).value); persist(); updateExport();
  };
  $("previewCode").onclick = () => {
    const p = updateExport(); if (p.errors.length) return;
    $("codePreview").textContent = C.ahk(project, p, { schedule: scheduleValue() }); $("codePreview").hidden = false;
  };
  $("downloadAhk").onclick = async () => {
    flush(); const p = updateExport(); if (p.errors.length) return;
    const mode = document.querySelector('input[name="mode"]:checked').value;
    if (desktop) {
      $("downloadAhk").disabled = true;
      try {
        const snapshot = project, selected = exportSelection(), options = { schedule: scheduleValue() };
        const saved = await saveToLibrary();
        if (project !== snapshot) throw new Error("当前项目已切换，请重新导出");
        const exported = await libraryApi("artifacts/export", { name: saved.name, expectedSha: saved.sha, project: snapshot, selected, mode, options });
        toast("导出成功，可在此曲目的“演奏脚本”中找到");
        $("exportDialog").close();
        showArtifactPreview(exported);
        expandedSongs.add(saved.name);
        try { await showLibrary(); }
        catch (e) { $("artifactActionStatus").textContent = `脚本已保存；刷新曲库失败：${e.message}`; }
      } catch (e) { $("exportStatus").textContent = e.message; }
      finally { $("downloadAhk").disabled = false; }
      return;
    }
    download(`${filename()}-${mode}-${exportSelection().length}声部.ahk`, "\uFEFF" + C.ahk(project, p, { schedule: scheduleValue() }), "text/plain;charset=utf-8");
    toast("AHK 脚本已导出，请先聚焦钢琴窗口再开始");
  };
  $("zoom").oninput = () => { $("score").style.setProperty("--scale", Number($("zoom").value) / 100); renderScore(); };
  let resizeTimer;
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderScore, 160); });
  window.addEventListener("beforeunload", persist);
  async function showLibrary() {
    const request = ++libraryReadSequence;
    const { files } = await libraryApi("list");
    if (request !== libraryReadSequence) return;
    homeFiles = files; renderCollection();
    $("libraryFiles").replaceChildren();
    for (const file of files) {
      const row = el("div", "library-row"), info = el("span", "", file.valid ? `${file.title} · ${file.voices} 声部` : `${file.name} · 文件格式待修复`);
      const open = el("button", "", "打开"); open.disabled = !file.valid;
      open.onclick = async () => {
        try {
          const result = await libraryApi(`read?name=${encodeURIComponent(file.name)}`);
          const next = C.validateProject(result.project);
          if (!confirm("打开曲库曲谱会替换当前草稿，请先保存。是否继续？")) return;
          project = next; libraryFile = result.name; librarySha = result.sha; lastSavedProject = JSON.stringify(next); selectedSong = result.name; expandedSongs.add(result.name); mount(); editorView(); renderCollection(); $("libraryDialog").close();
        } catch (e) { $("libraryStatus").textContent = e.message; }
      };
      row.append(info, open); $("libraryFiles").append(row);
    }
  }
  if (desktop) {
    for (const id of ["openLibrary", "updateLibrary", "uploadLibrary"]) $(id).hidden = false;
    $("saveProject").textContent = "保存到曲库";
    $("downloadAhk").textContent = "保存演奏脚本";
    $("toggleSidebar").hidden = false;
    try { sidebarCollapsed = localStorage.getItem("score-studio.sidebar-collapsed") === "true"; } catch {}
    setSidebarCollapsed(sidebarCollapsed);
    $("toggleSidebar").onclick = () => setSidebarCollapsed(!sidebarCollapsed);
    $("openLibrary").onclick = async () => {
      setSidebarCollapsed(false); await homeView(); $("librarySearch").focus();
    };
    $("updateLibrary").onclick = async () => {
      $("updateLibrary").disabled = true;
      $("libraryDialog").showModal(); $("libraryStatus").textContent = "正在免登录更新曲库…";
      try {
        const r = await libraryApi("update", {}); await showLibrary();
        $("libraryStatus").textContent = `下载 ${r.downloaded.length} 首，冲突 ${r.conflicts.length} 首。${r.message}${r.conflicts.length ? "：" + r.conflicts.join("、") : ""}`;
      } catch (e) { $("libraryStatus").textContent = e.message; }
      finally { $("updateLibrary").disabled = false; }
    };
    $("uploadLibrary").onclick = async () => {
      $("uploadDialog").showModal(); $("confirmUpload").disabled = true; $("uploadFiles").replaceChildren();
      $("uploadStatus").textContent = "正在检查本地与远程差异；尚未上传…";
      try {
        uploadPreview = await libraryApi("preview", {});
        $("confirmUpload").textContent = uploadPreview.submission === "pull_request" ? "提交 PR，等待 Inella12138 审核" : "确认上传这些曲谱";
        for (const change of uploadPreview.changes) $("uploadFiles").append(el("div", "library-row", `${change.action}：${change.name}`));
        $("uploadStatus").textContent = uploadPreview.changes.length ? `共 ${uploadPreview.changes.length} 首待上传，请核对。${uploadPreview.submission === "pull_request" ? "当前账号将提交 Pull Request，不会直接修改主曲库。" : ""}` : "曲库已是最新，没有待上传变更。";
        $("confirmUpload").disabled = !uploadPreview.changes.length;
      } catch (e) { $("uploadStatus").textContent = e.message; }
    };
    $("confirmUpload").onclick = async () => {
      $("confirmUpload").disabled = true; $("uploadStatus").textContent = uploadPreview?.submission === "pull_request" ? "正在创建分支与 Pull Request…" : "正在提交到公开曲库…";
      try { const r = await libraryApi("upload", { id: uploadPreview?.id }); $("uploadStatus").textContent = r.message + (r.pullRequest?.url ? `\nPR：${r.pullRequest.url}` : ""); }
      catch (e) { $("uploadStatus").textContent = e.message; }
    };
    $("githubLogin").onclick = async () => {
      $("githubLogin").disabled = true; $("libraryStatus").textContent = "请在弹出的浏览器完成 GitHub 授权；无需把密码或令牌输入本应用。";
      try { const r = await libraryApi("login", {}); $("libraryStatus").textContent = `GitHub 已登录：${r.login}`; }
      catch (e) { $("libraryStatus").textContent = e.message; }
      finally { $("githubLogin").disabled = false; }
    };
  }
  function dateLabel(value) {
    if (!value) return "";
    const date = new Date(value); return Number.isNaN(date.valueOf()) ? "" : date.toLocaleDateString("zh-CN");
  }
  function voicesFor(file) { return file.voiceNames || [`${file.voices || 0} 个声部`]; }
  function showArtifactPreview(result) {
    const meta = result.metadata || {};
    artifactPreview = result;
    $("artifactTitle").textContent = meta.title || "演奏脚本";
    $("artifactMeta").textContent = `${meta.fileName || ""}\n${(meta.voiceNames || []).join(" + ")} · ${meta.modeRuleCount ? "混合" : meta.mode === "hold" ? "按住" : "点按"}模式${meta.stale ? " · 此脚本对应较早曲谱版本" : ""}`;
    $("artifactPath").value = meta.absolutePath || meta.relativePath || "";
    $("copyArtifactPath").disabled = !meta.absolutePath;
    $("downloadArtifact").disabled = false;
    $("artifactActionStatus").textContent = "";
    $("artifactCode").textContent = result.script || "";
    if (!$("artifactDialog").open) $("artifactDialog").showModal();
  }
  function renderCollection() {
    const artifactTotal = homeFiles.reduce((sum, f) => sum + (f.artifactCount || f.artifacts?.length || 0), 0);
    $("navScoreCount").textContent = homeFiles.length;
    $("navArtifactCount").textContent = artifactTotal;
    const query = $("librarySearch").value.trim().toLowerCase();
    const files = homeFiles.filter(f => (homeFilter !== "artifacts" || (f.artifactCount || f.artifacts?.length)) &&
      `${f.title} ${f.name} ${voicesFor(f).join(" ")}`.toLowerCase().includes(query));
    if ($("librarySort").value === "recent") files.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    else files.sort((a, b) => a.title.localeCompare(b.title, "zh"));
    $("collectionHeading").textContent = homeFilter === "artifacts" ? "演奏脚本" : "全部曲谱";
    $("collectionCount").textContent = `${files.length} 首`;
    $("libraryGrid").replaceChildren(); $("libraryEmpty").hidden = !!files.length;
    files.forEach(file => {
      const expanded = expandedSongs.has(file.name), item = el("div", "tree-song");
      item.setAttribute("role", "treeitem"); item.setAttribute("aria-expanded", String(expanded));
      item.setAttribute("aria-label", file.title); item.dataset.name = file.name;
      const row = el("div", `tree-song-row${libraryFile === file.name ? " selected" : ""}`);
      const toggle = el("button", "tree-expand", expanded ? "⌄" : "›");
      toggle.setAttribute("aria-label", `${expanded ? "收起" : "展开"}曲谱：${file.title}`);
      toggle.onclick = () => { if (expanded) expandedSongs.delete(file.name); else expandedSongs.add(file.name); renderCollection(); };
      const open = el("button", "tree-song-open");
      open.append(el("span", "tree-song-icon", "♩"), el("span", "tree-song-title", file.title));
      open.setAttribute("aria-label", `编辑曲谱：${file.title}`);
      open.title = `${file.name}\n${file.bpm ? "♩=" + file.bpm + " · " : ""}${file.bars || "—"} 小节 · ${voicesFor(file).join(" / ")}`;
      open.disabled = !file.valid; open.onclick = () => openSong(file);
      const count = file.artifactCount || file.artifacts?.length || 0;
      const badge = el("span", "tree-count", count ? String(count) : "");
      badge.title = `${count} 份演奏脚本`;
      row.append(toggle, open, badge); item.append(row);
      if (expanded) item.append(renderSongChildren(file));
      $("libraryGrid").append(item);
    });
  }
  async function openSong(file, exportAfter = false) {
    const request = ++songOpenSequence;
    if (libraryFile === file.name) {
      expandedSongs.add(file.name); renderCollection();
      if (exportAfter) $("openExport").click();
      return;
    }
    try {
      const result = await libraryApi(`read?name=${encodeURIComponent(file.name)}`);
      if (request !== songOpenSequence) return;
      const next = C.validateProject(result.project);
      if (JSON.stringify(project) !== lastSavedProject && !confirm("切换曲谱会替换当前编辑草稿，请确认已保存。是否继续？")) return;
      project = next; libraryFile = result.name; librarySha = result.sha; lastSavedProject = JSON.stringify(next);
      selectedSong = result.name; expandedSongs.add(result.name); mount(); editorView(); renderCollection();
      if (exportAfter) $("openExport").click();
    } catch (e) { $("homeStatus").textContent = e.message; }
  }
  function renderSongChildren(file) {
    const detail = el("div", "tree-children"); detail.setAttribute("role", "group");
    detail.append(el("p", "tree-song-meta", `${file.bars || "—"} 小节 · ${file.meter || "—"} · ${file.bpm ? "♩=" + file.bpm : ""}`));
    const names = el("div", "voice-chips"); voicesFor(file).forEach(name => names.append(el("span", "", name))); detail.append(names);
    detail.append(el("div", "tree-script-heading", "演奏脚本"));
    const artifacts = file.artifacts || [];
    if (!artifacts.length) detail.append(el("p", "tree-empty", "还没有演奏脚本"));
    const staleCount = artifacts.filter(a => a.stale).length;
    if (staleCount) {
      const clean = el("button", "artifact-clean", `清理本曲过期脚本（${staleCount} 份）`);
      clean.onclick = async () => {
        if (!confirm(`将「${file.title}」目前过期的 ${staleCount} 份脚本移到本地回收区，保留当前版本脚本。是否继续？`)) return;
        clean.disabled = true;
        try {
          const result = await libraryApi("artifacts/clean-stale", { name: file.name });
          await showLibrary(); toast(result.message || "已清理过期脚本；文件保留在 .local/artifact-trash");
        } catch (e) { $("homeStatus").textContent = e.message; clean.disabled = false; }
      };
      detail.append(clean);
    }
    for (const a of artifacts) {
      const item = el("div", `tree-artifact artifact-item${a.stale ? " stale" : ""}`), view = el("button", "tree-artifact-open");
      const label = `${(a.voiceNames || []).join("+") || "演奏脚本"} · ${a.modeRuleCount ? "混合" : a.mode === "hold" ? "按住" : "点按"}`;
      view.append(el("span", "tree-script-icon", "⌘"), el("span", "tree-artifact-title", label));
      view.setAttribute("aria-label", `预览脚本：${file.title} ${label}`);
      view.title = `${a.fileName || label}\n${dateLabel(a.createdAt)}${a.stale ? "\n曲谱已有更新，建议重新导出" : ""}`;
      const actions = el("div", "artifact-actions");
      view.onclick = async () => {
        try {
          const result = await libraryApi(`artifact?name=${encodeURIComponent(file.name)}&id=${encodeURIComponent(a.id)}`);
          showArtifactPreview(result);
        } catch (e) { $("homeStatus").textContent = e.message; }
      };
      const reveal = el("button", "tree-artifact-action", "↗"); reveal.title = "定位文件"; reveal.setAttribute("aria-label", `定位文件：${a.fileName || label}`);
      reveal.onclick = async () => {
        reveal.disabled = true;
        try { await libraryApi("artifacts/reveal", { name: file.name, id: a.id }); toast("已在文件管理器中选中脚本，直接使用此文件即可"); }
        catch (e) { $("homeStatus").textContent = e.message; }
        finally { reveal.disabled = false; }
      };
      const remove = el("button", "tree-artifact-action danger", "×"); remove.title = "删除脚本"; remove.setAttribute("aria-label", `删除脚本：${a.fileName || label}`);
      remove.onclick = async () => {
        if (!confirm(`删除「${file.title}」的 ${(a.voiceNames || []).join(" + ")} 演奏脚本？文件会先移到本地回收区。`)) return;
        remove.disabled = true;
        try {
          const result = await libraryApi("artifacts/delete", { name: file.name, id: a.id });
          await showLibrary(); toast(result.message || "已移到本地回收区 .local/artifact-trash");
        } catch (e) { $("homeStatus").textContent = e.message; remove.disabled = false; }
      };
      actions.append(reveal, remove); item.append(view, actions);
      if (a.stale) item.append(el("span", "artifact-stale", "曲谱已更新 · 建议重新导出"));
      detail.append(item);
    }
    const create = el("button", "detail-edit", "＋ 导出新的声部脚本"); create.disabled = !file.valid; create.onclick = () => openSong(file, true);
    detail.append(create);
    return detail;
  }
  $("librarySearch").oninput = renderCollection; $("librarySort").onchange = renderCollection;
  $("filterAll").onclick = () => { homeFilter = "all"; $("filterAll").classList.add("active"); $("filterArtifacts").classList.remove("active"); renderCollection(); };
  $("filterArtifacts").onclick = () => { homeFilter = "artifacts"; $("filterArtifacts").classList.add("active"); $("filterAll").classList.remove("active"); renderCollection(); };
  $("homeNew").onclick = () => $("newProject").click();
  async function refreshTrash() {
    const result = await libraryApi("artifacts/trash");
    $("trashSummary").textContent = `${result.count} 份已删除脚本 · ${(result.bytes / 1024).toFixed(1)} KB${result.protectedCount ? `；${result.protectedCount} 项未完成或异常记录将保留，不自动清空。` : ""}`;
    $("emptyArtifactTrash").disabled = !result.count;
    return result;
  }
  $("openArtifactTrash").onclick = async () => {
    $("trashDialog").showModal(); $("trashStatus").textContent = "正在读取回收区…"; $("emptyArtifactTrash").disabled = true;
    try { await refreshTrash(); $("trashStatus").textContent = ""; }
    catch (e) { $("trashStatus").textContent = e.message; }
  };
  $("emptyArtifactTrash").onclick = async () => {
    $("emptyArtifactTrash").disabled = true;
    try {
      const summary = await refreshTrash();
      if (!summary.count) return;
      if (!confirm(`永久删除本地回收区中 ${summary.count} 份已删除脚本及其恢复清单？此操作无法撤销。`)) return;
      $("emptyArtifactTrash").disabled = true;
      const result = await libraryApi("artifacts/trash/empty", { confirm: true });
      await refreshTrash(); $("trashStatus").textContent = result.message || "本地回收区已清空，现有曲谱与脚本未改变。";
    } catch (e) { $("trashStatus").textContent = e.message; }
    finally { await refreshTrash().catch(() => {}); }
  };
  $("refreshLibrary").onclick = homeView;
  $("homeLogin").onclick = () => { $("libraryDialog").showModal(); $("libraryStatus").textContent = "曲谱同步到公开 GitHub 曲库；AHK 制品在本机按曲目保留。"; };
  $("downloadArtifact").textContent = "定位文件";
  $("copyArtifactPath").onclick = async () => {
    const file = artifactPreview?.metadata?.absolutePath;
    if (!file) return;
    try {
      await navigator.clipboard.writeText(file);
      $("artifactActionStatus").textContent = "完整路径已复制，可粘贴到文件管理器地址栏。";
    } catch {
      $("artifactPath").focus(); $("artifactPath").select();
      $("artifactActionStatus").textContent = "路径已选中，请按 Ctrl+C 复制。";
    }
  };
  $("downloadArtifact").onclick = async () => {
    if (artifactPreview) {
      const preview = artifactPreview, meta = preview.metadata || {};
      $("downloadArtifact").disabled = true;
      $("artifactActionStatus").textContent = "正在打开文件管理器…";
      try {
        await libraryApi("artifacts/reveal", { name: meta.scoreName, id: meta.id });
        if (artifactPreview === preview) $("artifactActionStatus").textContent = "已打开脚本所在文件夹。";
      } catch (e) {
        if (artifactPreview === preview) $("artifactActionStatus").textContent = e.message;
      } finally { if (artifactPreview === preview) $("downloadArtifact").disabled = false; }
    }
  };
  mount();
  if (desktop) homeView();
  if (desktop && managedWindow) {
    libraryApi("lifecycle").then(result => {
      if (!result.shutdown) return;
      persist();
      window.close();
    }).catch(() => { /* A connection failure alone never closes the editor. */ });
  }
})();
