import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { chromium } from "playwright";
import { loadRound, readJson, save, safeFile, hash } from "./core.mjs";
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".woff2": "font/woff2",
};
// Parallel member waits overlap: report their union, never add them to wall time.
export function retryWaitDuration(requests, startedAt, endedAt) {
  const start = Date.parse(startedAt),
    end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const ranges = requests
    .filter((r) => r.waitStartedAt && r.waitEndedAt)
    .map((r) => [
      Math.max(start, Date.parse(r.waitStartedAt)),
      Math.min(end, Date.parse(r.waitEndedAt)),
    ])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .sort((a, b) => a[0] - b[0]);
  let total = 0,
    left = null,
    right = null;
  for (const [a, b] of ranges) {
    if (left === null) {
      left = a;
      right = b;
    } else if (a <= right) {
      right = Math.max(right, b);
    } else {
      total += right - left;
      left = a;
      right = b;
    }
  }
  return total + (left === null ? 0 : right - left);
}
// Presentation-only recovery metadata never rewrites the original task outcome.
export function capturedOutcome(dir, id) {
  const root=join(dir,'attempts',id),p=join(root,'status.json');
  if(!existsSync(p))return {};
  const bytes=readFileSync(p),status=JSON.parse(bytes);
  const captureFile=join(root,'artifact-capture.json');
  if(status.artifact||!existsSync(captureFile))return status;
  const capture=readJson(captureFile);
  if(hash(bytes)!==capture.originalStatusSha256)throw Error('原始任务状态发生变化，拒绝使用展示副本');
  if(!capture.files?.[capture.artifact])throw Error('展示入口缺少来源校验');
  for(const [name,digest] of Object.entries(capture.files))if(hash(readFileSync(safeFile(join(root,'artifact'),name)))!==digest)throw Error('展示副本字节校验失败');
  return {...status,artifact:capture.artifact,artifactSource:capture.artifactSource,artifactCapture:capture};
}
export async function report(dir) {
  const r = await loadRound(dir),
    v = readJson(join(dir, "votes.json"));
  if (!v.revealed) throw Error("尚未揭晓，报告不会提前泄露模型身份");
  const ledger = existsSync(join(dir, "ledger.json"))
    ? readJson(join(dir, "ledger.json"))
    : null;
  const groups = [
    r.config.models[0].provider + "/" + r.config.models[0].modelId,
    r.config.models[1].provider + "/" + r.config.models[1].modelId,
    "CoThink",
  ];
  const scores = groups.map((group) => ({
    group,
    singleWins: 0,
    sharedBest: 0,
  }));
  let allRejected = 0;
  const questions = r.questions.map((q) => {
    const choice = v.choices[q.id];
    if (!choice.selected.length) allRejected++;
    for (const i of choice.selected) {
      const a = r.attempts.find((a) => a.id === q.order[i]);
      scores[a.group][
        choice.selected.length === 1 ? "singleWins" : "sharedBest"
      ]++;
    }
    return {
      title: q.title,
      choice,
      mapping: q.order.map((id) => {
        const a = r.attempts.find((a) => a.id === id),
          outcome = capturedOutcome(dir,id);
        const requests = Object.values(ledger?.requests ?? {}).filter(
          (x) => x.attempt === id,
        );
        const costs = r.config.models.map((m, slot) => ({
          model: m.provider + "/" + m.modelId,
          currency: r.config.budgets[slot].currency,
          settledCeiling:
            requests
              .filter((x) => x.slot === slot && x.cost !== null)
              .reduce((n, x) => n + x.cost, 0) / 1e6,
          heldForUnknown:
            requests
              .filter((x) => x.slot === slot && x.cost === null)
              .reduce((n, x) => n + x.reserved, 0) / 1e6,
          unknownRequests: requests.filter(
            (x) => x.slot === slot && x.cost === null,
          ).length,
          actualBilled: null,
        }));
        const retryWaitMs = retryWaitDuration(
          requests,
          outcome?.startedAt,
          outcome?.endedAt,
        );
        return {
          group: groups[a.group],
          retryWaitMs,
          otherElapsedMs:
            retryWaitMs === null
              ? null
              : Math.max(
                  0,
                  Date.parse(outcome.endedAt) -
                    Date.parse(outcome.startedAt) -
                    retryWaitMs,
                ),
          retryCount: requests.filter((r) => (r.retryNumber ?? 0) > 0).length,
          logicalRequests: new Set(requests.map((r) => r.logicalId ?? r.id))
            .size,
          durationMs:
            outcome?.endedAt && outcome?.startedAt
              ? Date.parse(outcome.endedAt) - Date.parse(outcome.startedAt)
              : null,
          requestAttempts: requests.length,
          costs,
          outcome,
        };
      }),
    };
  });
  return {
    round: r.id,
    version: r.runtime.version,
    runtimeHash: r.runtime.hash,
    models: r.config.models.map(({ provider, modelId, thinkingLevel }) => ({
      provider,
      modelId,
      thinkingLevel,
    })),
    limits: r.config.limits,
    groups,
    scores,
    allRejected,
    questions,
    ledger,
  };
}
export async function summarize(root) {
  const { readdirSync } = await import("node:fs");
  const rounds = [];
  let unrevealed = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      !existsSync(join(root, entry.name, "votes.json"))
    )
      continue;
    const dir = join(root, entry.name);
    if (!readJson(join(dir, "votes.json")).revealed) {
      unrevealed++;
      continue;
    }
    const r = await report(dir);
    rounds.push({
      directory: entry.name,
      round: r.round,
      version: r.version,
      runtimeHash: r.runtimeHash,
      models: r.models,
      limits: r.limits,
      questions: r.questions.length,
      scores: r.scores,
      allRejected: r.allRejected,
    });
  }
  return {
    rounds,
    unrevealed,
    note: "各轮分别列出；不把不同模型、提示词或限制的结果合并成能力排名。",
  };
}
export async function startViewer(dir) {
  const r = await loadRound(dir),
    token = randomUUID();
  const ready = () =>
    !existsSync(join(dir, "run.lock")) &&
    r.attempts.every((a) => {
      const p = join(dir, "attempts", a.id, "status.json");
      return (
        existsSync(p) && !["preparing", "running"].includes(readJson(p).status)
      );
    });
  let origin;
  const server = createServer(async (req, res) => {
    const json = (value, status = 200) => {
      res.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(value));
    };
    try {
      if (
        req.headers.host !== new URL(origin).host ||
        req.headers["x-visual-bench"] !== token
      )
        return json({ error: "请通过 view 命令打开隔离浏览器" }, 403);
      const url = new URL(req.url, origin);
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy":
            "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'",
        });
        res.end(readFileSync(new URL("./viewer.html", import.meta.url)));
        return;
      }
      if (
        req.method === "GET" &&
        ["/viewer.js", "/viewer.css"].includes(url.pathname)
      ) {
        res.writeHead(200, {
          "content-type": MIME[extname(url.pathname)],
          "cache-control": "no-store",
        });
        res.end(readFileSync(new URL("." + url.pathname, import.meta.url)));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        const votes = readJson(join(dir, "votes.json"));
        const outcomes=r.attempts.map(a=>capturedOutcome(dir,a.id));
        const ledgerPath = join(dir, "ledger.json"),
          isReady = ready();
        const waits =
          isReady || !existsSync(ledgerPath)
            ? []
            : Object.values(readJson(ledgerPath).progress ?? {}).filter(
                (p) => p.phase === "waiting_retry",
              );
        const nextRetryAt =
          waits
            .map((p) => p.nextRetryAt)
            .filter(Boolean)
            .sort()[0] ?? null;
        return json({
          id: r.id,
          ready: isReady,
          presentation: {available:outcomes.filter(s=>s.artifact).length,partial:outcomes.filter(s=>s.artifact&&s.status!=="completed").length,missing:outcomes.filter(s=>!s.artifact).length},
          progress: { waitingRequests: waits.length, nextRetryAt },
          questions: r.questions.map((q) => ({
            id: q.id,
            title: q.title,
            cards: q.order.map((id, i) => {
              const s = capturedOutcome(dir,id);
              return {
                label: "ABC"[i],
                url: s.artifact
                  ? "/p/" +
                    id +
                    "/" +
                    s.artifact.split(/[\\/]/).map(encodeURIComponent).join("/")
                  : null,
              };
            }),
          })),
          votes,
          ...(votes.revealed ? { report: await report(dir) } : {}),
        });
      }
      if (
        req.method === "POST" &&
        ["/api/vote", "/api/reveal", "/api/export"].includes(url.pathname)
      ) {
        if (
          req.headers.origin !== origin ||
          req.headers["content-type"] !== "application/json"
        )
          return json({ error: "请求来源不匹配" }, 403);
        let body = "";
        for await (const c of req) {
          body += c;
          if (body.length > 16384) throw Error("请求过大");
        }
        const data = JSON.parse(body),
          v = readJson(join(dir, "votes.json"));
        if (!ready())
          throw Error("本轮尚未结束，只能预览，暂不能保存盲选或揭晓");
        if (url.pathname === "/api/export") {
          const result = await report(dir);
          const file = join(dir, "report.json");
          save(file, result);
          return json({ file });
        }
        if (url.pathname === "/api/vote") {
          if (v.revealed) throw Error("已揭晓，盲选记录已锁定");
          if (
            !r.questions.some((q) => q.id === data.question) ||
            !Array.isArray(data.selected) ||
            new Set(data.selected).size !== data.selected.length ||
            data.selected.some((n) => ![0, 1, 2].includes(n)) ||
            typeof data.note !== "string" ||
            data.note.length > 2000
          )
            throw Error("选择无效");
          v.choices[data.question] = {
            selected: data.selected,
            note: data.note,
          };
        } else {
          if (!r.questions.every((q) => Object.hasOwn(v.choices, q.id)))
            throw Error("请先完成每道题的选择，可选择都不合格");
          v.revealed = true;
          v.revealedAt = new Date().toISOString();
        }
        save(join(dir, "votes.json"), v);
        if (v.revealed) save(join(dir, "report.json"), await report(dir));
        return json({ ok: true });
      }
      if (req.method === "GET" && url.pathname.startsWith("/p/")) {
        const parts = url.pathname.slice(3).split("/").map(decodeURIComponent),
          id = parts.shift();
        if (!r.attempts.some((a) => a.id === id)) throw Error("未知作品");
        const path = safeFile(
          join(dir, "attempts", id, "artifact"),
          parts.join("/"),
        );
        res.writeHead(200, {
          "content-type": MIME[extname(path)] ?? "application/octet-stream",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "access-control-allow-origin": "*",
          "content-security-policy": `sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src ${origin}/p/${id}/; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`,
        });
        res.end(readFileSync(path));
        return;
      }
      json({ error: "Not found" }, 404);
    } catch (e) {
      json({ error: e.message }, 400);
    }
  });
  // Also acts as a deny proxy for the managed browser's non-loopback traffic.
  server.on("connect", (_req, s) => {
    s.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    origin,
    token,
    close: async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
export async function launchViewerBrowser(view, { headless = false } = {}) {
  const browser = await chromium.launch({
    channel: "chromium",
    headless,
    args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--window-size=1440,1000"],
    proxy: { server: view.origin, bypass: "127.0.0.1" },
  });
  try {
    const context = await browser.newContext({
      // The viewer must follow the real window. An emulated fixed viewport can
      // scroll to an invisible bottom after the user makes the window shorter.
      viewport: null,
      serviceWorkers: "block",
      acceptDownloads: false,
      extraHTTPHeaders: { "x-visual-bench": view.token },
    });
    const allowed = (url) => {
      try {
        const u = new URL(url);
        return (
          u.origin === view.origin &&
          (/^\/p\//.test(u.pathname) ||
            [
              "/",
              "/viewer.js",
              "/viewer.css",
              "/api/state",
              "/api/vote",
              "/api/reveal",
              "/api/export",
            ].includes(u.pathname))
        );
      } catch {
        return false;
      }
    };
    await context.addInitScript(() => {
      for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection"])
        Object.defineProperty(globalThis, name, {
          value: undefined,
          writable: false,
          configurable: false,
        });
    });
    await context.route("**/*", (route) =>
      allowed(route.request().url())
        ? route.continue()
        : route.abort("blockedbyclient"),
    );
    await context.routeWebSocket("**/*", (socket) => socket.close());
    const page = await context.newPage();
    // This browser belongs to one viewer. A windowless automation browser can
    // otherwise stay alive on macOS even after the user chooses Quit.
    page.once("close", () => { void browser.close().catch(() => {}); });
    await page.goto(view.origin);
    return { browser, context, page };
  } catch (error) {
    await browser.close();
    throw error;
  }
}
export async function openViewer(dir) {
  const view = await startViewer(dir);
  let browser;
  try {
    ({ browser } = await launchViewerBrowser(view));
    console.log(
      "盲选页面已打开。模型作品在独立浏览器中播放，外部网络已阻断。关闭浏览器结束。",
    );
    await new Promise((r) => {
      browser.once("disconnected", r);
      if (!browser.isConnected()) r();
    });
  } finally {
    await browser?.close();
    await view.close();
  }
}
