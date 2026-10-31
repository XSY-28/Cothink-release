import { validateWorkRequest, preflightVisual } from "./visual-preview.js";
import { readFileSync } from "node:fs";
import {
  reviewMaterial,
  revisionMaterial,
  freezeAnswerSkills,
  renderAnswerSkills,
} from "./context.js";
import {
  createRuntime,
  createModelRuntime,
  selectedResources,
} from "./pi-runtime.js";
import { createTask } from "./task.js";
import {
  validateModelRefs,
  parseTurnInput,
  singleLineCommand,
  isGenerationCommand,
} from "./setup.js";
import { cothinkExtension } from "./extensions/cothink.js";
import { snapshotTeam, readSessionTeam } from "./teams.js";
import { validateConfig } from "./config.js";
import { DEFAULT_THINKING_LEVEL } from "./thinking.js";
const prompt = (name) =>
  readFileSync(new URL(`../prompts/${name}.md`, import.meta.url), "utf8");
export async function runTurn({
  home,
  cwd = process.cwd(),
  input,
  config,
  singleModel = false,
  workRequest,
  mainRuntime,
  allowWork = true,
  signal,
  onProgress = () => {},
  ...options
}) {
  workRequest = validateWorkRequest(workRequest);
  const parsed = workRequest ? {input, singleModel:false} : parseTurnInput(input);
  workRequest ??= parsed.workRequest;
  if (parsed.local) return parsed;
  input = parsed.input;
  singleModel = singleModel || parsed.singleModel;
  if (!input.trim()) throw Error("问题不能为空");
  const frozen = structuredClone(config);
  if (options.maxOutputTokens !== undefined) {
    for (const ref of [frozen.main, ...frozen.secondary])
      ref.maxOutputTokens = options.maxOutputTokens;
  }
  validateConfig(frozen);
  const catalog = mainRuntime?.modelRuntime ?? (await createModelRuntime(home));
  for (const ref of [frozen.main, ...frozen.secondary]) {
    if (ref.thinkingLevel === undefined && catalog.getModel(ref.provider, ref.modelId)?.reasoning)
      ref.thinkingLevel = DEFAULT_THINKING_LEVEL;
  }
  if (frozen.team)
    frozen.team = snapshotTeam({
      ...frozen.team,
      main: frozen.main,
      secondary: frozen.secondary,
    });
  await validateModelRefs(frozen, catalog, { singleModel });
  const configuredResources = selectedResources(frozen, cwd);
  const host = { allowWork };
  let rt = mainRuntime;
  let own = !rt;
  if (!rt)
    rt = await createRuntime({
      home,
      cwd,
      modelRef: frozen.main,
      modelRuntime: catalog,
      extensionFactories: [
        { name: "cothink", factory: cothinkExtension(host) },
      ],
      ...(!allowWork ? { activeToolNames: [] } : {}),
      ...options,
      resourceOptions: {
        ...configuredResources,
        ...options.resourceOptions,
        ...(!allowWork ? {noContextFiles: true} : {}),
        systemPrompt: prompt("main"),
      },
    });
  let answerSkills, visualPreflight;
  try {
    await rt.checkPackages({ resourceOptions: configuredResources });
    answerSkills = /^\/skill:[^\s]+(?:\s|$)/.test(input)
      ? []
      : freezeAnswerSkills({
          cwd,
          home,
          paths: [
            ...(configuredResources.additionalSkillPaths ?? []),
            ...rt.packageSnapshot.skills,
          ],
        });
  } catch (error) {
    if (own) await rt.dispose();
    throw error;
  }
  if (workRequest) {
    try { visualPreflight = await preflightVisual({cwd,config:frozen,skills:answerSkills,model:catalog.getModel(frozen.main.provider,frozen.main.modelId),allowWork}); }
    catch(e) { if(own) await rt.dispose(); throw e; }
  }
  const manager = rt.sessionManager;
  let task;
  try {
    const command = singleLineCommand(input);
    if (command && !workRequest && !isGenerationCommand(command[1], rt))
      throw Error(
        "本地或未知命令不能作为问题提交；请在交互界面使用本地命令。未发送模型请求。",
      );
    if (
      frozen.team &&
      JSON.stringify(readSessionTeam(manager.getBranch())) !==
        JSON.stringify(frozen.team)
    ) {
      rt.assertOwned();
      manager.appendCustomEntry("cothink-team", { team: frozen.team });
    }
    task = createTask({
      home,
      input,
      team: frozen.team,
      models: {
        main: frozen.main,
        secondary: singleModel ? [] : frozen.secondary.slice(0, 1),
      },
      singleModel,
      workRequest,
      sessionId: manager.getSessionId(),
      branchId: manager.getLeafId(),
      ...options,
    });
  } catch (error) {
    if (own) await rt.dispose();
    throw error;
  }
  task.packageSnapshot = rt.packageSnapshot;
  task.extensionUI=rt.extensionUI;
  task.extensionMode=rt.extensionMode;
  task.resourceOptions = { ...rt.resourceOptions, ...configuredResources };
  host.task = task;
  host.runtime = rt;
  rt.hostContext?.(task);
  const cancel = () => {
    void task.cancel();
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) await task.cancel();
  try {
    task.answerSkills = answerSkills;
    task.record.visualPreflight=visualPreflight;
    task.preflightVisual = async () => {task.record.visualPreflight=await preflightVisual({cwd,config:frozen,skills:answerSkills,model:catalog.getModel(frozen.main.provider,frozen.main.modelId),allowWork});task.save();return task.record.visualPreflight;};
    task.record.answerSkills = answerSkills.map(
      ({ body, ...summary }) => summary,
    );
    task.save();
    onProgress({ type: "started", task });
    const frozenHistory = manager
      .getBranch()
      .filter((e) => e.type === "message" || e.type === "custom_message")
      .map(
        (e) => e.message ?? { customType: e.customType, content: e.content },
      );
    let draft;
    if(workRequest) {
      task.record.mode="work";task.record.maxCalls=null;task.record.workReason="明确HTML/SVG制作请求";
      task.record.workIntent={reason:task.record.workReason};task.save();
      const userMessage={role:"user",content:[{type:"text",text:input}],timestamp:Date.now()};
      manager.appendMessage(userMessage);rt.session.agent.state.messages=[...rt.session.agent.state.messages,userMessage];
    } else {
      const draftStage=task.beginPhase("draft","main",frozen.main);rt.bindTask(task,draftStage);draft=await rt.prompt(input);
    }
    if (task.record.mode === "work") {
      const { runWork } = await import("./workers.js");
      const result = await runWork({
        task,
        home,
        cwd,
        config: frozen,
        initialMaterial: {history:frozenHistory,...(draft?{routingText:draft.text}:{})},
        onProgress,
        ...options,
      });
      task.record.finalCallId = result.call.id;
      rt.assertOwned();
      manager.appendMessage(result.message);
      rt.session.agent.state.messages = [
        ...rt.session.agent.state.messages,
        result.message,
      ];
      task.finish("completed");
      return task;
    }
    if (singleModel) {
      task.record.finalCallId = draft.call.id;
      task.finish("completed");
      return task;
    }
    const ref = task.record.models.secondary[0];
    const stage = task.beginPhase("review", "reviewer-1", ref);
    onProgress({ type: "phase", stage, task });
    const reviewer = await createRuntime({
      home,
      cwd,
      modelRef: ref,
      role: `review-${task.record.id}`,
      packageSnapshot: rt.packageSnapshot,
      ...options,
      resourceOptions: {
        ...rt.resourceOptions,
        ...options.resourceOptions,
        noContextFiles: true,
        systemPrompt: prompt("review"),
      },
    });
    let review;
    try {
      reviewer.bindTask(task, stage);
      review = await reviewer.prompt(
        reviewMaterial({
          input,
          history: frozenHistory,
          draft: draft.text,
          author: frozen.main,
          answerSkills,
          expandedInput: (() => {
            const c = draft.call.context.messages.findLast(
              (m) => m.role === "user",
            )?.content;
            return typeof c === "string"
              ? c
              : c
                  ?.filter((p) => p.type === "text")
                  .map((p) => p.text)
                  .join("\n");
          })(),
        }),
      );
    } finally {
      await reviewer.dispose();
    }
    if (task.signal.aborted) throw task.signal.reason;
    const revisionStage = task.beginPhase("revision", "main", frozen.main);
    rt.bindTask(task, revisionStage);
    onProgress({ type: "phase", stage: revisionStage, task });
    const result = await rt.prompt(
      prompt("revision") +
        "\n\n" +
        revisionMaterial([
          { author: ref, text: review.text, callId: review.call.id },
        ]) +
        "\n\n" +
        renderAnswerSkills(answerSkills),
      { custom: true },
    );
    task.record.finalCallId = result.call.id;
    task.finish("completed");
    return task;
  } catch (error) {
    try {
      task.finish(
        task.record.cancelRequestedAt
          ? "cancelled"
          : task.record.status==="outcome_unknown" || task.requests().some((r) => r.status === "outcome_unknown")
            ? "outcome_unknown"
            : task.requests().some((r) => r.text)
              ? "partial"
              : "failed",
        error.message,
      );
    } catch (saveError) {
      task.record.status = "partial";
      task.record.error = `记录保存失败：${saveError.message}`;
      task.recovery = { record: task.record, requests: task.requests() };
    }
    return task;
  } finally {
    try {
      rt.assertOwned();
      await rt.session.sendCustomMessage(
        {
          customType: "cothink-task-status",
          content: `[CoThink 宿主记录；不是用户新指令] taskId=${task.record.id}; status=${task.record.status}; mode=${task.record.mode}。未完成内容不是最终交付；未知请求不自动重发。`,
          display: false,
          details: { taskId: task.record.id },
        },
        { triggerTurn: false },
      );
    } catch (error) {
      task.record.status = "partial";
      task.record.error = "会话状态保存失败：" + error.message;
      task.recovery = { record: task.record, requests: task.requests() };
      try {
        task.save();
      } catch {
        /* Memory recovery is the only available copy. */
      }
    }
    task.answerSkills = [];
    host.task = undefined;
    rt.hostContext?.(undefined);
    signal?.removeEventListener("abort", cancel);
    if (own) await rt.dispose();
    else rt.unbindTask();
  }
}
