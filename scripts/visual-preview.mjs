import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, relative, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

export const PREVIEW_PROTOCOL = 1;
export const MAX_OUTPUT = 16 * 1024 * 1024;
export const MAX_PNG = 4 * 1024 * 1024;
const fail = (message) => {
  throw new Error(message);
};
const keys = (o, allowed) => {
  if (
    !o ||
    typeof o !== "object" ||
    Array.isArray(o) ||
    Object.keys(o).some((k) => !allowed.includes(k))
  )
    fail("Invalid preview fields");
};
const boundedText = (s, n) =>
  typeof s === "string" && s.length > 0 && s.length <= n && !s.includes("\0");
export function validatePreviewInput(input) {
  keys(input, ["entry", "viewport", "frameTimesMs", "actions"]);
  const { entry } = input;
  if (
    !boundedText(entry, 1024) ||
    entry.startsWith("/") ||
    /[\\:?#]/.test(entry) ||
    entry
      .split("/")
      .some(
        (p) => !p || p === ".." || p === "." || p.toLowerCase() === ".git",
      ) ||
    !/\.(html?|svg)$/i.test(entry)
  )
    fail("entry must be a relative HTML/SVG source path");
  const viewport = input.viewport ?? { width: 1440, height: 900 };
  keys(viewport, ["width", "height"]);
  if (
    !Number.isInteger(viewport.width) ||
    !Number.isInteger(viewport.height) ||
    viewport.width < 1 ||
    viewport.height < 1 ||
    viewport.width > 1920 ||
    viewport.height > 1080
  )
    fail("Invalid viewport (maximum 1920x1080)");
  const frameTimesMs = input.frameTimesMs ?? [0, 500, 1000];
  if (
    !Array.isArray(frameTimesMs) ||
    frameTimesMs.length < 1 ||
    frameTimesMs.length > 3 ||
    frameTimesMs.some(
      (x, i) =>
        !Number.isInteger(x) ||
        x < 0 ||
        x > 10000 ||
        (i > 0 && x < frameTimesMs[i - 1]),
    )
  )
    fail("Use 1..3 ordered frame times in 0..10000ms");
  const actions = input.actions ?? [];
  if (!Array.isArray(actions) || actions.length > 6) fail("At most 6 actions");
  for (const a of actions) {
    keys(
      a,
      a?.kind === "fill"
        ? ["kind", "selector", "value"]
        : a?.kind === "click"
          ? ["kind", "selector"]
          : ["kind", "key"],
    );
    if (a.kind === "click" || a.kind === "fill") {
      if (!boundedText(a.selector, 500)) fail("Invalid selector");
      if (
        a.kind === "fill" &&
        (typeof a.value !== "string" || a.value.length > 4000)
      )
        fail("Invalid fill value");
    } else if (a.kind !== "key" || !boundedText(a.key, 100))
      fail("Unsupported action");
  }
  return {
    entry,
    viewport: { ...viewport },
    frameTimesMs: [...frameTimesMs],
    actions: structuredClone(actions),
  };
}
const mime = {
  ".html": "text/html",
  ".htm": "text/html",
  ".svg": "image/svg+xml",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".json": "application/json",
};
export async function renderPreview(raw, visibility) {
  keys(visibility, ["scope", "artifactPaths"]);
  for (const list of [visibility.scope, visibility.artifactPaths]) {
    if (
      !Array.isArray(list) ||
      list.length > 1000 ||
      list.some(
        (p) =>
          typeof p !== "string" ||
          !p ||
          p.length > 1024 ||
          p.startsWith("/") ||
          p.includes("\\") ||
          p.split("/").includes(".."),
      )
    )
      fail("Invalid source visibility");
  }
  if (!visibility.scope.length) fail("Source scope required");
  const covered = (path, ranges) =>
    ranges.some((r) => r === "." || path === r || path.startsWith(r + "/"));
  const allowed = (path) =>
    covered(path, visibility.scope) && !covered(path, visibility.artifactPaths);
  const input = validatePreviewInput(raw),
    root = await realpath("/work");
  const diagnostics = {
    console: [],
    pageErrors: [],
    resourceErrors: [],
    blocked: [],
  };
  const add = (kind, value) => {
    if (diagnostics[kind].length < 100)
      diagnostics[kind].push(String(value).slice(0, 2000));
  };
  async function file(path) {
    if (
      path.split("/").some((x) => x === ".." || x.toLowerCase() === ".git") ||
      path.includes("\\") ||
      path.includes("\0")
    )
      fail("Path denied");
    if (!allowed(path)) fail("Resource outside managed source scope");
    const p = await realpath(resolve(root, path));
    const rel = relative(root, p);
    if (
      rel === ".." ||
      rel.startsWith("../") ||
      rel.startsWith("/") ||
      !allowed(rel)
    )
      fail("Path outside source projection");
    const info = await stat(p);
    if (!info.isFile() || info.size > 32 * 1024 * 1024)
      fail("Source resource unavailable or too large");
    return {
      bytes: await readFile(p),
      type: mime[extname(p).toLowerCase()] ?? "application/octet-stream",
    };
  }
  await file(input.entry);
  let server, browser;
  try {
    server = createServer(async (q, s) => {
      try {
        if (!["GET", "HEAD"].includes(q.method))
          throw Error("Read-only server");
        const path = decodeURIComponent(
          new URL(q.url, "http://localhost").pathname,
        ).slice(1);
        const f = await file(path);
        s.setHeader("Content-Type", f.type + "; charset=utf-8");
        s.setHeader("X-Content-Type-Options", "nosniff");
        s.end(q.method === "HEAD" ? undefined : f.bytes);
      } catch (e) {
        add("resourceErrors", q.url + ": " + e.message);
        s.writeHead(404).end("Unavailable");
      }
    });
    await new Promise((r, j) => {
      server.once("error", j);
      server.listen(0, "127.0.0.1", r);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const { chromium } =
      await import("/opt/preview/node_modules/playwright-core/index.mjs");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: input.viewport,
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    context.setDefaultTimeout(4000);
    await context.route("**/*", (route) => {
      const request = route.request(),
        url = request.url();
      if (
        new URL(url).origin !== origin ||
        !["GET", "HEAD"].includes(request.method())
      ) {
        add("blocked", url);
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });
    await context.routeWebSocket("**/*", (socket) => {
      add("blocked", socket.url());
      socket.close();
    });
    const page = await context.newPage();
    context.on("page", (popup) => {
      add("blocked", "popup: " + popup.url());
      popup.close().catch(() => {});
    });
    page.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning")
        add("console", m.type() + ": " + m.text());
    });
    page.on("pageerror", (e) => add("pageErrors", e.message));
    page.on("requestfailed", (r) =>
      add("resourceErrors", r.url() + ": " + r.failure()?.errorText),
    );
    page.on("response", (r) => {
      if (r.status() >= 400)
        add("resourceErrors", r.url() + ": HTTP " + r.status());
    });
    page.on("download", (d) => {
      add("blocked", "download: " + d.url());
      d.cancel().catch(() => {});
    });
    await page.goto(
      origin + "/" + input.entry.split("/").map(encodeURIComponent).join("/"),
      { waitUntil: "load", timeout: 15000 },
    );
    for (const action of input.actions) {
      if (action.kind === "click") await page.locator(action.selector).click();
      else if (action.kind === "fill")
        await page.locator(action.selector).fill(action.value);
      else await page.keyboard.press(action.key);
    }
    const started = performance.now(),
      images = [];
    for (const requestedAtMs of input.frameTimesMs) {
      await new Promise((r) =>
        setTimeout(
          r,
          Math.max(0, requestedAtMs - (performance.now() - started)),
        ),
      );
      const bytes = await page.screenshot({ type: "png", timeout: 5000 });
      if (bytes.length > MAX_PNG) fail("PNG exceeds 4MiB");
      images.push({
        requestedAtMs,
        capturedAtMs: performance.now() - started,
        mimeType: "image/png",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        data: bytes.toString("base64"),
      });
    }
    return {
      protocol: PREVIEW_PROTOCOL,
      status: "captured",
      entry: input.entry,
      viewport: input.viewport,
      browser: browser.version(),
      images,
      diagnostics,
    };
  } finally {
    await browser?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  }
}
async function main() {
  try {
    if (process.argv[2] === "--version") {
      console.log(JSON.stringify({ protocol: PREVIEW_PROTOCOL }));
      return;
    }
    const encoded = process.argv[2];
    if (
      !encoded ||
      encoded.length > 100000 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
    )
      fail("Invalid encoded input");
    const envelope = JSON.parse(
      Buffer.from(encoded, "base64").toString("utf8"),
    );
    keys(envelope, ["input", "visibility"]);
    const result = await renderPreview(envelope.input, envelope.visibility);
    const output = JSON.stringify(result);
    if (Buffer.byteLength(output) > MAX_OUTPUT)
      fail("Preview output exceeds 16MiB");
    console.log(output);
  } catch (e) {
    console.log(
      JSON.stringify({
        protocol: PREVIEW_PROTOCOL,
        status: "failed",
        error: String(e.message).slice(0, 4000),
      }),
    );
    process.exitCode = 1;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
