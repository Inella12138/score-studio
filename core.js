(function (root) {
  "use strict";
  const DEFAULT_KEYS = ["ZXCVBNM", "ASDFGHJ", "QWERTYU"];
  const EPS = 1e-7;
  const METER = /^(?:[1-9]|[12]\d|3[0-2])\/(?:1|2|4|8|16|32)$/;
  const ruleScope = (r, field) => r.scope ?? (field === "tempos" || field === "modes" ? "onward" : "single");
  const ruleEnd = (r, field) => ruleScope(r, field) === "onward" ? Infinity :
    ruleScope(r, field) === "single" ? Number(r.bar) : Number(r.endBar);
  function resolveRule(rows, number, field) {
    let base = null, temporary = null;
    for (const r of rows) {
      if (Number(r.bar) > number || ruleEnd(r, field) < number) continue;
      if (ruleScope(r, field) === "onward") {
        if (!base || Number(r.bar) > Number(base.bar)) base = r;
      } else if (!temporary || ruleEnd(r, field) - Number(r.bar) < ruleEnd(temporary, field) - Number(temporary.bar)) temporary = r;
    }
    return temporary || base;
  }
  function barSettings(project, number) {
    const tempo = resolveRule(project.tempos, number, "tempos");
    const length = resolveRule(project.lengths, number, "lengths");
    const meterRule = resolveRule(project.lengths.filter(r => r.meter !== undefined), number, "lengths");
    const meter = meterRule?.meter ?? project.meter, [num, den] = meter.split("/").map(Number);
    return { bpm: Number(tempo?.bpm ?? project.bpm), meter,
      duration: length?.beats !== undefined ? fraction(length.beats) : num * 4 / den,
      customLength: length?.beats !== undefined, special: !!length };
  }
  function ruleTimeline(rows, field, count) {
    const onward = rows.filter(r => ruleScope(r, field) === "onward").slice().sort((a, b) => Number(a.bar) - Number(b.bar));
    const finite = rows.filter(r => ruleScope(r, field) !== "onward").slice()
      .sort((a, b) => Number(a.bar) - Number(b.bar) || ruleEnd(b, field) - ruleEnd(a, field));
    const timeline = [], stack = [];
    let a = 0, b = 0, base = null;
    for (let number = 1; number <= count; number++) {
      while (a < onward.length && Number(onward[a].bar) <= number) base = onward[a++];
      while (stack.length && ruleEnd(stack[stack.length - 1], field) < number) stack.pop();
      while (b < finite.length && Number(finite[b].bar) <= number) stack.push(finite[b++]);
      timeline.push(stack.length ? stack[stack.length - 1] : base);
    }
    return timeline;
  }
  function settingsTimeline(project, count) {
    const tempos = ruleTimeline(project.tempos, "tempos", count);
    const lengths = ruleTimeline(project.lengths, "lengths", count);
    const meters = ruleTimeline(project.lengths.filter(r => r.meter !== undefined), "lengths", count);
    return Array.from({ length: count }, (_, i) => {
      const meter = meters[i]?.meter ?? project.meter, [num, den] = meter.split("/").map(Number);
      return { bpm: Number(tempos[i]?.bpm ?? project.bpm), meter,
        duration: lengths[i]?.beats !== undefined ? fraction(lengths[i].beats) : num * 4 / den,
        customLength: lengths[i]?.beats !== undefined, special: !!lengths[i] };
    });
  }
  const fail = message => { throw new Error(message); };
  const positive = (v, label, max = 100000) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0 || n > max) fail(`${label}必须大于 0 且不超过 ${max}`);
    return n;
  };
  function fraction(v) {
    const s = String(v).trim();
    if (!/^\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?$/.test(s)) fail(`无效拍数：${s}`);
    const [a, b = "1"] = s.split("/");
    return positive(Number(a) / Number(b), "拍数", 128);
  }
  function durationNotation(duration) {
    if (Number.isInteger(duration)) return { halves: 0, dots: 0, extensions: duration - 1, exactDuration: null };
    for (let halves = 0; halves <= 8; halves++) for (let dots = 0; dots <= 2; dots++) {
      if (Math.abs((2 - 1 / 2 ** dots) / 2 ** halves - duration) < EPS)
        return { halves, dots, extensions: 0, exactDuration: null };
    }
    return { halves: Math.max(0, Math.ceil(-Math.log2(duration))), dots: 0,
      extensions: Math.max(0, Math.floor(duration) - 1), exactDuration: duration };
  }
  function normalizeBreaths(text) {
    return text.replace(/([^\s|])(\s*(?:\|\s*)?)\x60\s*(?=[0-7\[<(~{])/g,
      (_, previous, boundary) => previous + String.fromCharCode(96) + boundary);
  }
  function parseBar(text, depth = 0) {
    if (depth > 4) fail("时值分组最多嵌套四层");
    // Accept a breath typed before the next note; normalize it onto the preceding note.
    text = normalizeBreaths(text);
    let i = 0;
    const notes = [];
    const skip = () => { while (/\s/.test(text[i] || "") && i < text.length) i++; };
    function pitch() {
      const c = text[i++];
      if (!/[0-7]/.test(c || "")) fail(`第 ${i} 字符：需要音符 1～7 或休止 0`);
      if (c === "0") return { degree: 0, octave: 1 };
      let octave = 1;
      if (text[i] === "9") { octave = 0; i++; }
      else if (text[i] === "0") { octave = 2; i++; }
      return { degree: Number(c), octave };
    }
    function unit() {
      if (text[i] !== "[") return [pitch()];
      i++;
      const pitches = [];
      skip();
      while (i < text.length && text[i] !== "]") {
        pitches.push(pitch());
        skip();
      }
      if (text[i++] !== "]") fail("和弦缺少 ]");
      if (!pitches.length || pitches.some(p => !p.degree)) fail("和弦必须包含音符，不能包含休止符");
      const ids = pitches.map(p => `${p.octave}:${p.degree}`);
      if (new Set(ids).size !== ids.length) fail("和弦内包含重复音");
      return pitches;
    }
    function gracePrefix() {
      const grace = [];
      let graceGap = null;
      if (text[i] === "<") {
        i++; skip();
        while (i < text.length && text[i] !== ">") { grace.push(pitch()); skip(); }
        if (text[i++] !== ">") fail("倚音缺少 >");
        if (!grace.length || grace.some(p => !p.degree)) fail("倚音必须包含音符，不能包含休止符");
        if (text[i] === "(") {
          const end = text.indexOf(")", i);
          if (end < 0) fail("倚音间隔缺少 )");
          graceGap = positive(text.slice(i + 1, end), "倚音间隔（ms）", 10000);
          i = end + 1;
        }
        skip();
      }
      return { grace, graceGap };
    }
    while (i < text.length) {
      skip();
      if (i >= text.length) break;
      const at = i;
      if (text[i] === "{") {
        let level = 1, end = i + 1;
        for (; end < text.length && level; end++) {
          if (text[end] === "{") level++;
          else if (text[end] === "}") level--;
        }
        if (level) fail("共用时值分组缺少 }");
        const inner = parseBar(text.slice(i + 1, end - 1), depth + 1);
        if (!inner.length) fail("时值分组不能为空");
        i = end;
        let halves = 0;
        while (text[i] === "-") { halves++; i++; }
        if (!halves || halves > 8) fail("时值分组后需要 1～8 个 -，例如 {1234}--");
        const groupBreath = text[i] === String.fromCharCode(96);
        if (groupBreath) i++;
        for (const n of inner) {
          if (n.halves + halves > 8) fail("分组后的音符细分过多");
          notes.push({ ...n, at: at + 1 + n.at, duration: n.duration / 2 ** halves,
            tupletTotal: n.tupletTotal / 2 ** halves, halves: n.halves + halves,
            source: `{${n.source}}${"-".repeat(halves)}`,
            ...(!n.tuplet ? durationNotation(n.duration / 2 ** halves) : {}) });
        }
        if (groupBreath) {
          const last = notes[notes.length - 1];
          if (last.breath) fail("换气符号不能重复");
          last.breath = true;
          last.source += String.fromCharCode(96);
        }
        continue;
      }
      let tie = false;
      if (text[i] === "~") { tie = true; i++; }
      const { grace, graceGap } = gracePrefix();
      let groups = [], tuplet = false;
      const groupTies = [], groupGraces = [];
      if (text[i] === "(") {
        tuplet = true;
        i++; skip();
        while (i < text.length && text[i] !== ")") {
          const innerTie = text[i] === "~";
          if (innerTie) { i++; skip(); }
          const innerGrace = gracePrefix();
          const pitches = unit();
          if (innerTie && pitches.some(p => !p.degree)) fail("延音不能用于休止符");
          if (innerGrace.grace.length && (innerTie || pitches.some(p => !p.degree)))
            fail("倚音不能用于延音续音或休止符");
          groups.push(pitches); groupTies.push(innerTie); groupGraces.push(innerGrace); skip();
        }
        if (text[i++] !== ")") fail("三连音缺少 )");
        if (groups.length !== 3) fail("三连音括号内必须恰好有三个音或和弦");
      } else groups = [unit()];
      let duration = 1, ornament = "", gap = null, dots = 0, extensions = 0, halves = 0, breath = false;
      while (i < text.length) {
        const c = text[i];
        if (c === "-") { halves++; i++; }
        else if (c === "=") { extensions++; i++; }
        else if (c === ".") { dots++; i++; }
        else if (c === String.fromCharCode(96)) {
          if (breath) fail("换气符号不能重复");
          breath = true; i++;
        }
        else if (c === "'" || c === ";") {
          if (ornament) fail("一个音符只能有一个装饰音标记");
          ornament = c === "'" ? "wave" : "arp"; i++;
          if (text[i] === "(") {
            const end = text.indexOf(")", i);
            if (end < 0) fail("装饰音间隔缺少 )");
            gap = positive(text.slice(i + 1, end), "装饰音间隔（ms）", 10000);
            i = end + 1;
          }
        } else break;
      }
      if (halves && extensions) fail("同一音符不能混用 - 和 =");
      if (halves > 8 || dots > 2 || extensions > 127) fail("时值过长或细分过多");
      duration = (1 + extensions) / 2 ** halves * (2 - 1 / 2 ** dots);
      if (tuplet && (tie || ornament)) fail("三连音延音请将 ~ 写在括号内的音符前；暂不支持整组装饰音标记");
      if (ornament === "wave" && (groups[0].length !== 1 || !groups[0][0].degree)) fail("波浪音只能标在单音后");
      if (ornament === "arp" && groups[0].some(p => !p.degree)) fail("琶音不能包含休止符");
      if (tie && (ornament || groups[0].some(p => !p.degree))) fail("延音只支持普通单音或和弦");
      if (grace.length && (tie || ornament || tuplet || groups[0].some(p => !p.degree))) fail("倚音只能接普通主音或和弦，不能混用其他装饰音、延音或三连音");
      if (text[i] && !/[\s0-7[(~{<]/.test(text[i])) fail(`第 ${i + 1} 字符：不支持的符号 ${text[i]}`);
      const end = i;
      groups.forEach((pitches, part) => notes.push({
        pitches, duration: duration / groups.length, tie: tie || !!groupTies[part], ornament, gap,
        tuplet, tupletPart: part, tupletTotal: duration, at,
        source: text.slice(at, end), halves, dots, extensions, breath: breath && (!tuplet || part === groups.length - 1),
        grace: tuplet ? groupGraces[part].grace : grace,
        graceGap: tuplet ? groupGraces[part].graceGap : graceGap
      }));
    }
    return notes;
  }
  function splitBars(source) {
    const bars = source.replace(/\r/g, "").split("|");
    if (bars.length > 1 && !bars[0].trim()) bars.shift();
    if (bars.length > 1 && !bars[bars.length - 1].trim()) bars.pop();
    return bars;
  }
  function parallelParts(source) {
    if (!source.includes("&")) return null;
    let text = source.trim();
    const breath = text.endsWith(String.fromCharCode(96));
    if (breath) text = text.slice(0, -1).trimEnd();
    if (!text.startsWith("{") || !text.endsWith("}")) fail("并行分支必须独占整小节，写作 { … & … }");
    const parts = []; let start = 1, depth = 0;
    for (let i = 1; i < text.length - 1; i++) {
      const c = text[i];
      if (c === "{") depth++;
      if (c === "}") { depth--; if (depth < 0) fail("并行块后不能追加普通音符"); }
      if (c === "&") {
        if (depth !== 0) fail("暂不支持嵌套并行分支");
        parts.push(text.slice(start, i).trim()); start = i + 1;
      }
    }
    if (depth !== 0) fail("并行分支括号不匹配");
    parts.push(text.slice(start, -1).trim());
    if (parts.length < 2 || parts.length > 8 || parts.some(p => !p)) fail("并行小节需要 2～8 条非空分支");
    // An external breath belongs to lane 0, which continues into ordinary bars.
    if (breath) parts[0] += String.fromCharCode(96);
    return parts;
  }
  function validateProject(p) {
    if (!p || typeof p !== "object" || p.version !== 1) fail("项目格式或版本不支持");
    if (typeof p.title !== "string" || p.title.length > 200) fail("曲名格式无效");
    positive(p.bpm, "BPM", 400);
    if (typeof p.meter !== "string" || !METER.test(p.meter)) fail("拍号无效，例如 4/4 或 6/8");
    positive(p.gap, "默认装饰音间隔", 10000);
    if (!Array.isArray(p.keys) || p.keys.length !== 3 || p.keys.some(row => typeof row !== "string" || !/^[a-zA-Z]{7}$/.test(row))) fail("每个八度需要 7 个英文字母键位");
    if (new Set(p.keys.join("").toUpperCase()).size !== 21) fail("21 个琴键不能重复");
    if (!Array.isArray(p.voices) || !p.voices.length || p.voices.length > 16) fail("声部数量应为 1～16");
    const ids = new Set();
    for (const v of p.voices) {
      if (!v || typeof v.id !== "string" || ids.has(v.id) || typeof v.name !== "string" ||
        typeof v.source !== "string" || v.source.length > 200000) fail("声部格式无效或内容过长");
      ids.add(v.id);
    }
    for (const field of ["tempos", "lengths", ...(p.modes !== undefined ? ["modes"] : [])]) {
      if (!Array.isArray(p[field]) || p[field].length > 10000) fail("小节设置格式无效");
      const used = new Set();
      for (const r of p[field]) {
        if (!Number.isInteger(Number(r.bar)) || Number(r.bar) < 1 || Number(r.bar) > 10000) fail("小节编号应为 1～10000 的整数");
        const scope = ruleScope(r, field);
        if (!["single", "range", "onward"].includes(scope)) fail("生效范围无效");
        if (scope === "range" && (!Number.isInteger(Number(r.endBar)) || Number(r.endBar) < Number(r.bar) || Number(r.endBar) > 10000))
          fail("范围结束小节必须是不小于起始小节、且不超过 10000 的整数");
        const identity = `${Number(r.bar)}:${ruleEnd(r, field)}`;
        if (used.has(identity)) fail(`第 ${r.bar} 小节有重复的生效范围`);
        used.add(identity);
        if (field === "modes") {
          if (!["tap", "hold"].includes(r.mode)) fail("小节演奏模式必须为点按或按住");
        } else if (field === "tempos") positive(r.bpm, "变速 BPM", 400);
        else if (r.meter !== undefined) {
          if (typeof r.meter !== "string" || !METER.test(r.meter)) fail("特殊拍号无效，例如 2/4 或 6/8");
          if (r.beats !== undefined) fail("一条规则不能同时指定拍号与自定义拍数");
        } else fraction(r.beats);
      }
      const finite = p[field].filter(r => ruleScope(r, field) !== "onward")
        .slice().sort((a, b) => Number(a.bar) - Number(b.bar) || ruleEnd(b, field) - ruleEnd(a, field));
      const stack = [];
      for (const r of finite) {
        while (stack.length && ruleEnd(stack[stack.length - 1], field) < Number(r.bar)) stack.pop();
        if (stack.length && ruleEnd(r, field) > ruleEnd(stack[stack.length - 1], field))
          fail(`${field === "tempos" ? "曲速" : field === "modes" ? "演奏模式" : "节拍"}范围交叉重叠，请改为互不重叠或完全包含的范围`);
        stack.push(r);
      }
    }
    return p;
  }
  function autoBars(project, source) {
    validateProject(project);
    if (typeof source !== "string" || source.length > 200000) fail("声部内容过长或格式无效");
    const normalized = normalizeBreaths(source);
    const notes = normalized.includes("&") ? splitBars(normalized).flatMap(segment => {
      const branches = parallelParts(segment);
      return branches ? [{ parallelBranches: branches }] : parseBar(segment);
    }) : parseBar(normalized.replace(/\|/g, " "));
    if (!notes.length) fail("请先输入音符");
    const settings = settingsTimeline(project, 10000);
    const bars = [];
    let bar = [], index = 1, used = 0, splits = 0;
    const capacity = () => {
      if (index > 10000) fail("自动分小节最多支持 10000 小节");
      return settings[index - 1].duration;
    };
    const finish = () => {
      if (index > 10000) fail("自动分小节最多支持 10000 小节");
      // Keep shared-duration input compact when it has to be divided at a bar line.
      const compact = [];
      for (let i = 0; i < bar.length;) {
        const match = /^\{([\s\S]*)\}(-+)$/.exec(bar[i]);
        if (!match) { compact.push(bar[i++]); continue; }
        const parts = [match[1]], suffix = match[2]; i++;
        while (i < bar.length) {
          const next = /^\{([\s\S]*)\}(-+)$/.exec(bar[i]);
          if (!next || next[2] !== suffix) break;
          parts.push(next[1]); i++;
        }
        compact.push(`{${parts.join(" ")}}${suffix}`);
      }
      bars.push(compact.join(" ")); bar = []; used = 0; index++;
    };
    const add = (token, duration) => {
      const formatted = token.replace(/\[([^\]]*)\]/g, (_, inner) => {
        const pitches = inner.match(/[1-7][90]?/g);
        return `[${pitches.join(" ")}]`;
      });
      bar.push(formatted); used += duration;
      if (Math.abs(used - capacity()) < EPS) finish();
    };
    function splitToken(note, duration, continued) {
      const pitchText = p => `${p.degree}${p.degree ? p.octave === 0 ? "9" : p.octave === 2 ? "0" : "" : ""}`;
      const pitch = note.pitches.length === 1 ? pitchText(note.pitches[0]) : `[${note.pitches.map(pitchText).join("")}]`;
      const tokens = [];
      let remaining = duration, tie = continued || note.tie;
      while (remaining > EPS) {
        let piece = remaining, notation = durationNotation(piece);
        if (notation.exactDuration) {
          // Decompose unusual dyadic lengths exactly, never round timing.
          piece = 2 ** Math.floor(Math.log2(remaining));
          if (piece < 1 / 256 - EPS) fail(`第 ${index} 小节边界无法精确拆分此音符，请调整特殊小节长度`);
          notation = durationNotation(piece);
        }
        const rest = !note.pitches[0].degree;
        tokens.push(`${tie && !rest ? "~" : ""}${pitch}${"=".repeat(notation.extensions)}${"-".repeat(notation.halves)}${".".repeat(notation.dots)}`);
        remaining -= piece; tie = true;
      }
      return tokens.join(" ");
    }
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      if (n.parallelBranches) {
        if (used > EPS) fail(`并行块前的第 ${index} 小节尚未填满，请先补齐或设置特殊长度`);
        const formatted = n.parallelBranches.map((branch, branchIndex) => {
          const duration = parseBar(branch).reduce((sum, note) => sum + note.duration, 0);
          if (Math.abs(duration - capacity()) > EPS) fail(`第 ${index} 小节分支 ${branchIndex + 1} 实际 ${pretty(duration)} 拍，需要 ${pretty(capacity())} 拍`);
          return branch.replace(/\[([^\]]*)\]/g, (_, inner) => `[${inner.match(/[1-7][90]?/g).join(" ")}]`);
        });
        add(`{ ${formatted.join(" & ")} }`, capacity());
        continue;
      }
      if (n.tuplet && n.tupletPart !== 0) continue;
      const duration = n.tuplet ? n.tupletTotal : n.duration;
      const room = capacity() - used;
      if (duration <= room + EPS) { add(n.source, duration); continue; }
      if (n.tuplet || n.ornament || n.grace?.length)
        fail(`第 ${index} 小节剩 ${pretty(room)} 拍，${n.source} 跨过小节线；三连音或装饰音请手动调整，不会更改原文`);
      let remaining = duration, continued = false;
      while (remaining > EPS) {
        const piece = Math.min(remaining, capacity() - used);
        add(splitToken(n, piece, continued) + (n.breath && remaining - piece < EPS ? String.fromCharCode(96) : ""), piece);
        remaining -= piece; continued = true;
      }
      splits++;
    }
    const missing = bar.length ? capacity() - used : 0;
    if (bar.length) finish();
    const formatted = bars.map((text, i) => text + (i < bars.length - 1 ? " |" : "")).join("\n");
    if (formatted.length > 200000) fail("分小节后的文本过长，请分段处理");
    return { source: formatted, count: bars.length, missing, splits };
  }
  function compile(project) {
    const errors = [], warnings = [], voices = [], bars = [];
    try { validateProject(project); } catch (e) { return { errors: [{ message: e.message }], warnings, voices, bars }; }
    const texts = project.voices.map(v => splitBars(normalizeBreaths(v.source)));
    const count = Math.max(...texts.map(b => b.length));
    if (count > 10000) return { errors: [{ message: "曲谱最多支持 10000 小节" }], warnings, voices, bars };
    const timeline = settingsTimeline(project, count);
    let beat = 0, ms = 0;
    for (let j = 0; j < count; j++) {
      const settings = timeline[j], { bpm, meter, duration } = settings;
      bars.push({ number: j + 1, beat, ms, ...settings,
        tempoChange: j === 0 || bars[j - 1].bpm !== bpm,
        meterChange: j === 0 || bars[j - 1].meter !== meter });
      beat += duration; ms += duration * 60000 / bpm;
    }
    for (const [type, rows] of [["速度", project.tempos], ["长度", project.lengths]]) {
      for (const r of rows) if (Number(r.bar) > count) warnings.push({ message: `第 ${r.bar} 小节的${type}设置尚未用到` });
    }
    project.voices.forEach((voice, vi) => {
      const result = { ...voice, bars: [], branchBars: [], notes: [] };
      let previousByBranch = [];
      for (let j = 0; j < count; j++) {
        const bar = bars[j], source = texts[vi][j], loc = { voice: vi, bar: j, name: voice.name };
        if (source === undefined) { errors.push({ ...loc, message: "缺少小节，请填写音符或休止符" }); result.bars.push([]); result.branchBars.push([[]]); previousByBranch = []; continue; }
        let branches;
        try { branches = (parallelParts(source) || [source]).map(part => parseBar(part)); }
        catch (e) { errors.push({ ...loc, message: e.message }); result.bars.push([]); result.branchBars.push([[]]); previousByBranch = []; continue; }
        const allNotes = [], nextPrevious = [];
        branches.forEach((notes, branch) => {
        let local = 0, previous = previousByBranch[branch] || null;
        notes.forEach(note => {
          note.branch = branch;
          note.bar = j; note.voice = vi; note.start = bar.beat + local; note.end = note.start + note.duration;
          note.keys = note.pitches.filter(p => p.degree).map(p => project.keys[p.octave][p.degree - 1].toLowerCase());
          note.identity = note.keys.slice().sort().join("");
          if (note.tie) {
            const continuesArpeggio = previous?.ornament === "arp" && note.keys.length === 1 &&
              previous.keys[previous.keys.length - 1] === note.keys[0];
            const samePlainNote = previous && !previous.ornament && previous.identity === note.identity;
            if (previous?.breath || (!samePlainNote && !continuesArpeggio) ||
              !note.identity || Math.abs(previous.end - note.start) > EPS) {
              errors.push({ ...loc, message: `延音 ${note.source} 前必须紧邻相同音高的普通音符、完整和弦或琶音末音` });
            } else {
              note.tieRoot = previous.tieRoot || previous;
              note.tieRoot.sustainEnd = note.end;
              note.tieRoot.sustainBreath = note.breath;
              note.tieFrom = previous;
            }
          }
          local += note.duration; previous = note; result.notes.push(note);
        });
        if (Math.abs(local - bar.duration) > EPS) errors.push({ ...loc, branch, message: `${branches.length > 1 ? `分支 ${branch + 1}：` : ""}实际 ${pretty(local)} 拍，需要 ${pretty(bar.duration)} 拍（${local < bar.duration ? "缺少" : "超出"} ${pretty(Math.abs(local - bar.duration))} 拍）` });
        nextPrevious[branch] = previous;
        allNotes.push(...notes);
        });
        previousByBranch = nextPrevious;
        result.bars.push(allNotes); result.branchBars.push(branches);
      }
      voices.push(result);
    });
    const timeAt = b => {
      if (b >= beat - EPS) return ms + (b - beat) * 60000 / bars[bars.length - 1].bpm;
      let lo = 0, hi = bars.length - 1;
      while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (bars[mid].beat <= b + EPS) lo = mid; else hi = mid - 1; }
      return bars[lo].ms + (b - bars[lo].beat) * 60000 / bars[lo].bpm;
    };
    return { errors, warnings, voices, bars, totalBeats: beat, totalMs: ms, timeAt };
  }
  function pretty(n) { return Number(n.toFixed(5)).toString(); }
  function beamDepth(note) {
    const base = note.tuplet ? note.tupletTotal / 2 : note.duration / (2 - 1 / 2 ** note.dots);
    return Math.max(0, Math.min(8, Math.ceil(-Math.log2(base) - EPS)));
  }
  function beamGroups(notes, bar, meter) {
    const [num, den] = meter.split("/").map(Number);
    const beatSize = den === 8 && num >= 6 && num % 3 === 0 ? 1.5 : 4 / den;
    const groups = [];
    let run = [];
    const finish = () => { if (run.length > 1) groups.push(run); run = []; };
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i], start = n.start - bar.beat, end = start + n.duration;
      const beat = Math.floor((start + EPS) / beatSize);
      const short = beamDepth(n) > 0 && n.pitches.every(p => p.degree) && end <= (beat + 1) * beatSize + EPS;
      if (!short) { finish(); continue; }
      const prev = run.length ? notes[run[run.length - 1]] : null;
      if (prev && (Math.floor((prev.start - bar.beat + EPS) / beatSize) !== beat ||
        Math.abs(prev.end - n.start) > EPS || prev.tuplet !== n.tuplet ||
        n.tuplet && n.tupletPart === 0)) finish();
      run.push(i);
    }
    finish();
    return groups;
  }
  function makeEvents(project, compiled, selected, mode) {
    const errors = compiled.errors.slice(), warnings = compiled.warnings.slice(), events = [], intervals = [];
    if (!["tap", "hold"].includes(mode)) errors.push({ message: "未知演奏模式" });
    if (errors.length) return { errors, warnings, events };
    const modeTimeline = ruleTimeline(project.modes || [], "modes", compiled.bars.length).map(r => r?.mode ?? mode);
    const modeEnds = [];
    for (let i = modeTimeline.length - 1; i >= 0; i--)
      modeEnds[i] = i === modeTimeline.length - 1 || modeTimeline[i] !== modeTimeline[i + 1] ?
        compiled.bars[i].beat + compiled.bars[i].duration : modeEnds[i + 1];
    const repeatGap = Number(project.repeatGapMs ?? 30), retain = Number(project.minHoldPercent ?? 80);
    if (modeTimeline.includes("hold")) {
      if (!Number.isFinite(repeatGap) || repeatGap < 0 || repeatGap > 1000) errors.push({ message: "重复音松键间隔应为 0～1000ms" });
      if (!Number.isFinite(retain) || retain < 1 || retain > 100) errors.push({ message: "前音最低保留比例应为 1～100%" });
    }
    const chosen = compiled.voices.filter(v => selected.includes(v.id));
    if (!chosen.length) errors.push({ message: "请至少选择一个声部" });
    if (errors.length) return { errors, warnings, events };
    for (const voice of chosen) for (const note of voice.notes) {
      const noteMode = modeTimeline[note.bar];
      const boundaryTie = note.tie && Math.abs(note.start - compiled.bars[note.bar].beat) < EPS &&
        note.bar > 0 && modeTimeline[note.bar - 1] !== noteMode;
      if (note.tie && !boundaryTie || !note.keys.length) continue;
      const chainRoot = note.tieRoot || note;
      const intendedEnd = chainRoot.sustainEnd || note.end;
      const cappedEnd = Math.min(intendedEnd, modeEnds[note.bar]);
      const start = compiled.timeAt(note.start), end = compiled.timeAt(cappedEnd);
      let keys = note.keys;
      if (noteMode === "hold") {
        if (note.ornament || note.grace?.length) {
          if (note.ornament === "arp") keys = keys.slice(-1);
          warnings.push({ voice: note.voice, bar: note.bar, message: `${voice.name}：${note.source} 已简化为${note.ornament === "arp" ? "琶音末音" : "主音"}，保持原时值` });
        }
        const intervalName = voice.branchBars?.[note.bar]?.length > 1 ? `${voice.name}（分支 ${note.branch + 1}）` : voice.name;
        for (const key of keys) intervals.push({ key, start, end, name: intervalName, bar: note.bar,
          releaseAt: (cappedEnd === intendedEnd && (chainRoot.sustainBreath ?? note.breath)) ? end - Math.min(repeatGap, (end - start) * (1 - retain / 100)) : undefined });
      } else {
        const gap = note.gap ?? Number(project.gap);
        let sequence = [keys.join("")];
        if (note.grace?.length) {
          const graceKeys = note.grace.map(p => project.keys[p.octave][p.degree - 1].toLowerCase());
          sequence = [...graceKeys, keys.join("")];
        }
        if (note.ornament === "arp") sequence = keys;
        if (note.ornament === "wave") {
          const p = note.pitches[0], octave = p.degree === 7 ? p.octave + 1 : p.octave;
          if (octave > 2) { errors.push({ voice: note.voice, bar: note.bar, message: "高音 7 的波浪音超出三个八度音域" }); continue; }
          const next = project.keys[octave][p.degree === 7 ? 0 : p.degree].toLowerCase();
          sequence = [keys[0], next, keys[0]];
        }
        const actualGap = note.grace?.length ? note.graceGap ?? Number(project.gap) : gap;
        if ((sequence.length - 1) * actualGap >= compiled.timeAt(note.end) - start - EPS) {
          errors.push({ voice: note.voice, bar: note.bar, message: `${voice.name}：${note.source} 的装饰音排不开，请减小间隔或延长时值` });
          continue;
        }
        sequence.forEach((k, i) => events.push({ t: start + i * actualGap, type: "tap", keys: k }));
      }
    }
    const byKey = new Map();
    intervals.sort((a, b) => a.start - b.start);
    for (const n of intervals) {
      const prev = byKey.get(n.key);
      if (prev && prev.end > n.start + EPS) errors.push({ bar: n.bar, message: `按住冲突：${prev.name} 第 ${prev.bar + 1} 小节与 ${n.name} 第 ${n.bar + 1} 小节重叠使用 ${n.key.toUpperCase()} 键` });
      if (prev && Math.abs(prev.end - n.start) <= EPS)
        prev.releaseAt = prev.end - Math.min(repeatGap, (prev.end - prev.start) * (1 - retain / 100));
      if (!prev || n.end > prev.end) byKey.set(n.key, n);
    }
    for (const n of intervals) events.push(
      { t: n.start, type: "down", keys: n.key },
      { t: n.releaseAt ?? n.end, type: "up", keys: n.key }
    );
    const priority = { up: 0, down: 1, tap: 2 };
    // Keep sub-millisecond durations positive; integer rounding can reorder down/up.
    events.forEach(e => e.t = Number(e.t.toFixed(6)));
    events.sort((a, b) => a.t - b.t || priority[a.type] - priority[b.type]);
    const merged = [];
    for (const e of events) {
      const prev = merged[merged.length - 1];
      if (prev && prev.t === e.t && prev.type === e.type) prev.keys = [...new Set(prev.keys + e.keys)].join("");
      else merged.push({ ...e });
    }
    return { errors, warnings, events: merged, totalMs: Math.ceil(compiled.totalMs) };
  }
  function ahk(project, plan, options = {}) {
    if (plan.errors.length) fail("曲谱仍有错误，不能导出");
    const schedule = options.schedule || "";
    if (schedule && !/^\d{14}$/.test(schedule)) fail("定时开始时间格式错误");
    const delaySeconds = Number(options.startDelay ?? project.startDelay ?? 3);
    if (!Number.isFinite(delaySeconds) || delaySeconds < 0 || delaySeconds > 60) fail("开演延迟应为 0～60 秒");
    const eventLines = plan.events.map(e => `    [${e.t}, "${e.type}", "${e.keys}"]`).join(",\n");
    return `#Requires AutoHotkey v2.0
#SingleInstance Force
; 与以管理员权限运行的钢琴软件保持一致。
if !A_IsAdmin {
    try {
        if A_IsCompiled
            Run '*RunAs "' A_ScriptFullPath '"'
        else
            Run '*RunAs "' A_AhkPath '" "' A_ScriptFullPath '"'
    } catch {
        MsgBox "未获得管理员权限，演奏脚本已退出。请允许权限请求后重新启动。"
    }
    ExitApp
}
; 简谱工坊生成。BPM 以四分音符为一拍；计时单位为毫秒。
; Ctrl+Enter 开始；Ctrl+Win+P 暂停/继续；Ctrl+Win+Esc 停止并释放琴键。
; 请先让钢琴窗口获得焦点。系统定时不提供跨机器自动校时。
SendMode "Input"
Persistent
Events := [
${eventLines}
]
SongDuration := ${plan.totalMs}
ScheduledTime := "${schedule}"
StartDelayMs := ${Math.round(delaySeconds * 1000)}
Running := false
Paused := false
NextEvent := 1
StartedAt := 0
PausedAt := 0
Held := Map()
SchedulePanel := 0
SchedulePicker := 0
ScheduleStatus := 0
ScheduleNodeButtons := []
ScheduleNodeTimes := []
OnExit ReleaseOnExit
if ScheduledTime != ""
    SetTimer CheckSchedule, 20

^Enter::StartPlayback()
^NumpadEnter::StartPlayback()
^#p::TogglePause()
^#t::OpenSchedulePanel()
^#Esc::StopPlayback()

OpenSchedulePanel(*) {
    global Running, SchedulePanel, SchedulePicker, ScheduleStatus, ScheduleNodeButtons
    if Running {
        MsgBox "请先停止演奏，再设置定时开始。"
        return
    }
    if !IsObject(SchedulePanel) {
        SchedulePanel := Gui(, "简谱工坊 · 定时开始")
        SchedulePanel.SetFont("s10", "Microsoft YaHei")
        SchedulePanel.AddText("w450", "电脑本地时间（两台机器需预先校时）")
        SchedulePicker := SchedulePanel.AddDateTime("w450", "yyyy-MM-dd HH:mm:ss")
        SchedulePanel.AddButton("xm w140", "当前时间 +30秒").OnEvent("Click", SetScheduleOffset.Bind(30))
        SchedulePanel.AddButton("x+10 w140", "当前时间 +1分钟").OnEvent("Click", SetScheduleOffset.Bind(60))
        SchedulePanel.AddButton("x+10 w140", "当前时间 +5分钟").OnEvent("Click", SetScheduleOffset.Bind(300))
        SchedulePanel.AddText("xm w450", "或选择统一的 5 秒节点（未来两分钟）：")
        Loop 24 {
            position := Mod(A_Index - 1, 3) = 0 ? "xm" : "x+10 yp"
            nodeButton := SchedulePanel.AddButton(position " w140 h28", "")
            nodeButton.OnEvent("Click", SelectScheduleNode.Bind(A_Index))
            ScheduleNodeButtons.Push(nodeButton)
        }
        ScheduleStatus := SchedulePanel.AddText("xm w450 r2", "")
        SchedulePanel.AddButton("xm w215 Default", "准备（保存并隐藏）").OnEvent("Click", ArmSchedule)
        SchedulePanel.AddButton("x+10 w225", "取消定时").OnEvent("Click", CancelSchedule)
        SchedulePanel.OnEvent("Close", HideSchedulePanel)
        SchedulePanel.OnEvent("Escape", HideSchedulePanel)
    }
    SchedulePicker.Value := A_Now
    RefreshScheduleNodes()
    SetTimer RefreshScheduleNodes, 1000
    RefreshScheduleStatus()
    SchedulePanel.Show()
}

RefreshScheduleNodes(*) {
    global ScheduleNodeButtons, ScheduleNodeTimes
    Critical
    now := A_Now
    times := BuildScheduleNodeTimes(now)
    for index, nodeButton in ScheduleNodeButtons {
        target := times[index]
        format := SubStr(target, 1, 8) = SubStr(now, 1, 8) ? "HH:mm:ss" : "MM-dd HH:mm:ss"
        nodeButton.Text := FormatTime(target, format)
    }
    ScheduleNodeTimes := times
}

BuildScheduleNodeTimes(now) {
    seconds := Integer(SubStr(now, 13, 2))
    first := DateAdd(now, 5 - Mod(seconds, 5), "Seconds")
    times := []
    Loop 24
        times.Push(DateAdd(first, (A_Index - 1) * 5, "Seconds"))
    return times
}

SelectScheduleNode(index, *) {
    global ScheduleNodeTimes, SchedulePicker
    Critical
    if index > ScheduleNodeTimes.Length
        return
    target := ScheduleNodeTimes[index]
    if target <= A_Now {
        RefreshScheduleNodes()
        MsgBox "该节点已过期，请重新选择。"
        return
    }
    SchedulePicker.Value := target
}

SetScheduleOffset(seconds, *) {
    global SchedulePicker
    SchedulePicker.Value := DateAdd(A_Now, seconds, "Seconds")
}

ArmSchedule(*) {
    global ScheduledTime, SchedulePicker, SchedulePanel, Running
    if Running
        return
    target := SchedulePicker.Value
    if target <= A_Now {
        MsgBox "请选择晚于当前时间的开演时刻。"
        return
    }
    ScheduledTime := target
    SetTimer CheckSchedule, 20
    RefreshScheduleStatus()
    SchedulePanel.Hide()
    SetTimer RefreshScheduleNodes, 0
    ToolTip "定时已准备，请切回钢琴窗口。Ctrl+Win+Esc 可取消。"
    SetTimer ClearNotice, -3000
}

RefreshScheduleStatus() {
    global ScheduledTime, ScheduleStatus
    if !IsObject(ScheduleStatus)
        return
    if ScheduledTime = ""
        ScheduleStatus.Text := "未设置定时；本次打开已填入当前时间。关闭窗口不取消已准备的定时。"
    else
        ScheduleStatus.Text := "等待开演：" FormatTime(ScheduledTime, "yyyy-MM-dd HH:mm:ss") "；剩余 " Max(0, DateDiff(ScheduledTime, A_Now, "Seconds")) " 秒"
}

CancelSchedule(*) {
    global ScheduledTime
    SetTimer CheckSchedule, 0
    ScheduledTime := ""
    ToolTip
    RefreshScheduleStatus()
}

HideSchedulePanel(*) {
    global SchedulePanel
    SchedulePanel.Hide()
    SetTimer RefreshScheduleNodes, 0
}

ClearNotice(*) {
    ToolTip
}

ClockMs() {
    static frequency := 0
    if !frequency
        DllCall("QueryPerformanceFrequency", "Int64*", &frequency)
    counter := 0
    DllCall("QueryPerformanceCounter", "Int64*", &counter)
    return counter * 1000 / frequency
}

CheckSchedule() {
    global ScheduledTime
    if ScheduledTime = ""
        return
    RefreshScheduleStatus()
    if A_Now >= ScheduledTime {
        SetTimer CheckSchedule, 0
        StartPlayback(true)
    }
}

StartPlayback(scheduled := false) {
    global Running, Paused, NextEvent, StartedAt, StartDelayMs, ScheduledTime, SchedulePanel
    if Running
        return
    SetTimer CheckSchedule, 0
    SetTimer ClearNotice, 0
    ScheduledTime := ""
    if IsObject(SchedulePanel)
        SchedulePanel.Hide()
    SetTimer RefreshScheduleNodes, 0
    Running := true
    Paused := false
    NextEvent := 1
    StartedAt := ClockMs() + (scheduled ? 0 : StartDelayMs)
    SetTimer Tick, 5
    Tick()
}

Tick() {
    global Events, Running, Paused, NextEvent, StartedAt, Held, SongDuration
    Critical
    if !Running || Paused
        return
    elapsed := ClockMs() - StartedAt
    if elapsed < 0 {
        ToolTip "准备演奏：" Ceil(-elapsed / 1000) " 秒"
        return
    }
    ToolTip
    while NextEvent <= Events.Length && Events[NextEvent][1] <= elapsed {
        event := Events[NextEvent]
        for key in StrSplit(event[3]) {
            if event[2] = "down" {
                Send "{" key " down}"
                Held[key] := true
            } else if event[2] = "up" {
                Send "{" key " up}"
                if Held.Has(key)
                    Held.Delete(key)
            } else
                Send "{" key "}"
        }
        NextEvent += 1
    }
    if NextEvent > Events.Length && elapsed >= SongDuration
        StopPlayback()
}

TogglePause() {
    global Running, Paused, PausedAt, StartedAt, Held
    Critical
    if !Running
        return
    if !Paused {
        PausedAt := ClockMs()
        Paused := true
        ToolTip "演奏已暂停"
        for key in Held
            Send "{" key " up}"
    } else {
        StartedAt += ClockMs() - PausedAt
        for key in Held
            Send "{" key " down}"
        Paused := false
    }
}

StopPlayback(*) {
    global Running, Paused, Held, ScheduledTime
    Critical
    SetTimer Tick, 0
    SetTimer CheckSchedule, 0
    SetTimer ClearNotice, 0
    ScheduledTime := ""
    RefreshScheduleStatus()
    Running := false
    Paused := false
    ToolTip
    for key in Held
        Send "{" key " up}"
    Held.Clear()
}

ReleaseOnExit(*) {
    StopPlayback()
}
`;
  }
  const api = { DEFAULT_KEYS, parseBar, splitBars, validateProject, compile, makeEvents, ahk, fraction, pretty, beamDepth, beamGroups, autoBars, barSettings };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ScoreCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
