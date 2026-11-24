"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { account, identity, sameAccount, fingerprint, submit } = require("./contributions");
const github = require("./github");
const upstream = `${github.OWNER}/${github.REPO}`, repoPath = github.repoPath, forkPath = `/repos/Friend/${github.REPO}`;
const error = status => Object.assign(new Error(`Mock GitHub failure (${status})`), { status });
const score = (name = "new.score.json", content = '{"title":"reviewed"}') => ({ name, data: Buffer.from(content) });
const validFork = () => ({ full_name: `Friend/${github.REPO}`, fork: true, parent: { full_name: upstream } });
function fixture({ push = true, fork = validFork() } = {}) {
  const state = { calls: [], waits: [], push, fork, branches: new Map(), pulls: new Map() };
  const api = async (route, options = {}) => {
    state.calls.push({ route, options });
    assert.equal(options.token, "mock-token");
    const failure = state.fail?.(route, options);
    if (failure) throw failure;
    if (route === repoPath) return { permissions: { push: state.push } };
    if (route === forkPath) { if (!state.fork) throw error(404); return state.fork; }
    if (route === `${repoPath}/forks`) { state.fork = validFork(); return state.fork; }
    if (route.endsWith("/git/refs")) {
      assert.equal(options.method, "POST"); assert.equal(options.body.sha, "reviewed-head");
      assert.deepEqual(Object.keys(options.body).sort(), ["ref", "sha"]);
      if (state.branches.has(options.body.ref)) throw error(422);
      state.branches.set(options.body.ref, options.body.sha); return {};
    }
    if (route.endsWith("/git/blobs")) return { sha: `blob-${state.calls.length}` };
    if (route.endsWith("/git/trees")) return { sha: "new-tree" };
    if (route.endsWith("/git/commits")) return { sha: "new-commit" };
    if (route.includes("/git/refs/heads/")) {
      assert.equal(options.method, "PATCH"); assert.equal(options.body.force, false);
      assert.ok(!route.endsWith("/main")); return {};
    }
    if (route === `${repoPath}/pulls`) {
      const number = state.pulls.size + 1, head = options.body.head;
      const pr = { number, html_url: `https://github.com/${upstream}/pull/${number}`, state: "open",
        base: { ref: "main", repo: { full_name: upstream } },
        head: { ref: head.includes(":") ? head.split(":")[1] : head, sha: "new-commit",
          repo: { full_name: head.includes(":") ? `Friend/${github.REPO}` : upstream } } };
      state.pulls.set(number, pr); return pr;
    }
    if (route.startsWith(`${repoPath}/pulls/`)) {
      const pr = state.pulls.get(Number(route.split("/").at(-1)));
      if (!pr) throw error(404);
      return pr;
    }
    throw new Error(`Unexpected request ${route}`);
  };
  const args = { api, token: "mock-token", actor: "Friend", snapshot: { head: "reviewed-head", tree: "reviewed-tree" },
    changes: [score()], wait: async ms => { state.waits.push(ms); } };
  return { state, args };
}
test("identity comes from authenticated /user; account validation excludes route and ref injection", async () => {
  const calls = [], api = async (...args) => { calls.push(args); return { login: "Friend", id: 42, token: "never-return" }; };
  assert.deepEqual(await identity(api, "actual-secret"), { login: "Friend", id: 42 });
  assert.deepEqual(calls, [["/user", { method: "GET", token: "actual-secret" }]]);
  assert.ok(sameAccount({ login: "Friend", id: 42 }, { login: "fRiEnD", id: 42 }));
  assert.ok(!sameAccount({ login: "Friend", id: 42 }, { login: "Friend", id: 43 }));
  assert.ok(!sameAccount({ login: "Friend" }, { login: "Other" }));
  for (const login of [undefined, null, {}, 123, "", "../friend", "friend/repo", "friend:branch", "friend%2fmain",
    "friend\n", "-friend", "friend-", "friend--other", "a".repeat(40)])
    assert.throws(() => account(login), /账号无效/);
  for (const login of ["a", "friend-123", "a".repeat(39)]) assert.equal(account(login), login);
});
test("collaborator commits only reviewed scores on a new upstream branch and opens an upstream PR", async () => {
  const { state, args } = fixture();
  args.changes.push(score("曲目.score.json", '{"title":"second"}'));
  const r = await submit(args);
  assert.equal(r.submission, "pull_request"); assert.equal(r.actor, "Friend");
  assert.equal(r.repository, upstream); assert.equal(r.commit, "new-commit");
  assert.match(r.branch, /^score-studio\/friend-\d+-[a-f\d-]{36}$/);
  assert.deepEqual(r.pullRequest, { number: 1, url: `https://github.com/${upstream}/pull/1` });
  assert.match(r.message, /等待.*审核/); assert.ok(!JSON.stringify(r).includes("mock-token"));
  assert.ok(state.calls.every(c => c.route.startsWith(repoPath)));
  const branch = state.calls.find(c => c.route.endsWith("/git/refs"));
  assert.deepEqual(branch.options.body, { ref: `refs/heads/${r.branch}`, sha: args.snapshot.head });
  const blobs = state.calls.filter(c => c.route.endsWith("/git/blobs"));
  assert.deepEqual(blobs.map(c => c.options.body), args.changes.map(f => ({ encoding: "base64", content: f.data.toString("base64") })));
  assert.deepEqual(state.calls.find(c => c.route.endsWith("/git/trees")).options.body, {
    base_tree: "reviewed-tree", tree: args.changes.map((f, i) => ({
      path: `scores/${f.name}`, mode: "100644", type: "blob", sha: `blob-${3 + i}`
    }))
  });
  assert.deepEqual(state.calls.find(c => c.route.endsWith("/git/commits")).options.body, {
    message: "更新曲库：2 首曲谱", tree: "new-tree", parents: ["reviewed-head"]
  });
  assert.equal(state.calls.at(-2).route, `${repoPath}/git/refs/heads/${r.branch}`);
  assert.deepEqual(state.calls.at(-2).options.body, { sha: "new-commit", force: false });
  assert.equal(state.calls.at(-1).route, `${repoPath}/pulls`);
  assert.equal(state.calls.at(-1).options.body.head, r.branch);
  assert.equal(state.calls.at(-1).options.body.base, "main");
});
for (const existing of [true, false]) test(`noncollaborator ${existing ? "uses existing fork" : "creates fork on upload"} without touching either main`, async () => {
  const { state, args } = fixture({ push: false, fork: existing ? validFork() : null });
  const r = await submit(args);
  assert.equal(r.repository, `Friend/${github.REPO}`);
  assert.equal(state.calls.filter(c => c.route.endsWith("/forks")).length, existing ? 0 : 1);
  const mutations = state.calls.filter(c => ["POST", "PATCH"].includes(c.options.method));
  assert.ok(mutations.every(c => c.route.startsWith(forkPath) || ["/forks", "/pulls"].some(end => c.route === repoPath + end)));
  const create = state.calls.find(c => c.route.endsWith("/git/refs"));
  assert.equal(create.route, `${forkPath}/git/refs`); assert.equal(create.options.body.sha, "reviewed-head");
  assert.equal(state.calls.find(c => c.route.endsWith("/git/trees")).options.body.base_tree, "reviewed-tree");
  assert.deepEqual(state.calls.find(c => c.route.endsWith("/git/commits")).options.body.parents, ["reviewed-head"]);
  assert.equal(state.calls.at(-1).options.body.head, `Friend:${r.branch}`);
  assert.ok(!state.calls.some(c => /\/(main|merges|merge-upstream)$/.test(c.route)));
});
test("fork lookup and branch readiness retry 404/409 with bounded backoff and the same unique ref", async () => {
  const { state, args } = fixture({ push: false, fork: null });
  let reads = 0, refs = 0;
  state.fail = route => {
    if (route === forkPath && ++reads <= 3) return error(reads === 3 ? 409 : 404);
    if (route.endsWith("/git/refs") && ++refs <= 2) return error(refs === 1 ? 404 : 409);
  };
  const r = await submit(args);
  assert.equal(reads, 4); assert.equal(refs, 3);
  assert.deepEqual(state.waits, [250, 500, 250, 500]);
  assert.equal(state.calls.filter(c => c.route.endsWith("/forks")).length, 1);
  const creations = state.calls.filter(c => c.route.endsWith("/git/refs"));
  assert.equal(new Set(creations.map(c => c.options.body.ref)).size, 1);
  assert.equal(creations[0].options.body.ref, `refs/heads/${r.branch}`);
});
for (const status of [404, 409]) test(`fork readiness gives up on persistent ${status} without writing scores`, async () => {
  const { state, args } = fixture({ push: false });
  state.fail = route => route === forkPath && error(status);
  await assert.rejects(() => submit(args), e => e.status === status);
  assert.equal(state.calls.filter(c => c.route === forkPath).length, 6);
  assert.deepEqual(state.waits, [250, 500, 1000, 2000]);
  assert.ok(!state.calls.some(c => c.route.includes("/git/")));
});
test("fork creation conflict waits for the fork instead of repeatedly creating it", async () => {
  const { state, args } = fixture({ push: false, fork: null });
  state.fail = route => {
    if (route === `${repoPath}/forks`) { state.fork = validFork(); return error(409); }
  };
  await submit(args);
  assert.equal(state.calls.filter(c => c.route.endsWith("/forks")).length, 1);
});
test("fork network membership is checked before any branch or object mutation", async () => {
  for (const fork of [
    { full_name: `Friend/${github.REPO}`, fork: false },
    { ...validFork(), parent: { full_name: "Other/unrelated" } },
    { ...validFork(), full_name: `Other/${github.REPO}` }
  ]) {
    const { state, args } = fixture({ push: false, fork });
    await assert.rejects(() => submit(args), /不是.*fork/);
    assert.ok(state.calls.every(c => !c.options.method));
  }
  const { args } = fixture({ push: false, fork: { full_name: `friend/${github.REPO}`, fork: true,
    parent: { full_name: "Other/another-fork" }, source: { full_name: upstream.toLowerCase() } } });
  await submit(args);
});
test("existing branch creation collision fails without PATCH or forced retry", async () => {
  for (const push of [true, false]) {
    const { state, args } = fixture({ push });
    state.fail = route => route.endsWith("/git/refs") && error(422);
    await assert.rejects(() => submit(args), e => e.status === 422);
    assert.equal(state.calls.filter(c => c.route.endsWith("/git/refs")).length, 1);
    assert.ok(!state.calls.some(c => c.options.method === "PATCH" || c.route.endsWith("/git/blobs")));
    assert.deepEqual(state.waits, []);
  }
});
test("all writes use unique branches even for repeated identical uploads without pending state", async () => {
  const { state, args } = fixture();
  const a = await submit(args), b = await submit(args);
  assert.notEqual(a.branch, b.branch); assert.equal(state.branches.size, 2);
  assert.ok(!state.branches.has("refs/heads/main"));
});
test("identical pending PRs reuse GitHub's verified open commit without writes", async () => {
  for (const push of [true, false]) {
    const { state, args } = fixture({ push });
    const first = await submit(args);
    const pending = { ...first, fingerprint: fingerprint(args.changes) };
    const start = state.calls.length;
    assert.deepEqual(await submit({ ...args, pending }), first);
    assert.deepEqual(state.calls.slice(start).map(c => c.route), [`${repoPath}/pulls/1`]);
  }
});
test("pending PRs with closed, missing, changed or foreign GitHub heads cannot be reused", async () => {
  for (const change of [
    pr => { pr.state = "closed"; }, pr => { pr.head.sha = "someone-else-commit"; },
    pr => { pr.head.ref = "main"; }, pr => { pr.head.repo.full_name = "Other/repo"; },
    pr => { pr.base.ref = "another-branch"; }, pr => { pr.base.repo.full_name = "Other/repo"; },
    (pr, state) => { state.pulls.delete(1); }
  ]) {
    const { state, args } = fixture();
    const first = await submit(args), pending = { ...first, fingerprint: fingerprint(args.changes) };
    change(state.pulls.get(1), state);
    const next = await submit({ ...args, pending });
    assert.notEqual(next.branch, first.branch);
  }
});
test("pending reuse requires the same actor and exact score bytes, independent of list ordering", async () => {
  const { state, args } = fixture();
  args.changes.push(score("other.score.json", "{}"));
  assert.equal(fingerprint(args.changes), fingerprint(args.changes.slice().reverse()));
  const first = await submit(args), pending = { ...first, fingerprint: fingerprint(args.changes) };
  const start = state.calls.length;
  await submit({ ...args, pending: { ...pending, actor: "Other" } });
  assert.equal(state.calls[start].route, repoPath);
  const start2 = state.calls.length;
  await submit({ ...args, pending, changes: [score("new.score.json", '{"title":"changed"}')] });
  assert.equal(state.calls[start2].route, repoPath);
});
test("invalid account and paths are rejected before any requests", async () => {
  const { state, args } = fixture();
  await assert.rejects(() => submit({ ...args, actor: "../owner" }), /账号无效/);
  for (const name of ["../secret.score.json", "scores/song.score.json", "artifacts/test.ahk", ".hidden.score.json",
    "test.json", "test.score.json\n", "foo\\bar.score.json", "foo:bar.score.json"]) {
    await assert.rejects(() => submit({ ...args, changes: [score(name)] }), /只能提交/);
  }
  for (const changes of [[], [score(), score()], [score("A.score.json"), score("a.score.json")],
    [{ name: "new.score.json", data: "{}" }], Array.from({ length: 101 }, (_, n) => score(`${n}.score.json`))])
    await assert.rejects(() => submit({ ...args, changes }));
  assert.deepEqual(state.calls, []);
});
for (const stage of ["permission", "fork", "create fork", "branch", "blob", "tree", "commit", "patch", "PR", "pending lookup"]) {
  test(`request failure at ${stage} propagates without main writes or fallback`, async () => {
    const { state, args } = fixture({ push: !["fork", "create fork"].includes(stage), fork: stage === "create fork" ? null : validFork() });
    let pending;
    if (stage === "pending lookup") {
      const first = await submit(args);
      pending = { ...first, fingerprint: fingerprint(args.changes) };
      state.calls.length = 0;
    }
    const denied = error(403);
    const matches = {
      permission: route => route === repoPath, fork: route => route === forkPath,
      "create fork": route => route.endsWith("/forks"), branch: route => route.endsWith("/git/refs"),
      blob: route => route.endsWith("/git/blobs"), tree: route => route.endsWith("/git/trees"),
      commit: route => route.endsWith("/git/commits"), patch: (route, opts) => opts.method === "PATCH",
      PR: route => route.endsWith("/pulls"), "pending lookup": route => route.endsWith("/pulls/1")
    };
    state.fail = (route, options) => matches[stage](route, options) && denied;
    await assert.rejects(() => submit({ ...args, pending }), e => e === denied);
    assert.ok(!state.calls.some(c => c.route.endsWith("/main")));
    assert.deepEqual(state.waits, []);
    assert.ok(matches[stage](state.calls.at(-1).route, state.calls.at(-1).options));
  });
}
