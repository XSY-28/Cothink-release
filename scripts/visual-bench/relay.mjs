import { describeError, responseHeaders, streamObserver } from "../../src/transport-diagnostics.js";
import { configureHttpDispatcher } from "@earendil-works/pi-coding-agent";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { createLedger, fingerprint, hash } from "./core.mjs";

// Complete, structured refusals only. Neither a status code alone nor a broken
// stream proves that the provider did not already generate a result.
export function classifyTransient(status, text, complete = true) {
  if (!complete || ![429, 503].includes(status)) return null;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const error = body?.error;
  if (!error || typeof error !== "object") return null;
  function containsResult(value) {
    if (typeof value === "string" && /^[\[{]/.test(value.trim())) {
      try {
        return containsResult(JSON.parse(value));
      } catch {
        return false;
      }
    }
    if (!value || typeof value !== "object") return false;
    for (const [key, v] of Object.entries(value)) {
      if (
        [
          "choices",
          "output",
          "content",
          "completion",
          "generated_text",
          "partial",
          "usage",
          "response",
        ].includes(key) &&
        v != null &&
        v !== "" &&
        (!Array.isArray(v) || v.length)
      )
        return true;
      if (containsResult(v)) return true;
    }
    return false;
  }
  if (containsResult(body)) return null;
  const type = String(error.type ?? error.code ?? "").toLowerCase();
  const message = String(error.message ?? "").toLowerCase();
  if (
    /quota|credit|balance|billing|payment|insufficient|per.day|daily|authentication|invalid.api.key/.test(
      type + " " + message,
    )
  )
    return null;
  if (
    type === "engine_overloaded_error" ||
    /overload/.test(type + " " + message)
  )
    return "overloaded";
  if (
    status === 429 &&
    (/rate[_ -]?limit|too_many_requests/.test(type) ||
      /rate limit|too many requests/.test(message))
  )
    return "rate_limited";
  if (
    status === 503 &&
    (/^(service_unavailable|temporarily_unavailable|server_overloaded)$/.test(
      type,
    ) ||
      /temporar(?:y|ily).*unavailable|service (?:is )?unavailable/.test(
        message,
      ))
  )
    return "unavailable";
  return null;
}
export function retryDelay(
  headers,
  index,
  now = Date.now(),
  random = Math.random,
) {
  const raw = headers["retry-after"];
  let delay;
  if (raw !== undefined) {
    if (/^\d+(?:\.\d+)?$/.test(raw.trim())) delay = Number(raw) * 1000;
    else {
      const date = Date.parse(raw);
      if (Number.isFinite(date)) delay = Math.max(0, date - now);
    }
  }
  if (!Number.isFinite(delay) || delay < 0 || delay > 8.64e15 - now - 5000)
    delay = Math.min(120000, 20000 * 2 ** Math.min(index, 3));
  return Math.ceil(
    delay + random() * Math.min(5000, Math.max(1000, delay * 0.1)),
  );
}
export async function waitForRetry(ms, signal) {
  signal.throwIfAborted();
  const end = Date.now() + ms;
  while (Date.now() < end)
    await sleep(Math.min(2147483647, end - Date.now()), undefined, { signal });
  signal.throwIfAborted();
}
export async function startRelay({
  round,
  dir,
  auth,
  retryWait = waitForRetry,
  onProgress = () => {},
}) {
  configureHttpDispatcher(0);
  const ledger = createLedger(join(dir, "ledger.json"), round.config),
    tokens = new Map(),
    controllers = new Set(),
    handlers = new Set();
  const maxBody = 16 * 1024 * 1024;
  for (const a of round.attempts) tokens.set(a.id, randomUUID());
  const notify = (event) => {
    try {
      onProgress(event);
    } catch {
      /* Progress display is not transport. */
    }
  };
  async function handle(req, res) {
    let reservation = null,
      usage = null,
      terminal = false,
      controller,
      logicalId,
      attempt,
      trace, observer, diagnosticId,
      diagnosticSecrets = [],
      relayDestroying = false,
      applicationEnded = false;
    const saveTrace = () => { if (diagnosticId && trace) ledger.annotate(diagnosticId, trace); };
    const update = (value) => {
      if (logicalId) ledger.progress(logicalId, { attempt, ...value });
    };
    try {
      const match = /^\/([a-f0-9-]+)\/([01])\/v1\/chat\/completions$/.exec(
        req.url ?? "",
      );
      if (
        req.method !== "POST" ||
        !match ||
        req.headers.authorization !== "Bearer " + tokens.get(match[1])
      )
        throw Error("请求未获授权");
      const [, id, slotText] = match,
        slot = Number(slotText),
        a = round.attempts.find((a) => a.id === id);
      if (!a || (a.group !== 2 && a.group !== slot))
        throw Error("模型不属于本任务");
      const parts = [];
      let bytes = 0;
      for await (const part of req) {
        bytes += part.length;
        if (bytes > maxBody) throw Error("请求过大");
        parts.push(part);
      }
      const body = JSON.parse(Buffer.concat(parts)),
        model = round.config.models[slot];
      if (
        body.model !== model.modelId ||
        body.stream !== true ||
        body.plugins?.length ||
        body.web_search_options ||
        body.tools?.some((t) => t.type !== "function")
      )
        throw Error("禁止替换模型或使用服务端联网工具");
      if (round.config.limits.outputTokens === null) {
        delete body.max_tokens;
        delete body.max_completion_tokens;
        delete body.max_output_tokens;
      } else if ("max_completion_tokens" in body)
        body.max_completion_tokens = round.config.limits.outputTokens;
      else body.max_tokens = round.config.limits.outputTokens;
      if (new URL(model.baseUrl).hostname === "openrouter.ai") {
        if (round.config.budgets[slot].currency !== "USD")
          throw Error("OpenRouter 价格上界须使用 USD");
        body.provider = {
          ...(model.routing ?? {}),
          allow_fallbacks: false,
          require_parameters: true,
          data_collection: "deny",
          zdr: true,
        };
        if (round.config.budgets[slot].limit !== null)
          body.provider.max_price = {
            prompt: round.config.budgets[slot].inputPerMillion,
            completion: round.config.budgets[slot].outputPerMillion,
          };
      }
      if (
        model.modelId === "kimi-k3.1-pro" &&
        new URL(model.baseUrl).hostname === "api.moonshot.cn"
      )
        body.prompt_cache_options = { mode: "implicit", ttl: "5m" };
      diagnosticSecrets = [auth[slot].apiKey, ...Object.values(auth[slot].headers ?? {})].filter(v => typeof v === "string" && v.length > 3);
      const payload = JSON.stringify(body),
        payloadSha256 = hash(payload);
      logicalId = randomUUID();
      attempt = id;
      controller = new AbortController();
      controllers.add(controller);
      res.on("close", () => {
        if (!res.writableEnded && !relayDestroying && !applicationEnded) controller.abort(Error("调用方已停止"));
      });
      controller.signal.addEventListener("abort", () => {
        if (trace) {
          trace.abort = { at: new Date().toISOString(), source: controller.signal.reason?.message === "协调器已关闭" ? "relay_close" : "downstream_close", reason: describeError(controller.signal.reason, diagnosticSecrets) };
          try { saveTrace(); } catch {}
        }
      }, { once: true });
      if (res.destroyed) controller.abort(Error("调用方已断开"));
      let retryNumber = 0;
      while (true) {
        controller.signal.throwIfAborted();
        if (round.runtime && fingerprint() !== round.runtime.hash)
          throw Error("运行源码发生变化，停止新请求；请准备新轮次");
        reservation = ledger.reserve(id, slot, {
          logicalId,
          retryNumber,
          payloadSha256,
        });
        diagnosticId = reservation;
        trace = { startedAt: new Date().toISOString(), phase: "connecting", bodyBytes: 0, bodyChunks: 0 };
        observer = streamObserver(trace, diagnosticSecrets);
        saveTrace();
        update({ phase: "requesting", retryNumber, nextRetryAt: null });
        const upstream = await fetch(
          model.baseUrl.replace(/\/$/, "") + "/chat/completions",
          {
            method: "POST",
            redirect: "error",
            signal: controller.signal,
            headers: {
              ...auth[slot].headers,
              "content-type": "application/json",
              authorization: "Bearer " + auth[slot].apiKey,
            },
            body: payload,
          },
        );
        trace.httpStatus = upstream.status;
        trace.headersAt = new Date().toISOString();
        trace.responseHeaders = responseHeaders(upstream.headers, diagnosticSecrets);
        trace.phase = "reading_upstream";
        saveTrace();
        if (!upstream.ok) {
          const chunks = [];
          let size = 0,
            complete = true;
          for await (const part of upstream.body) {
            observer.chunk(part);
            chunks.push(Buffer.from(part));
            size += part.length;
            if (size > 262144) {
              complete = false;
              break;
            }
          }
          observer.end(complete);
          trace.phase = "http_error";
          saveTrace();
          let errorBody = Buffer.concat(chunks)
            .subarray(0, 262144)
            .toString("utf8");
          for (const secret of [
            auth[slot].apiKey,
            ...Object.values(auth[slot].headers ?? {}),
          ])
            if (typeof secret === "string" && secret.length > 3)
              errorBody = errorBody.split(secret).join("<redacted>");
          const headers = Object.fromEntries(
            [...upstream.headers].filter(
              ([k]) =>
                [
                  "retry-after",
                  "x-request-id",
                  "request-id",
                  "msh-request-id",
                  "x-generation-id",
                  "cf-ray",
                ].includes(k) || k.startsWith("x-ratelimit"),
            ),
          );
          const kind = round.workRequest ? null : classifyTransient(upstream.status, errorBody, complete),
            physicalId = reservation;
          ledger.httpError(
            physicalId,
            upstream.status,
            errorBody,
            headers,
            kind,
          );
          reservation = null;
          if (!kind) {
            update({
              phase: "failed",
              httpStatus: upstream.status,
              nextRetryAt: null,
            });
            res.writeHead(upstream.status, {
              "content-type": "application/json",
              ...headers,
            });
            res.end(errorBody);
            return;
          }
          const delay = retryDelay(headers, retryNumber);
          ledger.beginWait(physicalId, delay);
          update({
            phase: "waiting_retry",
            retryNumber: retryNumber + 1,
            retryKind: kind,
            httpStatus: upstream.status,
            nextRetryAt: ledger.state.requests[physicalId].nextRetryAt,
          });
          notify({
            type: "retry_wait",
            attempt: id,
            retryNumber: retryNumber + 1,
            reason: kind,
            waitMs: delay,
          });
          let waitOutcome = "cancelled";
          try {
            await retryWait(delay, controller.signal);
            controller.signal.throwIfAborted();
            waitOutcome = "elapsed";
          } finally {
            ledger.endWait(physicalId, waitOutcome);
          }
          retryNumber++;
          continue;
        }
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
        });
        const decoder = new TextDecoder();
        let pending = "", streamError = false;
        const parseEvent = (event) => {
          const data = event.split(/\r\n|\n|\r/)
            .filter(line => line.startsWith("data:"))
            .map(line => line.slice(5).replace(/^ /, ""));
          if (!data.length) return;
          const text = data.join("\n");
          if (text === "[DONE]") { terminal = true; return; }
          try {
            const value = JSON.parse(text);
            if (value.usage) usage = value.usage;
            if (value.error) streamError = true;
          } catch { streamError = true; }
        };
        const finish = (httpEof) => {
          observer.end(httpEof);
          trace.phase = "ended";
          trace.terminal = terminal && !streamError;
          trace.completionSource = terminal ? "sse_done" : "http_eof_without_done";
          saveTrace();
          const settledId = reservation;
          ledger.settle(settledId, usage, trace.terminal);
          reservation = null;
          update({ phase: ledger.state.requests[settledId].status === "settled" ? "completed" : "unknown", nextRetryAt: null });
          // Persist application completion before the SDK can receive DONE and
          // close its body reader. HTTP EOF is not the completion boundary.
          applicationEnded = true;
        };
        const reader = upstream.body.getReader();
        try {
          while (true) {
            trace.phase = "reading_upstream";
            const { value: chunk, done } = await reader.read();
            if (done) { finish(true); res.end(); return; }
            observer.chunk(chunk);
            pending += decoder.decode(chunk, { stream: true });
            let boundary;
            while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(pending))) {
              parseEvent(pending.slice(0, boundary.index));
              pending = pending.slice(boundary.index + boundary[0].length);
              if (terminal) break;
            }
            if (pending.length > maxBody) throw Error("服务商事件过大");
            if (terminal) {
              finish(false);
              res.end(chunk);
              try { await reader.cancel(); }
              catch (error) {
                trace.cleanupError = describeError(error, diagnosticSecrets);
                saveTrace();
              }
              return;
            }
            trace.phase = "writing_downstream";
            if (!res.write(chunk)) await once(res, "drain", { signal: controller.signal });
          }
        } finally {
          // Also release the upstream connection if parsing or persistence fails.
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
    } catch (error) {
      if (trace) {
        trace.error = describeError(error, diagnosticSecrets);
        trace.failedAt = new Date().toISOString();
        if (trace.bodyComplete === undefined) observer?.end(false);
        try { saveTrace(); } catch {}
      }
      if (
        reservation &&
        ledger.state.requests[reservation]?.status === "reserved"
      ) {
        try {
          ledger.settle(reservation, usage, false);
        } catch {
          /* Journal failure blocks new sends. */
        }
      }
      try {
        update({
          phase: controller?.signal.aborted ? "cancelled" : "failed",
          nextRetryAt: null,
        });
      } catch {}
      if (!res.destroyed) {
        if (!res.headersSent) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: { message: error.message, type: "benchmark_stopped" },
            }),
          );
        } else { relayDestroying = true; res.destroy(); }
      }
    } finally {
      if (controller) controllers.delete(controller);
    }
  }
  const server = createServer((req, res) => {
    const p = handle(req, res);
    handlers.add(p);
    p.finally(() => handlers.delete(p));
  });
  server.on("clientError", (_e, s) => s.destroy());
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  let closing;
  return {
    ledger,
    tokens,
    origin: `http://127.0.0.1:${server.address().port}`,
    close() {
      return (closing ??= (async () => {
        for (const c of controllers) c.abort(Error("协调器已关闭"));
        server.closeAllConnections();
        await Promise.allSettled([...handlers]);
        await new Promise((r) => server.close(r));
      })());
    },
  };
}
