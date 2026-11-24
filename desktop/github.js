"use strict";
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);
const OWNER = "Inella12138", REPO = "score-studio", BRANCH = "main";
async function credential() {
  return new Promise((resolve, reject) => {
    const child = require("node:child_process").spawn("git", ["credential", "fill"], {
      windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let out = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error("读取 GitHub 凭据超时，请重新登录后重试")); }, 30000);
    child.stdin.on("error", () => {});
    child.stdout.on("data", data => out += data);
    child.stderr.resume();
    child.on("error", () => { clearTimeout(timeout); reject(new Error("上传需要安装 Git for Windows 并登录 GitHub；更新曲库不需要登录。")); });
    child.on("close", code => {
      clearTimeout(timeout);
      const line = out.split(/\r?\n/).find(s => s.startsWith("password="));
      if (code || !line) return reject(new Error("尚未登录 GitHub，请先点“GitHub 登录”。"));
      resolve(line.slice(9));
    });
    child.stdin.end("protocol=https\nhost=github.com\n\n");
  });
}
async function api(route, { method = "GET", body, token, raw } = {}) {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "Score-Studio",
    "X-GitHub-Api-Version": "2022-11-28" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`https://api.github.com${route}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(45000)
  });
  if (!response.ok) {
    const error = new Error(`GitHub 请求失败 (${response.status})，请检查网络、权限或请求频率。`);
    error.status = response.status; throw error;
  }
  if (response.status === 204) return null;
  return raw ? response.text() : response.json();
}
const repoPath = `/repos/${OWNER}/${REPO}`;
async function snapshot(token) {
  const ref = await api(`${repoPath}/git/ref/heads/${BRANCH}`, { token });
  const commit = await api(`${repoPath}/git/commits/${ref.object.sha}`, { token });
  const tree = await api(`${repoPath}/git/trees/${commit.tree.sha}?recursive=1`, { token });
  if (tree.truncated) throw new Error("远程曲库目录过大，未继续同步。");
  return { head: ref.object.sha, tree: commit.tree.sha, files: tree.tree.filter(e => e.type === "blob" && /^scores\/[^/]+\.score\.json$/i.test(e.path)) };
}
async function blob(sha, token) {
  const data = await api(`${repoPath}/git/blobs/${sha}`, { token });
  if (data.encoding !== "base64" || data.size > 4 * 1024 * 1024) throw new Error("远程曲谱格式或大小不支持");
  return Buffer.from(data.content.replace(/\s/g, ""), "base64");
}
async function login() {
  // Browser authorization stays in Git Credential Manager; no token reaches the page.
  try { await exec("git", ["credential-manager", "github", "login", "--browser"], { windowsHide: true, timeout: 300000 }); }
  catch { throw new Error("GitHub 登录未完成；上传需要 Git for Windows 与 Git Credential Manager，请重试浏览器授权。"); }
  const token = await credential();
  const user = await api("/user", { token });
  return { login: user.login };
}
module.exports = { credential, api, snapshot, blob, login, OWNER, REPO, BRANCH, repoPath };
