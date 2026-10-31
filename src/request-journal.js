import { openSync, writeSync, fsyncSync, closeSync, readFileSync } from "node:fs";
import { join } from "node:path";

const corrupt = () => Object.assign(new Error("请求事件日志归属、序号或内容损坏，原文件保留"), { code: "CORRUPT_REQUEST" });
function pathFor(home, id) {
  if (typeof id !== "string" || !/^[\da-f-]{36}$/.test(id)) throw corrupt();
  return join(home, "requests", id + ".events.jsonl");
}

// One fsync per event preserves the existing durability guarantee without
// serializing, redacting or rewriting the entire growing history each time.
export function createRequestJournal(home, request) {
  let fd = openSync(pathFor(home, request.id), "wx", 0o600), sequence = 0;
  const close = () => {
    if (fd !== undefined) {
      const value = fd;
      fd = undefined;
      closeSync(value);
    }
  };
  const write = (row) => {
    if (fd === undefined) throw new Error("请求事件日志已关闭；禁止追加或重发");
    try {
      const bytes = Buffer.from(JSON.stringify(row) + "\n");
      for (let offset = 0; offset < bytes.length;) {
        const count = writeSync(fd, bytes, offset, bytes.length - offset);
        if (!count) throw new Error("请求事件日志写入未取得进展");
        offset += count;
      }
      fsyncSync(fd);
    } catch (error) {
      // A partial row must never be followed by another append.
      try { close(); } catch {}
      throw error;
    }
  };
  write({ type: "header", version: 1, requestId: request.id, taskId: request.taskId });
  return {
    append(event) { write({ sequence: sequence++, receivedAt: new Date().toISOString(), event }); },
    close,
  };
}

function textDelta(event) {
  if (Array.isArray(event?.choices))
    return event.choices.filter(c => c.index == null || c.index === 0).map(c => c.delta?.content ?? "").filter(v => typeof v === "string").join("");
  if (event?.type === "content_block_start" && event.content_block?.type === "text") return event.content_block.text ?? "";
  if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") return event.delta.text ?? "";
  if (event?.type === "response.output_text.delta") return event.delta ?? "";
  return event?.candidates?.[0]?.content?.parts?.filter(p => !p.thought && typeof p.text === "string").map(p => p.text).join("") ?? "";
}
export function recoverRequestJournal(home, call) {
  if (!call.eventJournal) return call; // Historical standalone snapshots.
  if (call.eventJournal.version !== 1 || typeof call.eventJournal.folded !== "boolean") throw corrupt();
  if (call.eventJournal.folded) {
    if (!Array.isArray(call.events) || call.events.length !== call.eventJournal.count) throw corrupt();
    return call; // Terminal snapshot is independently readable.
  }
  const bytes = readFileSync(pathFor(home, call.id));
  const end = bytes.lastIndexOf(10);
  if (end < 0) throw corrupt();
  let rows;
  try { rows = bytes.subarray(0, end).toString("utf8").split("\n").map(line => JSON.parse(line)); }
  catch { throw corrupt(); }
  const header = rows.shift();
  if (header?.type !== "header" || header.version !== 1 || header.requestId !== call.id || header.taskId !== call.taskId) throw corrupt();
  const events = [], texts = [];
  for (const row of rows) {
    if (row.sequence !== events.length || !Object.hasOwn(row, "event") || typeof row.receivedAt !== "string") throw corrupt();
    events.push(row.event);
    texts.push(textDelta(row.event));
  }
  call.events = events;
  if (!call.text) call.text = texts.join("");
  call.journalRecovery = {
    incompleteTail: end !== bytes.length - 1,
    recoveredEvents: events.length,
    firstEventAt: rows[0]?.receivedAt ?? null,
    lastEventAt: rows.at(-1)?.receivedAt ?? null,
  };
  return call;
}
