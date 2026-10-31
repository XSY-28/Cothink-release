export const modelName = (model) =>
  model ? `${model.provider} / ${model.modelId}` : "来源未记录";
export function elapsedLabel(task, now = Date.now()) {
  const start = Date.parse(task?.createdAt),
    end = task?.status === "running" ? now : Date.parse(task?.endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    return "用时未知";
  const seconds = Math.floor((end - start) / 1000);
  return seconds < 60
    ? `${seconds}秒`
    : `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, "0")}秒`;
}
export const statusLabel = (value) =>
  ({
    running: "进行中",
    preparing: "准备中",
    in_flight: "请求进行中",
    not_sent: "尚未发送",
    partial: "部分完成",
    blocked: "受阻",
    queued: "等待启动",
    starting: "正在启动",
    waiting: "等待中",
    unknown: "结果未知",
    rejected: "已拒绝",
    abandoned: "已放弃",
    basis_changed: "基础版本已变化",
    review_required: "需要评审",
    no_write_change: "无写入变更",
    completed: "已完成",
    failed: "失败",
    cancelled: "已停止",
    cancelling: "正在停止",
    stop_unknown: "停止未确认",
    canceled: "已停止",
    outcome_unknown: "结果未知",
    not_called: "尚未调用",
    succeeded: "已完成",
    passed: "通过",
    accepted: "已接纳",
    pending: "等待中",
    recorded: "已记录",
  })[value] ||
  value ||
  "未记录";
export const phaseLabel = (value) =>
  ({
    draft: "主答初稿",
    review: "评审",
    revision: "主答修订",
    answer: "主答",
    work: "项目工作",
    work_starting: "准备项目",
    work_main: "主模型工作",
    work_member: "成员工作",
    member: "成员工作",
    created: "任务已建立",
    initial: "主答中",
    worker: "成员工作",
    "worker-feedback": "成员处理反馈",
    "worker-prepare": "成员独立理解",
    "worker-conflict-resolution": "成员核对更正",
    "visual-review": "独立视觉审查",
  })[value] ||
  value ||
  "等待阶段记录";
export function shouldSubmit(event) {
  return (
    event.key === "Enter" &&
    !event.isComposing &&
    event.keyCode !== 229 &&
    !event.shiftKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey
  );
}
export function checkLabel(check) {
  if (!check) return "未记录检查";
  if (check.status !== "passed") return `未通过 · ${statusLabel(check.status)}`;
  if (check.verification !== "passed") return "未验证（空检查策略）";
  return check.reusedFrom ? "通过（复用既有检查）" : "通过";
}
// Local unsent text must survive background snapshots and a late submit response.
export function createDraftBook() {
  const drafts = new Map();
  return {
    load(id, text) {
      if (!drafts.has(id))
        drafts.set(id, { sessionId: id, text: text || "", revision: 0 });
      return drafts.get(id).text;
    },
    edit(id, text) {
      const prior = drafts.get(id);
      drafts.set(id, {
        sessionId: id,
        text,
        revision: (prior?.revision || 0) + 1,
      });
    },
    snapshot(id) {
      return { ...drafts.get(id) };
    },
    accepted(sent) {
      const now = drafts.get(sent.sessionId);
      if (now?.revision === sent.revision)
        drafts.set(sent.sessionId, {
          ...now,
          text: "",
          revision: now.revision + 1,
        });
    },
  };
}
export { revisionExplanation } from "../../src/final-answer.js";
export function outputReferences(value) {
  const refs = new Set();
  const visit = (v) => {
    if (v && typeof v === "object")
      for (const [key, item] of Object.entries(v)) {
        if (key === "outputRef" && typeof item === "string") refs.add(item);
        else visit(item);
      }
  };
  visit(value);
  return [...refs];
}
