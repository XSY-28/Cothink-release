import { renderAnswerSkills } from "../context.js";
import { Type } from "typebox";
/** Answer routing is part of the first ordinary model request. */
export function cothinkExtension(host = {}) {
  return (pi) => {
    pi.on("before_agent_start", (event) => {
      const task = host.task;
      if (task?.record.status !== "running" || task.record.mode !== "answer")
        return;
      const material = renderAnswerSkills(task.answerSkills ?? []);
      const role = task.record.singleModel
        ? "This task uses ONE single-model mode. You are solely responsible for the complete final answer; no other model will review or revise it. Check key reasoning, original constraints and omissions before delivering, and make necessary corrections within this response. If the task enters work, you remain the sole Team owner; no formal secondary members are delegated. Installed managed plugin helpers may assist unless the user disabled helpers."
        : task.record.phase === "revision"
          ? "This is the CoThink revision stage. Independently assess the supplied review and deliver the complete final answer. Explain important accepted or rejected comments as instructed, and preserve unresolved disagreements."
          : "This is the CoThink initial-answer stage. Independently produce a complete draft for review, making key reasons, assumptions and uncertainty clear. A later review does not reduce your responsibility for this answer's completeness and accuracy.";
      return { systemPrompt: [event.systemPrompt, role, material].filter(Boolean).join("\n\n") };
    });
    pi.registerTool({
      name: "start_work",
      label: "开始工作",
      description:
        "开始实际工作；可声明scope/readScope，未知范围先观察，写入和Shell由agent-sync控制。",
      parameters: Type.Object({
        reason: Type.String(),
        deliverableKind: Type.Optional(Type.Literal("html-svg")),
        scope: Type.Optional(Type.Array(Type.String())),
        readScope: Type.Optional(Type.Array(Type.String())),
      }),
      async execute(id, args) {
        if (host.allowWork === false) throw Error("当前会话未关联项目，不能开始工作。请选择项目新建对话。");
        if (!host.task) throw Error("任务尚未绑定");
        if(args.deliverableKind) { await host.task.preflightVisual(); host.task.record.workRequest={kind:args.deliverableKind}; }
        host.task.record.mode = "work";
        host.task.record.maxCalls = null;
        host.task.record.workReason = args.reason;
        host.task.record.workIntent = {
          reason: args.reason,
          ...(args.scope ? { scope: args.scope } : {}),
          ...(args.readScope ? { readScope: args.readScope } : {}),
        };
        host.task.record.phase = "work_starting";
        try {
          host.task.save();
        } catch (error) {
          host.task.ioError = error;
          throw error;
        }
        host.runtime.stopAfterTurn();
        return {
          content: [
            { type: "text", text: "工作意图已保存；宿主正在绑定独立工作区。" },
          ],
          details: { handoff: true },
        };
      },
    });
    pi.on("agent_before_settle", () => {
      if (host.task?.record.mode === "work") return { continue: false };
    });
  };
}
