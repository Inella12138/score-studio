"use strict";
const crypto = require("node:crypto"), { setTimeout: delay } = require("node:timers/promises");
const github = require("./github");
const upstream = `${github.OWNER}/${github.REPO}`, repoPath = github.repoPath;
function account(login) {
  if (typeof login !== "string" || !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(login) || login.includes("--"))
    throw new Error("GitHub 账号无效，请重新登录");
  return login;
}
async function identity(api, token) {
  const user = await api("/user", { method: "GET", token });
  return { login: account(user?.login), id: user.id };
}
function sameAccount(first, second) {
  return first.login.toLowerCase() === second.login.toLowerCase() && first.id === second.id;
}
function fingerprint(changes) {
  const entries = changes.map(({ name, data }) => {
    if (typeof name !== "string" || !name.endsWith(".score.json") || name.length > 180 || name.startsWith(".") ||
        /[<>:"/\\|?*\x00-\x1f]/.test(name) || !Buffer.isBuffer(data))
      throw new Error("只能提交预览中的 scores 曲谱 JSON 文件");
    return [name, crypto.createHash("sha256").update(data).digest("hex")];
  }).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (!entries.length || entries.length > 100 || new Set(entries.map(([name]) => name.toLowerCase())).size !== entries.length)
    throw new Error("待提交曲谱清单无效");
  return crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}
async function ready(request, wait) {
  for (let attempt = 0; ; attempt++) {
    try { return await request(); }
    catch (e) {
      if (![404, 409].includes(e.status) || attempt === 4) throw e;
      await wait(250 * 2 ** attempt);
    }
  }
}
function checkFork(repo, actor) {
  const expected = `${actor}/${github.REPO}`.toLowerCase();
  if (repo?.full_name?.toLowerCase() !== expected || repo.fork !== true ||
      ![repo.parent?.full_name, repo.source?.full_name].some(name => name?.toLowerCase() === upstream.toLowerCase()))
    throw new Error("同名 GitHub 仓库不是共享曲库的 fork，已停止上传；请先处理仓库名称冲突");
}
function pullRequest(pr) {
  const number = pr?.number, url = pr?.html_url;
  if (!Number.isSafeInteger(number) || number < 1 || typeof url !== "string" ||
      url.toLowerCase() !== `https://github.com/${upstream}/pull/${number}`.toLowerCase())
    throw new Error("GitHub 未返回有效的 Pull Request，请在仓库确认提交状态后重试");
  return { number, url };
}
function result(actor, branch, commit, repository, pr) {
  return { submission: "pull_request", actor, branch, commit, repository, pullRequest: pullRequest(pr),
    message: "曲谱已提交 Pull Request，等待仓库所有者审核合并；共享曲库尚未更新。" };
}
async function submit({ api, token, actor, snapshot, changes, pending, wait = delay }) {
  account(actor);
  const key = fingerprint(changes), forkName = `${actor}/${github.REPO}`;
  // Only reuse our recorded branch when GitHub still reports the same open PR and commit.
  if (pending?.actor?.toLowerCase() === actor.toLowerCase() && pending.fingerprint === key &&
      typeof pending.branch === "string" && pending.branch.startsWith(`score-studio/${actor.toLowerCase()}-`) &&
      Number.isSafeInteger(pending.pullRequest?.number) && pending.pullRequest.number > 0 &&
      [upstream.toLowerCase(), forkName.toLowerCase()].includes(pending.repository?.toLowerCase())) {
    let pr;
    try { pr = await api(`${repoPath}/pulls/${pending.pullRequest.number}`, { token }); }
    catch (e) { if (e.status !== 404) throw e; }
    if (pr?.state === "open" && pr.base?.ref === github.BRANCH &&
        pr.base.repo?.full_name?.toLowerCase() === upstream.toLowerCase() &&
        pr.head?.ref === pending.branch && pr.head.sha === pending.commit &&
        pr.head.repo?.full_name?.toLowerCase() === pending.repository.toLowerCase())
      return result(actor, pending.branch, pending.commit, pending.repository, pr);
  }
  const permissions = await api(repoPath, { token });
  const collaborator = permissions.permissions?.push === true;
  let source = repoPath, repository = upstream;
  if (!collaborator) {
    source = `/repos/${forkName}`; repository = forkName;
    let fork;
    try { fork = await api(source, { token }); }
    catch (e) {
      if (e.status === 404) {
        // Fork creation is deliberately reached only from explicit upload, never preview.
        try { await api(`${repoPath}/forks`, { method: "POST", token }); }
        catch (creationError) { if (![404, 409].includes(creationError.status)) throw creationError; }
      } else if (e.status !== 409) throw e;
      fork = await ready(() => api(source, { token }), wait);
    }
    checkFork(fork, actor);
  }
  const branch = `score-studio/${actor.toLowerCase()}-${Date.now()}-${crypto.randomUUID()}`;
  const createBranch = () => api(`${source}/git/refs`, { method: "POST", token,
    body: { ref: `refs/heads/${branch}`, sha: snapshot.head } });
  if (collaborator) await createBranch();
  else await ready(createBranch, wait);
  const tree = [];
  for (const f of changes) {
    const blob = await api(`${source}/git/blobs`, { method: "POST", token,
      body: { encoding: "base64", content: f.data.toString("base64") } });
    tree.push({ path: `scores/${f.name}`, mode: "100644", type: "blob", sha: blob.sha });
  }
  // Forks share upstream objects; never refresh or write the fork's default branch.
  const newTree = await api(`${source}/git/trees`, { method: "POST", token, body: { base_tree: snapshot.tree, tree } });
  const title = `更新曲库：${changes.length} 首曲谱`;
  const commit = await api(`${source}/git/commits`, { method: "POST", token,
    body: { message: title, tree: newTree.sha, parents: [snapshot.head] } });
  await api(`${source}/git/refs/heads/${branch}`, { method: "PATCH", token, body: { sha: commit.sha, force: false } });
  const pr = await api(`${repoPath}/pulls`, { method: "POST", token,
    body: { title, base: github.BRANCH, head: collaborator ? branch : `${actor}:${branch}`,
      body: "通过简谱工坊提交预览中确认的曲谱 JSON，等待所有者审核合并。" } });
  return result(actor, branch, commit.sha, repository, pr);
}
module.exports = { account, identity, sameAccount, fingerprint, submit };
