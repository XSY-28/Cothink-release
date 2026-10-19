import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { privateDirectory, writePrivateJson, redact } from "./storage.js";
const terminal = new Set([
  "completed",
  "cancelled",
  "partial",
  "failed",
  "outcome_unknown",
  "blocked",
]);
export const problem = (code, message) => Object.assign(new Error(message), { code });
export function createTask({
  home,
  input,
  models,
  singleModel = false,
  sessionId = null,
  branchId = null,
  persist,
  writeRequest,
  secrets = [],
}) {
  const controller = new AbortController(),
    runtimes = new Set(),
    requests = new Map();
  const record = {
    formatVersion: 2,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    input,
    singleModel,
    models: structuredClone(models),
    sessionId,
    branchId,
    mode: "answer",
    phase: "created",
    status: "running",
    maxCalls: singleModel ? 1 : 3,
    stages: [],
    requestIds: [],
    finalCallId: null,
  };
  const directory = join(home, "tasks");
  privateDirectory(directory);
  privateDirectory(join(home, "requests"));
  const save = () => {
    const safe = redact(record, secrets);
    if (persist) persist(safe);
    else writePrivateJson(join(directory, record.id + ".json"), safe);
  };
  const task = {
    record,
    signal: controller.signal,
    save,
    runtimes,
    beginPhase(phase, role, modelRef) {
      if (controller.signal.aborted || terminal.has(record.status))
        throw problem("CANCELLED", "任务已停止");
      const stage = {
        id: randomUUID(),
        displayId: randomUUID(),
        phase,
        role,
        modelRef: structuredClone(modelRef),
        status: "running",
        callIds: [],
      };
      record.phase = phase;
      record.stages.push(stage);
      save();
      return stage;
    },
    register(request) {
      requests.set(request.id, request);
      record.requestIds.push(request.id);
    },
    writeRequest(request) {
      const safe = redact(request, [...secrets, ...(request._secrets ?? [])]);
      delete safe._secrets;
      if (writeRequest) writeRequest(safe);
      else writePrivateJson(join(home, "requests", request.id + ".json"), safe);
    },
    requests() {
      return [...requests.values()].map((r) => {
        const safe = redact(r, [...secrets, ...(r._secrets ?? [])]);
        delete safe._secrets;
        return safe;
      });
    },
    usage() {
      const calls = [...requests.values()].filter((r) => r.sent);
      const known = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      let unknownCalls = 0,
        cost = 0,
        costUnknown = false;
      for (const call of calls) {
        if (call.usage) {
          for (const key of Object.keys(known)) known[key] += call.usage[key] ?? 0;
        } else unknownCalls++;
        if (typeof call.estimatedCost === "number") cost += call.estimatedCost;
        else costUnknown = true;
      }
      return {
        calls: calls.length,
        known,
        unknownCalls,
        cost: costUnknown ? null : cost,
        costSource: "catalog_estimate",
      };
    },
    finish(status, error) {
      if (record.cancelRequestedAt && status === "completed")
        throw problem("CANCELLED", "已取消任务不能完成");
      record.status = status;
      record.error = error;
      record.endedAt = new Date().toISOString();
      record.usage = task.usage();
      save();
    },
    stop(error) {
      record.stopReason = error.message;
      try {
        save();
      } finally {
        controller.abort(error);
      }
    },
    async cancel() {
      if (terminal.has(record.status)) return;
      record.cancelRequestedAt = new Date().toISOString();
      record.status = "cancelled";
      const recover = (error) => {
        record.status = "partial";
        record.error = "取消记录保存失败：" + error.message;
        task.recovery = { record, requests: task.requests() };
      };
      try {
        save();
      } catch (error) {
        recover(error);
      } finally {
        controller.abort(problem("CANCELLED", "用户取消整条任务；远端结果可能未知，不自动重发。"));
      }
      await Promise.allSettled([...runtimes].map((r) => r.session.abort()));
      record.usage = task.usage();
      try {
        save();
      } catch (error) {
        recover(error);
      }
    },
  };
  save();
  return task;
}
export function readTask(home, id) {
  if (!/^[\da-f-]{36}$/.test(id)) throw problem("INVALID_ID", "无效任务 ID");
  const record = JSON.parse(readFileSync(join(home, "tasks", id + ".json"), "utf8"));
  if (record.id !== id || record.formatVersion !== 2 || !Array.isArray(record.stages))
    throw problem("CORRUPT_TASK", "任务记录损坏，原文件保留");
  if (record.status === "running") {
    record.status = "outcome_unknown";
    record.error = "进程可能已中断或仍在运行；不自动重发。";
  }
  return record;
}
export function readRequests(home, record) {
  return record.requestIds.map((id) => {
    const call = JSON.parse(readFileSync(join(home, "requests", id + ".json"), "utf8"));
    if (call.id !== id || call.taskId !== record.id)
      throw problem("CORRUPT_REQUEST", "请求归属损坏");
    if (["preparing", "in_flight"].includes(call.status))
      call.status = call.sent ? "outcome_unknown" : "not_sent";
    return call;
  });
}
export function listTasks(home) {
  let files;
  try {
    files = readdirSync(join(home, "tasks"));
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  return files
    .filter((n) => n.endsWith(".json"))
    .map((n) => readTask(home, n.slice(0, -5)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
