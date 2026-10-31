import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, relative, isAbsolute, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createGuiController } from "./gui-controller.js";

const maxBodyBytes = 1024 * 1024;
const actions = new Set([
  "session.create", "session.name", "session.draft", "session.mode",
  "session.team", "session.thinking", "team.save", "team.remove",
  "provider.save", "settings.work", "releaseNotes.ack", "project.inspect",
  "extension.commands", "extension.command", "extension.reload", "extension.respond",
  "task.submit", "task.cancel", "task.reveal", "updates.check", "updates.configure",
]);
const mime = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
};
const fail = (status, message) => Object.assign(new Error(message), { status });
const inside = (root, path) => {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\"));
};
function openBrowser(url) {
  // Argument arrays avoid a shell on every platform. cmd/start is deliberately unused.
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  return new Promise((yes, no) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.once("error", () => no(Error("无法打开浏览器，请使用本次启动链接手动打开。")));
    child.once("spawn", () => { child.unref(); yes(); });
  });
}
async function jsonBody(req) {
  if (!/^application\/json\s*(?:;\s*charset=utf-8\s*)?$/i.test(req.headers["content-type"] ?? ""))
    throw fail(415, "变更接口要求 application/json。");
  const length = req.headers["content-length"];
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBodyBytes))
    throw fail(413, "JSON 请求超过 1 MiB。");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw fail(413, "JSON 请求超过 1 MiB。");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw fail(400, "JSON 格式无效。"); }
}
function query(url, names, required = names) {
  for (const key of url.searchParams.keys())
    if (!names.includes(key) || url.searchParams.getAll(key).length !== 1)
      throw fail(400, "查询参数无效。");
  for (const key of required)
    if (!url.searchParams.get(key)) throw fail(400, "缺少查询参数。");
}
function pageNumber(value, fallback, positive = false) {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || (positive && Number(value) === 0))
    throw fail(400, "分页参数无效。");
  return Number(value);
}

/** Loopback transport only; controller owns all durable task and session facts. */
export async function startGuiServer({ home, cwd = process.cwd(), port = 0, open = true, controller, assetDirectory = fileURLToPath(new URL("../gui/dist", import.meta.url)) }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error("GUI 端口必须是 0—65535 的整数。");
  controller ??= await createGuiController({ home, cwd });
  const token = randomBytes(32).toString("base64url"),
    bearer = Buffer.from(`Bearer ${token}`),
    clients = new Set();
  let authority, origin, closing;
  const call = async (method, ...args) => {
    try { return await controller[method](...args); }
    catch (error) {
      // The controller's public methods redact credentials, including newly entered keys.
      throw fail(400, String(error.message).replaceAll(token, "[REDACTED]"));
    }
  };
  const headers = {
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  };
  const send = (res, status, value, type = "application/json; charset=utf-8") => {
    res.writeHead(status, { ...headers, "Content-Type": type });
    res.end(type.startsWith("application/json") ? JSON.stringify(value ?? null) : value);
  };
  const server = createServer(async (req, res) => {
    try {
      if (closing) throw fail(503, "GUI 宿主正在关闭。");
      if (req.headers.host !== authority || (req.headers.origin !== undefined && req.headers.origin !== origin))
        throw fail(403, "Host 或 Origin 不受信任。");
      if (!req.url?.startsWith("/") || req.url.startsWith("//")) throw fail(400, "请求路径无效。");
      const url = new URL(req.url, origin);
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        const supplied = Buffer.from(req.headers.authorization ?? "");
        if (supplied.length !== bearer.length || !timingSafeEqual(supplied, bearer))
          throw fail(403, "需要本次启动凭据。");
        const actionRoute = url.pathname === "/api/action";
        if (req.method !== (actionRoute ? "POST" : "GET")) throw fail(405, "请求方法不允许。");
        if (actionRoute) {
          query(url, []);
          const body = await jsonBody(req);
          if (!body || typeof body !== "object" || Array.isArray(body) ||
              Object.keys(body).some((k) => !["action", "args"].includes(k)) ||
              !actions.has(body.action) || !body.args || typeof body.args !== "object" || Array.isArray(body.args))
            throw fail(400, "操作或参数无效。");
          return send(res, 200, await call("action", body.action, body.args));
        }
        if (url.pathname === "/api/events") {
          query(url, []);
          res.writeHead(200, { ...headers, "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive", "X-Accel-Buffering": "no" });
          const notify = () => {
            // Events are invalidations only, never controller payloads or task actions.
            if (!res.destroyed && !res.writableEnded && !res.write("event: invalidate\ndata: {}\n\n")) res.end();
          };
          const unsubscribe = controller.subscribe(notify);
          clients.add(res);
          res.once("close", () => { clients.delete(res); unsubscribe(); });
          notify();
          return;
        }
        if (url.pathname === "/api/bootstrap") {
          query(url, []);
          return send(res, 200, await call("bootstrap"));
        }
        if(url.pathname === "/api/artifact") {
          query(url,["id","ref","index"]);
          return send(res,200,await call("artifact",url.searchParams.get("id"),url.searchParams.get("ref"),pageNumber(url.searchParams.get("index"),0)),"image/png");
        }
        const method = { "/api/session": "session", "/api/task": "task", "/api/diff": "diff", "/api/patch": "patch", "/api/output": "output" }[url.pathname];
        if (!method) throw fail(404, "接口不存在。");
        const isOutput = method === "output";
        query(url, isOutput ? ["id", "ref", "offset", "limit"] : ["id"], isOutput ? ["id", "ref"] : ["id"]);
        const id = url.searchParams.get("id");
        if (isOutput) return send(res, 200, await call("output", id, url.searchParams.get("ref"), pageNumber(url.searchParams.get("offset"), 0), pageNumber(url.searchParams.get("limit"), 65536, true)));
        const result = await call(method, id);
        if (method === "patch") return send(res, 200, result, "text/plain; charset=utf-8");
        return send(res, 200, result);
      }
      if (!["GET", "HEAD"].includes(req.method)) throw fail(405, "请求方法不允许。");
      let decoded;
      try { decoded = decodeURIComponent(url.pathname); } catch { throw fail(400, "资源路径无效。"); }
      if (decoded.includes("\0") || decoded.includes("\\") || decoded.split("/").includes("..")) throw fail(403, "资源路径不允许。");
      let root;
      try { root = await realpath(assetDirectory); }
      catch (e) {
        if (e.code !== "ENOENT") throw e;
        return send(res, 503, "GUI 尚未构建。请在源码目录运行 npm run build:gui，然后重新启动 cothink gui。", "text/plain; charset=utf-8");
      }
      let path;
      try {
        path = await realpath(resolve(root, "." + (decoded === "/" ? "/index.html" : decoded)));
      } catch (e) {
        if (["ENOENT", "ENOTDIR"].includes(e.code)) throw fail(404, "资源不存在。");
        throw e;
      }
      if (!inside(root, path)) throw fail(403, "资源路径不允许。");
      if (!(await stat(path)).isFile()) throw fail(404, "资源不存在。");
      const data = await readFile(path);
      res.writeHead(200, { ...headers, "Content-Type": mime[extname(path)] ?? "application/octet-stream", "Content-Length": data.length });
      res.end(req.method === "HEAD" ? undefined : data);
    } catch (error) {
      if (res.headersSent) return res.end();
      // Controller errors are already redacted; do not echo request bodies, URLs or tokens.
      const message = error.status ? error.message : "操作未完成，请刷新状态并检查配置或已保存记录。";
      send(res, error.status ?? 400, { error: message });
    }
  });
  async function close() {
    if (!closing) closing = (async () => {
      for (const client of clients) client.end();
      const stopped = new Promise((yes, no) => server.close((e) => e && e.code !== "ERR_SERVER_NOT_RUNNING" ? no(e) : yes()));
      try { await controller.close(); }
      finally { server.closeAllConnections(); await stopped; }
    })();
    return closing;
  }
  try {
    await new Promise((yes, no) => { server.once("error", no); server.listen(port, "127.0.0.1", () => { server.off("error", no); yes(); }); });
    authority = `127.0.0.1:${server.address().port}`;
    origin = `http://${authority}`;
    const url = `${origin}/#token=${token}`;
    void controller.checkForUpdates?.();
    if (open) {
      try { await openBrowser(url); }
      catch { process.stderr.write("无法自动打开浏览器，请使用本次启动链接手动打开。\n"); }
    }
    return { url, token, close, server };
  } catch (error) {
    await close();
    throw error;
  }
}
