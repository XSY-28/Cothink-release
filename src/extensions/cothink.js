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
      if (material)
        return { systemPrompt: `${event.systemPrompt}\n\n${material}` };
    });
    pi.registerTool({
      name: "start_work",
      label: "开始工作",
      description:
        "开始实际工作；可声明scope/readScope，未知范围先观察，写入和Shell由agent-sync控制。",
      parameters: Type.Object({
        reason: Type.String(),
        scope: Type.Optional(Type.Array(Type.String())),
        readScope: Type.Optional(Type.Array(Type.String())),
      }),
      async execute(id, args) {
        if (!host.task) throw Error("任务尚未绑定");
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
