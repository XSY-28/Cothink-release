import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  AgentSessionRuntime,
  SessionManager,
  InteractiveMode,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { Text, matchesKey } from "@earendil-works/pi-tui";
import { createRuntime, selectedResources } from "./pi-runtime.js";
import { runTurn } from "./discussion.js";
import { cothinkExtension } from "./extensions/cothink.js";
import { createClipboardWriter } from "./clipboard.js";
import { saveConfig, switchMainModel } from "./config.js";
import { readTask, readRequests } from "./task.js";
import {
  projectMessage,
  detailsText,
  budgetText,
  inspectWork,
  releaseNotes,
} from "./presentation.js";
import {
  privateDirectory,
  writePrivateJson,
  releaseNotesSeen,
  markReleaseNotesSeen,
} from "./storage.js";
import { safeText } from "./terminal.js";
import {
  nativeCommands,
  nativeArgumentCommands,
  hostLocalCommands,
  singleLineCommand,
  isGenerationCommand,
  modelsAutocomplete,
} from "./setup.js";
export async function runInteractive({
  home,
  cwd = process.cwd(),
  config,
  continueRecent = false,
  resume = false,
  maxOutputTokens,
  timeout,
  terminal,
  resourceOptions = {},
}) {
  let current,
    active,
    busy = false,
    closed = false,
    mode,
    ui,
    draftRecovery,
    runAbort,
    currentSubmission;
  const configState = { value: structuredClone(config) };
  const contexts = new WeakMap();
  const saveDraft = () => {
    if (!mode) return;
    const text = mode.editor.getExpandedText?.() ?? mode.editor.getText();
    privateDirectory(join(home, "pi", "drafts"));
    writePrivateJson(
      join(
        home,
        "pi",
        "drafts",
        current.sessionManager.getSessionId() + ".json",
      ),
      {
        text,
      },
    );
  };
  const restoreDraft = () => {
    const path = join(
      home,
      "pi",
      "drafts",
      current.sessionManager.getSessionId() + ".json",
    );
    if (existsSync(path)) {
      const { text } = JSON.parse(readFileSync(path, "utf8"));
      mode.editor.setText(text);
    }
  };
  const notify = (text, type = "info") => ui?.notify(safeText(text), type);
  const cancel = async () => {
    runAbort?.abort();
    if (active) await active.cancel();
    await currentSubmission?.catch(() => {});
  };
  function trackedSubmit(text) {
    if (busy) return submit(text);
    currentSubmission = submit(text);
    return currentSubmission;
  }
  async function showDetails() {
    if (!ui) return;
    const ids = new Set(
      current.sessionManager
        .getBranch()
        .flatMap((e) =>
          e.message?.cothinkTaskId
            ? [e.message.cothinkTaskId]
            : e.details?.taskId
              ? [e.details.taskId]
              : e.type === "custom" && e.customType === "cothink-task"
                ? [e.data.taskId]
                : [],
        ),
    );
    if (busy && active) ids.add(active.record.id);
    const pages = [];
    for (const id of ids) {
      try {
        const live = busy && active?.record.id === id;
        const record = live
          ? structuredClone(active.record)
          : readTask(home, id);
        if (record.work && !live)
          record.workFacts = await inspectWork(home, record);
        pages.push(
          detailsText(
            record,
            live ? active.requests() : readRequests(home, record),
          ),
        );
      } catch (e) {
        pages.push("记录无法读取：" + e.message);
      }
    }
    const content = safeText(
      "完整讨论（只读，零模型调用；未完成阶段不代表最终交付）\nEsc 返回草稿 · ↑↓ / PageUp / PageDown 阅读\n\n" +
        pages.join("\n\n"),
    );
    await showReadOnly(content);
  }
  async function showChangelog() {
    try {
      await showReadOnly(
        "CoThink 完整更新记录\nEsc 返回输入界面 · ↑↓ / PageUp / PageDown 阅读\n\n" +
          releaseNotes().full,
      );
    } catch (error) {
      notify("更新记录无法读取：" + error.message, "error");
    }
  }
  async function showReadOnly(content) {
    await ui.custom(
      (tui, theme, keys, done) => {
        let offset = 0;
        const text = new Text(safeText(content), 1, 0);
        return {
          render(width) {
            const lines = text.render(width);
            const height = Math.max(3, tui.terminal.rows - 2);
            offset = Math.max(
              0,
              Math.min(offset, Math.max(0, lines.length - height)),
            );
            return lines.slice(offset, offset + height);
          },
          invalidate() {
            text.invalidate();
          },
          handleInput(data) {
            if (matchesKey(data, "escape") || matchesKey(data, "ctrl+o"))
              done();
            else if (matchesKey(data, "ctrl+c")) void cancel();
            else {
              offset += matchesKey(data, "pageDown")
                ? Math.max(1, tui.terminal.rows - 4)
                : matchesKey(data, "pageUp")
                  ? -Math.max(1, tui.terminal.rows - 4)
                  : matchesKey(data, "up")
                    ? -1
                    : matchesKey(data, "down")
                      ? 1
                      : 0;
              tui.requestRender();
            }
          },
        };
      },
      {
        overlay: true,
        overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center" },
      },
    );
  }
  async function modelsMenu() {
    let c = structuredClone(configState.value);
    const label = (r) => `${r.provider}/${r.modelId}`;
    const action = await ui.select(
      "模型设置（第一位副模型为问答评审，其余可参与工作）",
      [
        `主模型：${label(c.main)}`,
        "追加副模型",
        "删除副模型",
        "重排副模型",
        ...c.secondary.map((r, i) => `${i + 1}. ${label(r)}`),
      ],
    );
    if (!action) return;
    const choices = current.modelRuntime
      .getModels()
      .map((m) => `${m.provider}/${m.id}`);
    if (action.startsWith("主模型：") || action === "追加副模型") {
      const choice = await ui.select("选择模型（新认证请先 /login）", choices);
      if (!choice) return;
      const m = current.modelRuntime
        .getModels()
        .find((m) => `${m.provider}/${m.id}` === choice);
      const ref = { provider: m.provider, modelId: m.id };
      if (m.api === "anthropic-messages") {
        const cap = await ui.input("此协议要求 maxOutputTokens，请明确额度");
        if (!cap) return;
        ref.maxOutputTokens = Number(cap);
      }
      if (action.startsWith("主模型：")) c = switchMainModel(c, ref);
      else c.secondary.push(ref);
    } else if (action === "删除副模型") {
      const choice = await ui.select(
        "删除后后位自然补位",
        c.secondary.map(label),
      );
      if (!choice) return;
      c.secondary.splice(
        c.secondary.findIndex((r) => label(r) === choice),
        1,
      );
    } else if (action === "重排副模型") {
      const choice = await ui.select(
        "选择移到第一位的副模型（将改变评审席位）",
        c.secondary.map(label),
      );
      if (!choice) return;
      const i = c.secondary.findIndex((r) => label(r) === choice);
      c.secondary.unshift(...c.secondary.splice(i, 1));
    } else return;
    saveConfig(home, c);
    configState.value = c;
    notify("模型顺序已保存，将用于下一条任务。");
  }
  async function create({
    cwd: targetCwd = cwd,
    agentDir = join(home, "pi"),
    sessionManager,
  } = {}) {
    const hostContext = {};
    let rt;
    const extension = (pi) => {
      cothinkExtension(hostContext)(pi);
      pi.on("input", (event) => {
        // Extension-sent text bypasses the editor and must not smuggle a local
        // command into the session as a question (or append it to its history).
        if (event.source === "extension" && singleLineCommand(event.text)) {
          const command = singleLineCommand(event.text);
          if (!isGenerationCommand(command?.[1] ?? "", rt)) {
            notify(
              "扩展转发的本地或未知命令未进入模型。未发送模型请求。",
              "warning",
            );
            return { action: "handled" };
          }
        }
      });
      for (const event of [
        "session_before_switch",
        "session_before_fork",
        "session_before_tree",
      ])
        pi.on(event, () => {
          if (busy) {
            notify(
              "当前任务尚未结束，请先取消或等待；会话和草稿保留。",
              "warning",
            );
            return { cancel: true };
          }
          try {
            saveDraft();
            return {};
          } catch (error) {
            notify("草稿保存失败，已取消切换：" + error.message, "error");
            return { cancel: true };
          }
        });
      pi.on("session_tree", () => {
        if (!busy) active = undefined;
      });
      pi.on("model_select", (event) => {
        if (rt && !rt.applyingModel) {
          const next = switchMainModel(configState.value, {
            provider: event.model.provider,
            modelId: event.model.id,
          });
          saveConfig(home, next);
          configState.value = next;
          notify("主模型选择已保存，用于下一条任务。");
        }
      });
      pi.on("session_start", (_, ctx) => {
        ui = ctx.ui;
        ui.addAutocompleteProvider(modelsAutocomplete);
        ui.onTerminalInput((data) =>
          data === "\x1b\r" ? { data: "\x1b[13;2u" } : undefined,
        );
        ui.setHeader(() => new Text("CoThink", 1, 0));
        ui.setWidget("cothink-budget", [
          budgetText(configState.value, false, { maxOutputTokens, timeout }),
        ]);
      });
      for (const [name, description, handler] of [
        ["chat", "查看完整讨论", showDetails],
        ["models", "设置主模型和有序副模型", modelsMenu],
        [
          "one",
          "本条仅使用主模型",
          async (args) => {
            if (args) await trackedSubmit("/one " + args);
            else notify("用法：/one <任务>");
          },
        ],
      ])
        pi.registerCommand(name, { description, handler });
    };
    rt = await createRuntime({
      home,
      cwd: targetCwd,
      modelRef: configState.value.main,
      sessionManager,
      extensionFactories: [{ name: "cothink", factory: extension }],
      resourceOptions: {
        ...selectedResources(configState.value, targetCwd),
        ...resourceOptions,
        systemPrompt: readFileSync(
          new URL("../prompts/main.md", import.meta.url),
          "utf8",
        ),
      },
      maxOutputTokens,
      timeout,
    });
    rt.hostContext = (task) => {
      hostContext.task = task;
      hostContext.runtime = rt;
    };
    contexts.set(rt.session, rt);
    rt.session.subscribe((event) => {
      const model = rt.session.model;
      const main = configState.value.main;
      if (
        event.type === "thinking_level_changed" &&
        !rt.applyingModel &&
        model?.provider === main.provider &&
        model.id === main.modelId
      ) {
        const next = structuredClone(configState.value);
        next.main.thinkingLevel = event.level;
        saveConfig(home, next);
        configState.value = next;
      }
    });
    for (const name of ["chat", "models", "one"]) {
      const owners = rt.services.resourceLoader
        .getExtensions()
        .extensions.filter((e) => e.commands.has(name));
      if (owners.length > 1) {
        rt.dispose();
        throw Error(
          `命令 /${name} 与第三方扩展冲突，请先调整扩展；不会静默覆盖。`,
        );
      }
    }
    return rt;
  }
  async function submit(text) {
    // Final boundary: a local/unknown slash command must never create a model task,
    // even when input arrives through a native fallback instead of beforeSubmit.
    if (singleLineCommand(text)) {
      const command = singleLineCommand(text);
      const one = /^\/one[ \t]+\S/.test(text.trimStart());
      if (!one && !isGenerationCommand(command?.[1] ?? "", current)) {
        notify(
          "本地或未知命令未进入模型；请检查命令格式。未发送模型请求。",
          "warning",
        );
        mode?.editor.setText(text);
        return;
      }
    }
    if (busy) {
      notify("当前任务尚未结束，草稿保留，不自动排队。", "warning");
      return;
    }
    const snapshot = structuredClone(configState.value);
    busy = true;
    runAbort = new AbortController();
    active = undefined;
    const draft = mode?.editor.getExpandedText?.() ?? text;
    try {
      await current.selectModel(snapshot.main);
      active = undefined;
      await runTurn({
        home,
        cwd: current.services.cwd,
        input: text,
        config: snapshot,
        mainRuntime: current,
        signal: runAbort.signal,
        maxOutputTokens,
        timeout,
        onProgress: (event) => {
          active = event.task;
          if (event.type === "git")
            notify(
              event.operation.explanation +
                " 文件：" +
                (event.operation.changedFiles.join(", ") || "无变化"),
            );
          ui?.setStatus(
            "cothink-task",
            `${active.record.phase} · ${active.usage().calls} 次 · 未知 ${active.usage().unknownCalls}`,
          );
        },
      }).then((task) => {
        active = task;
        if (task.record.status !== "completed") {
          notify(
            `未完成（${task.record.status}）：${task.record.error}；/chat 查看部分结果。`,
            "warning",
          );
          if (task.recovery)
            notify(
              "记录保存失败，恢复副本：" + JSON.stringify(task.recovery),
              "error",
            );
        }
      });
    } catch (e) {
      mode?.editor.setText(draft || text);
      notify(e.message, "error");
    } finally {
      busy = false;
      current.unbindTask();
      ui?.setStatus(
        "cothink-task",
        active
          ? `${active.record.status} · ${active.usage().calls} 次 · ${active.usage().unknownCalls} 次未知`
          : "就绪",
      );
      saveDraft();
    }
  }
  const manager = continueRecent
    ? SessionManager.continueRecent(cwd, join(home, "pi", "sessions", "main"))
    : undefined;
  current = await create({ sessionManager: manager });
  const runtimeHost = new AgentSessionRuntime(
    current.session,
    current.services,
    async (options) => {
      const rt = await create(options);
      return {
        session: rt.session,
        services: rt.services,
        extensionsResult: rt.services.resourceLoader.getExtensions(),
        diagnostics: rt.services.diagnostics,
      };
    },
  );
  initTheme("dark");
  const copyText = createClipboardWriter();
  const host = {
    submit: trackedSubmit,
    isBusy: () => busy,
    cancel,
    showDetails,
    project: (message) => projectMessage(home, message),
    async beforeSubmit(text) {
      const command = singleLineCommand(text);
      const name = command?.[1];
      if (
        command?.[2] &&
        (hostLocalCommands.has(name) ||
          (nativeCommands.has(name) && !nativeArgumentCommands.has(name)))
      ) {
        notify(
          `/${name === "model" ? "models" : name} 不接受参数；请单独输入 /${name === "model" ? "models" : name}。未发送模型请求。`,
          "warning",
        );
        return false;
      }
      if (
        !text.includes("\n") &&
        ["/chat", "/changelog", "/models", "/model", "/one", "/help"].includes(
          text.trim(),
        )
      ) {
        if (text.trim() === "/chat") await showDetails();
        else if (text.trim() === "/changelog") await showChangelog();
        else if (name === "models" || name === "model") await modelsMenu();
        else
          notify(
            text.trim() === "/one"
              ? "用法：/one <任务>"
              : "/one 本条单模型；/models 设置；/chat 或 Ctrl+O 详情；/changelog 更新记录；Esc / Ctrl+C 取消；/new /resume /fork /tree /reload 复用 Pi。",
          );
        mode.editor.setText("");
        return false;
      }
      if (busy) return true;
      if (!text.includes("\n") && text.startsWith("!")) {
        notify(
          "直接 ! Shell 未开放；请在任务中描述需要执行的命令，由受管工作工具执行。",
          "warning",
        );
        return false;
      }
      if (!text.includes("\n") && text.startsWith("/")) {
        const name = text.slice(1).split(/\s/)[0];
        if (name === "compact") {
          notify(
            "手动压缩会调用模型，尚未在此预览版开放；请 /new 或保留会话。",
            "warning",
          );
          return false;
        }
        if (
          !nativeCommands.has(name) &&
          current.session.extensionRunner
            .getRegisteredCommands()
            .some((c) => c.name === name)
        ) {
          mode.editor.setText("");
          // Pi's public prompt entry executes a registered command before generation.
          // No CoThink task/binding is created for a local extension handler.
          await current.session.prompt(text);
          return false;
        }
        if (!nativeCommands.has(name) && !isGenerationCommand(name, current)) {
          notify("未知命令；未发送模型请求。", "warning");
          return false;
        }
        if (
          [
            "new",
            "resume",
            "fork",
            "tree",
            "reload",
            "quit",
            "import",
          ].includes(name)
        )
          saveDraft();
      }
      return true;
    },
    async rebind(session) {
      current = contexts.get(session);
      mode.editor.setText("");
      active = undefined;
      busy = false;
      if (!current) throw Error("Pi session 未绑定 CoThink runtime");
      restoreDraft();
    },
    async beforeExit() {
      try {
        saveDraft();
      } catch (error) {
        draftRecovery = {
          text: mode.editor.getExpandedText?.() ?? mode.editor.getText(),
          error: error.message,
        };
      }
      closed = true;
      return true;
    },
    afterStop() {
      if (active?.recovery)
        process.stderr.write(
          safeText(
            "恢复副本（记录未保存，尚未完整交付）：\n" +
              JSON.stringify(active.recovery),
          ) + "\n",
        );
      if (draftRecovery)
        process.stderr.write(
          safeText("草稿未保存，恢复副本：\n" + JSON.stringify(draftRecovery)) +
            "\n",
        );
    },
    async copySelection(text) {
      if (closed) throw Error("终端已关闭");
      await copyText(text);
      if (closed) throw Error("终端已关闭");
    },
  };
  mode = new InteractiveMode(runtimeHost, {
    terminal,
    host,
    tuiMode: "fullscreen",
  });
  await mode.init();
  restoreDraft();
  try {
    const notes = releaseNotes();
    if (!releaseNotesSeen(home, notes.version)) {
      notify(notes.summary);
      markReleaseNotesSeen(home, notes.version);
    }
  } catch (error) {
    notify(
      "更新摘要状态无法保存或读取：" +
        error.message +
        "；可用 /changelog 查看记录。",
      "warning",
    );
  }
  if (resume) mode.showSessionSelector();
  await mode.run();
  return 0;
}
