"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { Library, gitSha, safeName } = require("./library"), { createServer } = require("./server");
const github = require("./github");
const data = title => Buffer.from(JSON.stringify({ version: 1, title, bpm: 74, meter: "4/4", gap: 40,
  keys: ["ZXCVBNM", "ASDFGHJ", "QWERTYU"], tempos: [], lengths: [], voices: [{ id: "v", name: "声部", source: "0===" }] }, null, 2) + "\n");
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "score-library-"));
  t.after(async () => {
    const rel = path.relative(os.tmpdir(), root);
    assert.ok(!rel.startsWith("..") && !path.isAbsolute(rel) && path.basename(root).startsWith("score-library-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const state = { head: "a", files: new Map(), calls: [], login: github.OWNER, userId: 1,
    token: "test-secret", push: true, fork: null, pulls: new Map() };
  const remote = {
    repoPath: github.repoPath,
    credential: async () => state.token,
    snapshot: async () => ({ head: state.head, tree: "tree", files: [...state.files].map(([name, bytes]) => ({ path: `scores/${name}`, sha: gitSha(bytes) })) }),
    blob: async sha => [...state.files.values()].find(d => gitSha(d) === sha),
    api: async (route, options) => {
      state.calls.push({ route, options });
      assert.equal(options.token, state.token);
      const failure = state.fail?.(route, options);
      if (failure) throw failure;
      if (route === "/user") { assert.equal(options.method, "GET"); return { login: state.login, id: state.userId }; }
      if (route === github.repoPath) return { permissions: { push: state.push } };
      if (route === `/repos/${state.login}/${github.REPO}`) {
        if (state.fork) return state.fork;
        throw Object.assign(new Error("Fork not found"), { status: 404 });
      }
      if (route.endsWith("/forks")) {
        state.fork = { full_name: `${state.login}/${github.REPO}`, fork: true,
          parent: { full_name: `${github.OWNER}/${github.REPO}` } };
        return state.fork;
      }
      if (route.endsWith("/blobs")) return { sha: gitSha(Buffer.from(options.body.content, "base64")) };
      if (route.endsWith("/trees")) return { sha: "new-tree" };
      if (route.endsWith("/commits")) return { sha: "new-head" };
      if (route.endsWith("/git/refs")) return { ref: options.body.ref };
      if (route.includes("/refs/")) {
        assert.equal(options.body.force, false);
        if (route === `${github.repoPath}/git/refs/heads/main`) state.head = options.body.sha;
        return {};
      }
      if (route === `${github.repoPath}/pulls`) {
        const number = state.pulls.size + 1, head = options.body.head;
        const pr = { number, html_url: `https://github.com/${github.OWNER}/${github.REPO}/pull/${number}`, state: "open",
          base: { ref: "main", repo: { full_name: `${github.OWNER}/${github.REPO}` } },
          head: { ref: head.includes(":") ? head.split(":")[1] : head, sha: "new-head",
            repo: { full_name: head.includes(":") ? `${state.login}/${github.REPO}` : `${github.OWNER}/${github.REPO}` } } };
        state.pulls.set(number, pr); return pr;
      }
      if (route.startsWith(`${github.repoPath}/pulls/`)) {
        const pr = state.pulls.get(Number(route.split("/").at(-1)));
        if (pr) return pr;
        throw Object.assign(new Error("PR not found"), { status: 404 });
      }
      throw new Error(`Unexpected request: ${route}`);
    }
  };
  return { root, remote, state, library: new Library(root, remote) };
}
test("curve saves use expected hash; filenames and invalid JSON cannot escape scores", async t => {
  const { library, root } = await fixture(t);
  const project = JSON.parse(data("第一版"));
  const saved = await library.save("曲谱.score.json", project);
  assert.ok(saved.sha); assert.equal((await library.list()).length, 1);
  await assert.rejects(() => library.save("曲谱.score.json", project), /同名/);
  await library.save("曲谱.score.json", { ...project, title: "第二版" }, saved.sha);
  assert.equal((await library.read("曲谱.score.json")).project.title, "第二版");
  for (const name of ["../secret.score.json", "a/b.score.json", "C:foo.score.json", ".score.json", "NUL.score.json"])
    assert.throws(() => safeName(name));
  await assert.rejects(() => library.save("bad.score.json", {}));
  assert.equal((await fs.readdir(path.join(root, "scores"))).length, 1);
  assert.equal(safeName("secret base Ver..score.json"), "secret base Ver..score.json");
});
test("Windows case-insensitive names cannot create a remote library collision", async t => {
  const { library, state } = await fixture(t);
  state.files.set("A.score.json", data("remote"));
  await library.save("a.score.json", JSON.parse(data("local")));
  await assert.rejects(() => library.prepare(), /大小写/);
  await assert.rejects(() => library.update(), /大小写/);
});
test("anonymous update preserves local edits and saves both sides of true conflicts", async t => {
  const { library, state, root } = await fixture(t);
  state.files.set("a.score.json", data("remote initial"));
  let r = await library.update(); assert.equal(r.downloaded.length, 1);
  const local = await library.read("a.score.json");
  await library.save("a.score.json", JSON.parse(data("local edited")), local.sha);
  r = await library.update(); assert.equal(r.conflicts.length, 0);
  assert.equal((await library.read("a.score.json")).project.title, "local edited");
  state.files.set("a.score.json", data("remote edited")); state.head = "b";
  r = await library.update(); assert.deepEqual(r.conflicts, ["a.score.json"]);
  assert.equal((await library.read("a.score.json")).project.title, "local edited");
  assert.equal((await fs.readdir(path.join(root, ".local", "conflicts"))).length, 1);
  await assert.rejects(() => library.prepare(), /远程已修改/);
});
test("upload requires review then uses one atomic non-forced commit; stale reviews cannot overwrite", async t => {
  const { library, state } = await fixture(t);
  await library.save("new.score.json", JSON.parse(data("new")));
  const preview = await library.prepare();
  assert.deepEqual(preview.changes, [{ name: "new.score.json", action: "新增" }]);
  assert.deepEqual(state.calls.map(c => c.route), ["/user"]);
  assert.equal(preview.submission, "direct"); assert.equal(preview.actor, github.OWNER);
  assert.ok(!JSON.stringify(preview).includes("test-secret"));
  const r = await library.upload(preview.id); assert.equal(r.commit, "new-head");
  assert.equal(state.calls.filter(c => c.route.endsWith("/commits")).length, 1);
  await assert.rejects(() => library.upload(preview.id), /过期/);
  state.files.set("new.score.json", data("new"));
  const local = await library.read("new.score.json");
  await library.save("new.score.json", JSON.parse(data("changed")), local.sha);
  const second = await library.prepare();
  state.head = "another-head";
  await assert.rejects(() => library.upload(second.id), /远程在预览后/);
});
test("owner detection ignores login case and revalidates the actual token before the main write", async t => {
  const { library, state } = await fixture(t);
  state.login = "iNeLlA12138";
  const saved = await library.save("owner.score.json", JSON.parse(data("owner")));
  const preview = await library.prepare();
  assert.equal(preview.submission, "direct"); assert.equal(preview.actor, state.login);
  assert.deepEqual(library.previews.get(preview.id).identity, { login: state.login, id: 1 });
  state.login = github.OWNER; state.token = "refreshed-secret";
  const result = await library.upload(preview.id);
  assert.deepEqual(result, { commit: "new-head", message: "已上传 1 首曲谱" });
  assert.deepEqual(state.calls.filter(c => c.route === "/user").map(c => c.options.token), ["test-secret", "refreshed-secret"]);
  const writes = state.calls.filter(c => c.options.method === "PATCH");
  assert.deepEqual(writes.map(c => [c.route, c.options.body]), [
    [`${github.repoPath}/git/refs/heads/main`, { sha: "new-head", force: false }]
  ]);
  const sync = await library.state();
  assert.equal(sync.base["owner.score.json"], saved.sha); assert.equal(sync.head, "new-head");
  assert.equal(sync.pendingPR, undefined);
  assert.ok(!JSON.stringify(result).includes(state.token));
});
for (const [first, second, changedId] of [
  [github.OWNER, "Friend", false], ["Friend", github.OWNER, false], ["Friend", "Other", false], ["Friend", "Friend", true]
]) test(`upload rejects changed identity ${first} -> ${second}${changedId ? " (new id)" : ""}`, async t => {
  const { library, state } = await fixture(t);
  state.login = first;
  await library.save("new.score.json", JSON.parse(data("new")));
  const preview = await library.prepare();
  state.login = second; if (changedId) state.userId++;
  await assert.rejects(() => library.upload(preview.id), /账号.*更换/);
  assert.ok(state.calls.every(c => c.route === "/user"));
  assert.deepEqual(await library.state(), { base: {} });
});
test("empty previews still revalidate identity without creating a branch or fork", async t => {
  const { library, state } = await fixture(t);
  state.login = "Friend"; state.push = false;
  let preview = await library.prepare();
  assert.deepEqual(await library.upload(preview.id), { submission: "pull_request", actor: "Friend", message: "没有需要上传的曲谱" });
  preview = await library.prepare(); state.login = "Other";
  await assert.rejects(() => library.upload(preview.id), /账号.*更换/);
  assert.ok(state.calls.every(c => c.route === "/user"));
});
test("preview uses authenticated /user and rejects failures or invalid accounts without mutation", async t => {
  const { library, state } = await fixture(t);
  await library.save("new.score.json", JSON.parse(data("new")));
  const error = Object.assign(new Error("Identity request denied"), { status: 401 });
  state.fail = route => route === "/user" && error;
  await assert.rejects(() => library.prepare(), e => e === error);
  assert.equal(library.previews.size, 0);
  state.fail = null;
  for (const login of [null, "", "../owner", "owner/repo", "name:branch", "has space"]) {
    state.login = login;
    await assert.rejects(() => library.prepare(), /账号无效/);
  }
  assert.ok(state.calls.every(c => c.route === "/user"));
});
for (const push of [true, false]) test(`${push ? "collaborator" : "fork contributor"} gets a pending PR while main baseline is untouched`, async t => {
  const { library, state, root, remote } = await fixture(t);
  state.login = "Friend"; state.push = push;
  state.files.set("existing.score.json", data("original"));
  await library.update();
  const before = await library.state(), original = await library.read("existing.score.json");
  await library.save("existing.score.json", JSON.parse(data("edited")), original.sha);
  await library.save("new.score.json", JSON.parse(data("new")));
  await fs.writeFile(path.join(root, "scores", "private.json"), '{"private":true}');
  await fs.writeFile(path.join(root, ".local", "private.txt"), "not a score");
  const preview = await library.prepare();
  assert.equal(preview.submission, "pull_request"); assert.equal(preview.actor, "Friend");
  assert.equal(preview.repository, `${github.OWNER}/${github.REPO}`); assert.equal(preview.public, true);
  assert.deepEqual(state.calls.map(c => c.route), ["/user"]);
  assert.equal(state.fork, null);
  const result = await library.upload(preview.id);
  assert.deepEqual(result.pullRequest, { number: 1, url: `https://github.com/${github.OWNER}/${github.REPO}/pull/1` });
  assert.equal(result.submission, "pull_request"); assert.equal(result.actor, "Friend");
  assert.equal(result.commit, "new-head"); assert.match(result.message, /等待.*审核/);
  const sync = await library.state();
  assert.deepEqual(sync.base, before.base); assert.equal(sync.head, before.head); assert.equal(state.head, "a");
  assert.deepEqual(sync.pendingPR.pullRequest, result.pullRequest);
  assert.equal(sync.pendingPR.commit, result.commit); assert.ok(sync.pendingPR.fingerprint);
  const source = push ? github.repoPath : `/repos/Friend/${github.REPO}`;
  assert.deepEqual(state.calls.find(c => c.route === `${source}/git/refs`).options.body,
    { ref: `refs/heads/${result.branch}`, sha: "a" });
  assert.deepEqual(state.calls.find(c => c.route.endsWith("/git/trees")).options.body,
    { base_tree: "tree", tree: preview.changes.map(({ name }) => ({
      path: `scores/${name}`, mode: "100644", type: "blob",
      sha: name === "existing.score.json" ? gitSha(data("edited")) : gitSha(data("new"))
    })) });
  const post = state.calls.find(c => c.route.endsWith("/pulls"));
  assert.equal(post.options.body.base, "main");
  assert.equal(post.options.body.head, push ? result.branch : `Friend:${result.branch}`);
  assert.ok(!state.calls.some(c => c.options.method === "PATCH" && c.route.endsWith("/main")));
  assert.ok(!JSON.stringify([preview, result, sync]).includes("test-secret"));
  assert.ok(!JSON.stringify(sync).includes('"content"'));
  const previousCalls = state.calls.length;
  const restarted = new Library(root, remote), repeated = await restarted.prepare();
  const again = await restarted.upload(repeated.id);
  assert.deepEqual(again, result);
  assert.deepEqual(state.calls.slice(previousCalls).map(c => c.route), ["/user", "/user", `${github.repoPath}/pulls/1`]);
  assert.equal(state.pulls.size, 1);
  assert.deepEqual((await restarted.state()).base, before.base);
});
test("closed pending PR and changed score bytes create new unique branches without advancing main", async t => {
  const { library, state } = await fixture(t);
  state.login = "Friend";
  const saved = await library.save("new.score.json", JSON.parse(data("first")));
  const first = await library.upload((await library.prepare()).id);
  state.pulls.get(1).state = "closed";
  const second = await library.upload((await library.prepare()).id);
  assert.notEqual(first.branch, second.branch); assert.equal(second.pullRequest.number, 2);
  await library.save("new.score.json", JSON.parse(data("changed")), saved.sha);
  const third = await library.upload((await library.prepare()).id);
  assert.notEqual(second.branch, third.branch); assert.equal(third.pullRequest.number, 3);
  assert.deepEqual((await library.state()).base, {}); assert.equal(state.head, "a");
});
test("contributor local or upstream changes after preview fail before creating any branch", async t => {
  const { library, state } = await fixture(t);
  state.login = "Friend"; state.push = false;
  const saved = await library.save("new.score.json", JSON.parse(data("new")));
  let preview = await library.prepare();
  await library.save("new.score.json", JSON.parse(data("changed")), saved.sha);
  await assert.rejects(() => library.upload(preview.id), /曲谱发生变化/);
  preview = await library.prepare(); state.head = "advanced";
  await assert.rejects(() => library.upload(preview.id), /远程在预览后/);
  assert.ok(state.calls.every(c => c.route === "/user")); assert.equal(state.fork, null);
});
for (const stage of ["/user", "/git/refs", "/git/blobs", "/git/trees", "/git/commits", "/pulls"]) {
  test(`contributor failure at ${stage} preserves sync state and releases the lock`, async t => {
    const { library, state, root } = await fixture(t);
    state.login = "Friend"; state.files.set("existing.score.json", data("original"));
    await library.update();
    const syncBefore = await fs.readFile(library.stateFile, "utf8");
    await library.save("new.score.json", JSON.parse(data("new")));
    const preview = await library.prepare(), error = Object.assign(new Error("Mock request denied"), { status: 403 });
    state.fail = route => route.endsWith(stage) && error;
    await assert.rejects(() => library.upload(preview.id), e => e === error);
    assert.equal(await fs.readFile(path.join(root, ".local", "sync.json"), "utf8"), syncBefore);
    assert.equal(library.busy, false); assert.equal(state.head, "a");
    assert.ok(!state.calls.some(c => c.options.method === "PATCH" && c.route.endsWith("/main")));
  });
}
test("owner rejected main update does not advance the local baseline", async t => {
  const { library, state } = await fixture(t);
  await library.save("new.score.json", JSON.parse(data("new")));
  const preview = await library.prepare(), error = Object.assign(new Error("Main advanced"), { status: 422 });
  state.fail = (route, options) => options.method === "PATCH" && error;
  await assert.rejects(() => library.upload(preview.id), e => e === error);
  assert.deepEqual(await library.state(), { base: {} }); assert.equal(state.head, "a");
});
test("remote invalid content aborts update before writing any downloaded file", async t => {
  const { library, state } = await fixture(t);
  state.files.set("good.score.json", data("good")); state.files.set("bad.score.json", Buffer.from("{}"));
  await assert.rejects(() => library.update());
  assert.deepEqual(await library.list(), []);
});
test("local HTTP API rejects cross origin, missing token, traversal and writes without authorization", async t => {
  const { root } = await fixture(t);
  await fs.writeFile(path.join(root, "index.html"), "<!doctype html><title>test</title>");
  const { server, token } = createServer(root);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base)).status, 200);
  assert.equal((await fetch(base + "/api/list")).status, 403);
  const headers = { "X-Score-Token": token, "Content-Type": "application/json" };
  assert.equal((await fetch(base + "/api/list", { headers: { ...headers, Origin: "https://evil.test" } })).status, 403);
  const save = await fetch(base + "/api/save", { method: "POST", headers, body: JSON.stringify({ name: "a.score.json", project: JSON.parse(data("saved")) }) });
  assert.equal(save.status, 200);
  const list = await (await fetch(base + "/api/list", { headers })).json();
  assert.equal(list.files[0].title, "saved");
  assert.equal((await fetch(base + "/api/read?name=../secret.score.json", { headers })).status, 400);
  assert.equal((await fetch(base + "/desktop/github.js", { headers })).status, 404);
});
