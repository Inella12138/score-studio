"use strict";
const http = require("node:http"), fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const { Library } = require("./library"), github = require("./github");
const ROOT = path.resolve(__dirname, "..");
function createServer(root = ROOT) {
  const library = new Library(root), token = crypto.randomBytes(32).toString("hex");
  const assets = { "/": ["index.html", "text/html"], "/index.html": ["index.html", "text/html"],
    "/app.js": ["app.js", "application/javascript"], "/core.js": ["core.js", "application/javascript"], "/style.css": ["style.css", "text/css"] };
  const server = http.createServer(async (req, res) => {
    const json = (status, body) => { res.writeHead(status, { "Content-Type": "application/json;charset=utf-8" }); res.end(JSON.stringify(body)); };
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (req.headers.host !== `127.0.0.1:${server.address().port}`) return json(403, { error: "非法来源" });
    if (req.headers.origin && req.headers.origin !== origin) return json(403, { error: "非法来源" });
    try {
      const url = new URL(req.url, origin);
      if (assets[url.pathname] && req.method === "GET") {
        const [file, type] = assets[url.pathname]; res.setHeader("Content-Type", type + ";charset=utf-8");
        res.end(await fs.readFile(path.join(root, file))); return;
      }
      if (req.headers["x-score-token"] !== token) return json(403, { error: "请通过桌面应用重新打开编辑器" });
      let body = {};
      if (req.method === "POST") {
        let size = 0; const chunks = [];
        for await (const chunk of req) { size += chunk.length; if (size > 4 * 1024 * 1024 + 2000) throw new Error("请求过大"); chunks.push(chunk); }
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      }
      if (url.pathname === "/api/list" && req.method === "GET") return json(200, { files: await library.list(), repository: `${github.OWNER}/${github.REPO}` });
      if (url.pathname === "/api/read" && req.method === "GET") return json(200, await library.read(url.searchParams.get("name")));
      if (url.pathname === "/api/save" && req.method === "POST") return json(200, await library.save(body.name, body.project, body.expectedSha));
      if (url.pathname === "/api/update" && req.method === "POST") return json(200, await library.update());
      if (url.pathname === "/api/preview" && req.method === "POST") return json(200, await library.prepare());
      if (url.pathname === "/api/upload" && req.method === "POST") return json(200, await library.upload(body.id));
      if (url.pathname === "/api/login" && req.method === "POST") return json(200, await github.login());
      return json(404, { error: "未找到" });
    } catch (error) {
      json(400, { error: error.status ? `GitHub 请求失败 (${error.status})，请检查网络和权限；若远程已变化，请先更新曲库。` :
        error.name === "TimeoutError" ? "网络超时，本地曲谱未被覆盖，请稍后重试" : error.message });
    }
  });
  server.requestTimeout = 300000;
  return { server, library, token };
}
if (require.main === module) {
  const { server, token } = createServer();
  // Never start a second writable service on a random origin.
  server.on("error", () => { console.error("本地端口被占用，请关闭已启动的简谱工坊后重试。"); process.exitCode = 1; });
  server.listen(18761, "127.0.0.1", () => {
    console.log(`READY http://127.0.0.1:${server.address().port}/#token=${token}`);
  });
}
module.exports = { createServer };
