import { createRequestJournal, recoverRequestJournal } from "./request-journal.js";
import { snapshotTeam } from "./teams.js";
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
export function taskDisplayStatus(record) {
  if(!record.cancelRequestedAt)return record.status;
  if(record.cancelStopError || record.nativeShutdownError || (record.work?.helpers??[]).some(h=>h.status==='outcome_unknown') || (record.tools??[]).some(t=>t.nativeBackground&&t.status==='outcome_unknown'))return 'stop_unknown';
  if(!record.cancelSettledAt || (record.work?.helpers??[]).some(h=>!h.stoppedAt) || (record.tools??[]).some(t=>t.nativeBackground&&!t.stoppedAt))return 'cancelling';
  return record.status;
}
export function createTask({
  home,
  input,
  models,
  team,
  singleModel = false,
  sessionId = null,
  branchId = null,
  persist,
  writeRequest,
  secrets = [],
  id = randomUUID(),
  submissionId,
  workRequest,
}) {
  const controller = new AbortController(),
    runtimes = new Set(),
    requests = new Map(),
    journals = new Map();
  const closeJournals = () => {
    for (const journal of journals.values()) journal.close();
  };
  const record = {
    formatVersion: 2,
    id,
    ...(submissionId ? { submissionId } : {}),
    createdAt: new Date().toISOString(),
    input,
    singleModel,
    ...(workRequest ? { workRequest: structuredClone(workRequest) } : {}),
    models: structuredClone(models),
    ...(team ? { team: snapshotTeam(team) } : {}),
    sessionId,
    branchId,
    mode: workRequest ? "work" : "answer",
    phase: "created",
    status: "running",
    maxCalls: workRequest ? null : singleModel ? 1 : 3,
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
    home,
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
      try {
        const folded = !["preparing", "in_flight"].includes(request.status);
        if (!writeRequest && !journals.has(request.id))
          journals.set(request.id, createRequestJournal(home, request));
        const snapshot = writeRequest ? request : {
          ...request,
          events: folded ? request.events : [],
          eventJournal: { version: 1, folded, ...(folded ? { count: request.events.length } : {}) },
        };
        const safe = redact(snapshot, [...secrets, ...(request._secrets ?? [])]);
        delete safe._secrets;
        if (writeRequest) writeRequest(safe);
        else {
          writePrivateJson(join(home, "requests", request.id + ".json"), safe);
          if (folded) journals.get(request.id).close();
        }
      } catch (error) {
        task.ioError = error;
        controller.abort(error);
        throw error;
      }
    },
    appendRequestEvent(request, event) {
      const safe = redact(event, [...secrets, ...(request._secrets ?? [])]);
      request.events.push(safe);
      try {
        if (writeRequest) task.writeRequest(request);
        else {
          if (!journals.has(request.id)) throw new Error("请求事件日志尚未初始化");
          journals.get(request.id).append(safe);
        }
      } catch (error) {
        task.ioError = error;
        controller.abort(error);
        throw error;
      }
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
      const helpers=record.work?.helpers??[],nativeTools=(record.tools??[]).filter(t=>t.kind==="native_plugin_tool");
      const unknownHelpers=helpers.filter(h=>(h.process||h.native)&&(!h.stoppedAt||!h.usage||typeof h.usage.cost!=='number')).length;
      const helperCost=unknownHelpers?null:helpers.reduce((sum,h)=>sum+(typeof h.usage?.cost==='number'?h.usage.cost:0),0);
      return {
        calls: calls.length,
        known,
        unknownCalls,
        cost: costUnknown ? null : cost,
        costSource: "catalog_estimate",
        ...(helpers.length ? {
          scope:"team_only",costScope:"team_only",
          helpers:{count:helpers.length,reportedTurns:helpers.every(h=>h.usage?.turns!==undefined)?helpers.reduce((sum,h)=>sum+h.usage.turns,0):null,
            unknownHelpers,cost:helperCost,costSource:"pi-subagents catalog-derived report"},
          totalCatalogCost:costUnknown||helperCost===null?null:cost+helperCost,
        } : {}),
        ...(nativeTools.length?{scope:"team_only",costScope:"team_only",nativeTools:{count:nativeTools.length,reportedUsage:nativeTools.map(t=>({toolCallId:t.toolCallId,usage:t.usage??null,source:t.usageSource??null}))},totalCatalogCost:null}:{}),
      };
    },
    finish(status, error) {
      if (record.cancelRequestedAt && status === "completed")
        throw problem("CANCELLED", "已取消任务不能完成");
      if(status === "completed" && (record.tools??[]).some(t=>t.kind==="native_plugin_result"&&(!["adopted","rejected"].includes(t.treatment?.decision)||(t.import&&(t.import.status!=="applied"||t.treatment?.decision!=="adopted")))))
        throw problem("PLUGIN_RESULTS_PENDING","Native plugin results/imports are not settled; preserved for creator review.");
      if(status === "completed" && (record.work?.helpers ?? []).some(h=>!h.stoppedAt || !["adopted","rejected"].includes(h.treatment?.decision) || (h.import && (h.import.status!=="applied" || h.treatment?.decision!=="adopted"))))
        throw problem("HELPERS_PENDING","助手或其成果尚未处理，不能完成整条任务");
      record.status = status;
      record.error = error;
      record.endedAt = new Date().toISOString();
      record.usage = task.usage();
      try { save(); } finally { closeJournals(); }
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
      // Helper tools may be what a parent abort is waiting on; propagate their stop first.
      const helperStop = task.helperLifecycle?.close();
      const stopped = await Promise.allSettled([...runtimes].map((r) => r.session.abort()));
      if(stopped.some(result=>result.status==='rejected')) record.cancelStopError='One or more runtime aborts did not confirm stop';
      try {await helperStop;}catch(error){record.cancelStopError=error.message;}
      record.cancelSettledAt=new Date().toISOString();
      closeJournals();
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
  for(const helper of record.work?.helpers ?? []) {
    if(["queued","starting","running"].includes(helper.status)) {
      helper.status="outcome_unknown";
      helper.error={message:"保存时助手尚未确认停止；不自动重发，不按PID终止进程。"};
    }
  }
  for(const operation of record.tools??[])if(operation.nativeBackground&&!operation.stoppedAt){operation.status="outcome_unknown";operation.error={message:"Native runner exit was not confirmed; no automatic replay or PID-only stop."};}
  return record;
}
export function readRequests(home, record) {
  return record.requestIds.map((id) => {
    if (typeof id !== "string" || !/^[\da-f-]{36}$/.test(id)) throw problem("INVALID_ID", "无效请求 ID");
    const call = JSON.parse(readFileSync(join(home, "requests", id + ".json"), "utf8"));
    if (call.id !== id || call.taskId !== record.id)
      throw problem("CORRUPT_REQUEST", "请求归属损坏");
    recoverRequestJournal(home, call);
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
