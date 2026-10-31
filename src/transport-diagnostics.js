import { redact } from "./storage.js";

// Error properties are non-enumerable. Copy a narrow diagnostic set rather than
// serializing request objects (which can contain authentication and cycles).
export function describeError(error, secrets = [], seen = new Set(), depth = 0) {
  if (error == null || typeof error !== "object") return redact(String(error), secrets);
  if (seen.has(error) || depth > 5) return "[nested error omitted]";
  seen.add(error);
  const result = {};
  for (const key of ["name", "message", "code", "errno", "syscall", "status", "type", "stack"])
    if (["string", "number", "boolean"].includes(typeof error[key])) result[key] = error[key];
  if (error.cause !== undefined) result.cause = describeError(error.cause, secrets, seen, depth + 1);
  if (Array.isArray(error.errors)) result.errors = error.errors.slice(0, 8).map(e => describeError(e, secrets, seen, depth + 1));
  return redact(result, secrets);
}
export function responseHeaders(headers, secrets = []) {
  const allowed = new Set(["date", "content-type", "content-encoding", "content-length", "transfer-encoding", "server", "connection", "retry-after", "cf-ray", "request-id", "x-request-id", "msh-request-id", "x-generation-id", "x-provider-name"]);
  return redact(Object.fromEntries([...headers].filter(([key]) => allowed.has(key.toLowerCase()) || key.toLowerCase().startsWith("x-ratelimit"))), secrets);
}

// Inspect a bounded copy, never change forwarded bytes or provider semantics.
// SSE errors can otherwise be thrown away by the SDK before its event callback.
export function streamObserver(trace, secrets = []) {
  const decoder = new TextDecoder();
  let pending = "", data = [], size = 0, dropping = false;
  const limit = 65536;
  const dispatch = () => {
    if (!data.length) { size = 0; dropping = false; return; }
    const raw = data.join("\n");
    if (raw.trim() === "[DONE]") trace.doneSentinelAt = new Date().toISOString();
    else {
      try {
        const value = JSON.parse(raw);
        if (value?.error || value?.type === "error") {
          trace.sseErrorCount = (trace.sseErrorCount ?? 0) + 1;
          trace.firstSseError ??= redact(value, secrets);
        }
      } catch {
        trace.malformedSseEvents = (trace.malformedSseEvents ?? 0) + 1;
        trace.firstMalformedSse ??= redact(raw, secrets);
      }
    }
    data = []; size = 0; dropping = false;
  };
  const line = value => {
    if (!value) { dispatch(); return; }
    if (!value.startsWith("data:") || dropping) return;
    const part = value.slice(5).replace(/^ /, "");
    size += part.length;
    if (size > limit) { trace.diagnosticFrameTruncated = true; data = []; dropping = true; }
    else data.push(part);
  };
  const consume = text => {
    pending += text;
    let at;
    while ((at = pending.indexOf("\n")) >= 0) {
      line(pending.slice(0, at).replace(/\r$/, ""));
      pending = pending.slice(at + 1);
    }
    if (pending.length > limit) { trace.diagnosticFrameTruncated = true; pending = ""; data = []; dropping = true; }
  };
  return {
    chunk(bytes) {
      const now = new Date().toISOString();
      trace.firstBodyAt ??= now;
      trace.lastBodyAt = now;
      trace.bodyBytes = (trace.bodyBytes ?? 0) + bytes.byteLength;
      trace.bodyChunks = (trace.bodyChunks ?? 0) + 1;
      consume(decoder.decode(bytes, { stream: true }));
    },
    end(complete) {
      consume(decoder.decode());
      if (pending || data.length) {
        trace.unterminatedSseTail = redact((data.join("\n") + pending).slice(0, limit), secrets);
        // Still preserve an error in an EOF-terminated event as evidence.
        if (pending) line(pending.replace(/\r$/, ""));
        dispatch();
      }
      trace.bodyEndedAt = new Date().toISOString();
      trace.bodyComplete = complete;
    },
  };
}

export function observeResponse(response, trace, secrets = []) {
  if (!response.body) { trace.bodyComplete = true; return response; }
  const reader = response.body.getReader();
  const observer = streamObserver(trace, secrets);
  let ended = false;
  const finish = complete => { if (!ended) { ended = true; observer.end(complete); reader.releaseLock(); } };
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { finish(true); controller.close(); }
        else { observer.chunk(next.value); controller.enqueue(next.value); }
      } catch (error) {
        trace.bodyError = describeError(error, secrets);
        finish(false);
        controller.error(error);
      }
    },
    async cancel(reason) {
      trace.consumerCancelledAt = new Date().toISOString();
      trace.consumerCancelReason = describeError(reason, secrets);
      try { await reader.cancel(reason); }
      catch (error) { trace.cancelError = describeError(error, secrets); }
      finally { finish(false); }
    },
  }, { highWaterMark: 0 });
  const result = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  for (const key of ["url", "redirected", "type"]) Object.defineProperty(result, key, { value: response[key] });
  return result;
}
