import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  AgentSessionRuntime,
  SessionManager,
  InteractiveMode,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { Text, matchesKey } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { createRuntime, createModelRuntime, selectedResources } from "./pi-runtime.js";
import { runTurn } from "./discussion.js";
import { cothinkExtension } from "./extensions/cothink.js";
import { createClipboardWriter } from "./clipboard.js";
import { loadConfig, updateConfig, switchMainModel } from "./config.js";
import { addTeam, removeTeam, selectTeam, snapshotTeam, resolveTeamConfig, readSessionTeam, normalizeTeamName } from "./teams.js";
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
  selectModelRef,
  validateModelRefs,
} from "./setup.js";
export async function runInteractive({
  home,
  cwd = process.cwd(),
  config,
  continueRecent = false,
  resume = false,
  thinkingLevel,
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
  const initial = config.formatVersion === 3 ? resolveTeamConfig(config) : structuredClone(config);
  if (thinkingLevel !== undefined) {
    for (const ref of [initial.main, ...initial.secondary]) ref.thinkingLevel = thinkingLevel;
    if (initial.team) initial.team = snapshotTeam({ ...initial.team, main: initial.main, secondary: initial.secondary });
  }
  const configState = { value: initial };
  let managing = false;
  const rosterKey = (c) => JSON.stringify([c.main, ...c.secondary].map(r => [r.provider, r.modelId]));
  const modelLabel = (r) => `${r.provider}/${r.modelId}`;
  const teamLabel = (t) => `${t.name} · ${modelLabel(t.main)} → ${t.secondary.map(modelLabel).join("、")}`;
  const currentTeam = () => configState.value.team;
  function refreshTeamStatus() {
    const team = currentTeam();
    const registered = team && loadConfig(home)?.teams?.some(t => t.id === team.id);
    ui?.setStatus("cothink-team", team ? safeText(`team：${team.name}${registered ? "" : "（已从列表删除，仅当前阵容保留）"}`) : "此历史会话尚未绑定 team");
    ui?.setWidget("cothink-budget", [budgetText(configState.value, false, {maxOutputTokens,timeout})]);
    if(current?.packageError) ui?.setStatus("cothink-packages", safeText(current.packageError.message));
  }
  function rememberRecent(team) {
    const latest = loadConfig(home);
    if (latest?.formatVersion !== 3 || !team || !latest.teams.some(t => t.id === team.id)) return;
    if (latest.lastUsedTeamId !== team.id) updateConfig(home, c => selectTeam(c, team.id));
  }
  function persistSelection(rt, team) {
    rt.assertOwned();
    if (JSON.stringify(readSessionTeam(rt.sessionManager.getBranch())) !== JSON.stringify(team)) {
      try { rt.sessionManager.appendCustomEntry("cothink-team", {team: snapshotTeam(team)}); }
      catch (error) {
        rt.selectionError = "会话选择保存失败，请重新打开对话；草稿保留：" + error.message;
        throw Error(rt.selectionError);
      }
    }
  }
  function sessionWriteIncomplete(rt) {
    const path = rt.sessionManager.getSessionFile();
    if (!path || !existsSync(path)) return false; // A new empty session is intentionally buffered.
    try {
      const entries = readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
      return !entries.some(entry => entry.id === rt.sessionManager.getLeafId());
    } catch { return true; }
  }

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
  async function applyTeamSelection(team) {
    if (busy) throw Error("当前任务尚未结束，请先取消或等待。");
    if (current.selectionError) throw Error(current.selectionError);
    const selected = snapshotTeam(team), latest = loadConfig(home);
    const next = resolveTeamConfig(latest, selected), before = configState.value;
    if (!latest.teams.some(t => t.id === selected.id) && selected.id !== before.team?.id)
      throw Error("team 已被其他实例删除，请刷新列表。");
    await validateModelRefs(next, current.modelRuntime);
    try {
      current.assertOwned();
      await current.selectModel(next.main);
      persistSelection(current, selected);
    } catch (error) {
      // Pi appends to its in-memory tree before persistence. Never append a
      // rollback node to a parent that failed to reach disk.
      if (current.selectionError || sessionWriteIncomplete(current)) {
        current.selectionError ??= "模型/会话记录保存失败，请重新打开对话；草稿保留：" + error.message;
      } else {
        try { current.assertOwned(); await current.selectModel(before.main); }
        catch (restoreError) { current.selectionError = "模型恢复失败，请重新打开对话：" + restoreError.message; }
      }
      throw error;
    }
    current.effectiveConfig = configState.value = next;
    current.needsTeam = false;
    try { rememberRecent(selected); }
    catch (error) { notify("当前对话已切换，新对话默认未更新：" + error.message, "warning"); }
    refreshTeamStatus();
    notify("当前 team：" + selected.name + "；从下一条任务生效。");
  }
  const modelIO = () => ({
    async select(title, options) {
      const labels = options.map(o => o.label);
      const answer = await ui.select(safeText(title), labels.map(safeText));
      return options[labels.map(safeText).indexOf(answer)]?.id;
    },
    async prompt(field) {
      if (field.type === "secret") throw Error("新认证请先使用 /login，再创建 team；已有认证会复用。");
      return ui.input(safeText(field.message ?? "请输入"));
    },
    notify(message) { notify(message); },
  });
  async function chooseModel(draft, role) {
    const models = current.modelRuntime.getModels().filter(m => (!m.type || m.type === "chat") && current.modelRuntime.hasConfiguredAuth(m.provider));
    const labels = models.map(m => `${m.provider}/${m.id}`);
    const choice = await ui.select("选择模型（已有认证复用；新认证请先 /login）", [...labels, "配置服务商或模型"]);
    if (!choice) return null;
    if (choice === "配置服务商或模型")
      return selectModelRef({runtime:current.modelRuntime,home,io:modelIO(),role});
    const model = models[labels.indexOf(choice)];
    const saved = [draft.main, ...draft.secondary, configState.value.main, ...configState.value.secondary,
      ...(loadConfig(home)?.teams ?? []).flatMap(t => [t.main, ...t.secondary])]
      .find(r => r && r.provider === model.provider && r.modelId === model.id);
    const ref = structuredClone(saved ?? {provider:model.provider,modelId:model.id});
    if (model.api === "anthropic-messages" && ref.maxOutputTokens == null) {
      const cap = await ui.input("此协议要求 maxOutputTokens，请明确额度");
      if (!cap) return null;
      ref.maxOutputTokens = Number(cap);
    }
    return ref;
  }
  async function modelsMenu({selected, empty = false} = {}) {
    if (busy || managing) { notify("当前任务或设置尚未结束，请先取消或等待。", "warning"); return; }
    managing = true;
    try {
      let draft = structuredClone(configState.value);
      const originalKey = rosterKey(draft);
      if (empty) {
        draft.secondary = [];
        const main = await chooseModel(draft, "主"); if (!main) return;
        draft.main = main;
        const secondary = await chooseModel(draft, "副"); if (!secondary) return;
        draft.secondary.push(secondary);
      } else if (selected) draft = switchMainModel(draft, selected);
      while (true) {
        const action = await ui.select(
          safeText(`阵容编辑 · 主 ${modelLabel(draft.main)} · 副 ${draft.secondary.map(modelLabel).join("、") || "未选（保存前至少一位）"}`),
          [`主模型：${modelLabel(draft.main)}`, "追加副模型", "删除副模型", "重排副模型", "保存为新 team"],
        );
        if (!action) return;
        if (action.startsWith("主模型：") || action === "追加副模型") {
          const ref = await chooseModel(draft, action === "追加副模型" ? "副" : "主");
          if (!ref) continue;
          if (action.startsWith("主模型：")) draft = switchMainModel(draft, ref);
          else draft.secondary.push(ref);
        } else if (action === "删除副模型" || action === "重排副模型") {
          const labels = draft.secondary.map(modelLabel);
          const choice = await ui.select(action === "删除副模型" ? "移除后后位自然补位" : "移到第一位（改变问答评审）", labels);
          if (!choice) continue;
          const i = labels.indexOf(choice), [ref] = draft.secondary.splice(i,1);
          if (action === "重排副模型") draft.secondary.unshift(ref);
        } else if (action === "保存为新 team") {
          if (!empty && currentTeam() && originalKey === rosterKey(draft)) { notify("阵容没有变化，未创建新 team。"); return; }
          if (!draft.secondary.length) { notify("team 至少需要一个副模型。", "warning"); continue; }
          const id = randomUUID();
          while (true) {
            const name = await ui.input("新 team 名称（另存，原 team 保留）");
            if (name == null) return;
            let team;
            try {
              team = {id,name:normalizeTeamName(name),main:draft.main,secondary:draft.secondary};
              await validateModelRefs(draft, current.modelRuntime);
              updateConfig(home, c => addTeam(c, team));
            } catch (error) { notify(error.message, "error"); continue; }
            try { await applyTeamSelection(team); }
            catch (error) { notify("team 已保存，当前对话未切换：" + error.message, "error"); }
            return;
          }
        }
      }
    } catch (error) { notify(error.message, "error"); }
    finally { managing = false; }
  }
  async function teamMenu() {
    if (managing) return;
    try {
      const config = loadConfig(home);
      const action = await ui.select(safeText(`Team · ${currentTeam() ? teamLabel(currentTeam()) : "此历史会话尚未绑定 team"}`),
        ["选择 team", "新建 team", "基于当前 team 调整", "删除 team"]);
      if (!action) return;
      if (busy) { notify("当前任务尚未结束，请先取消或等待；未更改 team。", "warning"); return; }
      if (action === "新建 team") return await modelsMenu({empty:true});
      if (action === "基于当前 team 调整") return await modelsMenu();
      if (action === "选择 team") {
        const labels = config.teams.map(t => safeText(teamLabel(t) + (t.id === currentTeam()?.id ? "（当前）" : "")));
        const choice = await ui.select("选择 team（下一条生效）", labels);
        if (!choice) return;
        const team = config.teams[labels.indexOf(choice)];
        if (team) await applyTeamSelection(team);
      } else if (action === "删除 team") {
        const labels = config.teams.map(t => safeText(teamLabel(t) + (config.teams.length <= 1 ? "（至少保留一个，不可删除）" : t.id === currentTeam()?.id ? "（当前，不可删除）" : "")));
        const choice = await ui.select("删除 team（保留模型认证和历史）", labels);
        if (!choice) return;
        const target = config.teams[labels.indexOf(choice)];
        if (!target) return;
        const preview = removeTeam(loadConfig(home), {targetId:target.id,currentTeam:currentTeam()});
        const nextDefault = preview.teams.find(t => t.id === preview.lastUsedTeamId);
        const confirm = await ui.confirm(safeText(`删除 team「${target.name}」？`), safeText(`${teamLabel(target)}\n新对话默认：${nextDefault.name}；模型认证和历史保留。`));
        if (!confirm) return;
        if (busy) throw Error("当前任务尚未结束，未删除。");
        updateConfig(home, c => removeTeam(c, {targetId:target.id,currentTeam:currentTeam()}));
        notify("team 已删除，模型认证和历史保留。");
        refreshTeamStatus();
      }
    } catch (error) { notify(error.message, "error"); }
  }
  async function create({
    cwd: targetCwd = cwd,
    agentDir = join(home, "pi"),
    sessionManager,
    sessionStartEvent,
  } = {}) {
    const fresh = !sessionManager || sessionStartEvent?.reason === "new";
    const manager = sessionManager ?? SessionManager.create(targetCwd, join(agentDir,"sessions","main"));
    const saved = readSessionTeam(manager.getBranch());
    const latest = loadConfig(home) ?? config;
    const inherited = saved ?? (fresh ? configState.value.team : null);
    const effective = latest.formatVersion === 3 ? resolveTeamConfig(latest, inherited) : structuredClone(configState.value);
    if (!inherited && !fresh) delete effective.team;
    const catalog = await createModelRuntime(home);
    const intended = effective.main;
    const available = catalog.getModel(intended.provider,intended.modelId);
    const fallback = available ?? catalog.getModels()[0];
    if (!fallback) throw Error("模型目录为空；请先修复配置，history/show 仍可查看历史。");
    const bootstrap = available ? intended : {provider:fallback.provider,modelId:fallback.id};
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
      pi.on("session_tree", async () => {
        if (busy) return;
        active = undefined;
        const saved = readSessionTeam(rt.sessionManager.getBranch());
        const latest = loadConfig(home);
        rt.effectiveConfig = resolveTeamConfig(latest, saved);
        if (!saved) delete rt.effectiveConfig.team;
        rt.needsTeam = !saved;
        configState.value = rt.effectiveConfig;
        if (saved && rt.modelRuntime.getModel(saved.main.provider,saved.main.modelId)) await rt.selectModel(saved.main);
        try { rememberRecent(saved); } catch(error) { notify(error.message,"warning"); }
        refreshTeamStatus();
      });
      pi.on("model_select", async (event) => {
        if (!rt || rt.applyingModel || event.source === "restore") return;
        const before = rt.effectiveConfig;
        if (event.model.provider === before.main.provider && event.model.id === before.main.modelId) return;
        try {
          await rt.selectModel(before.main);
          if (busy || managing) { notify("当前任务或设置尚未结束，已保留原 team。", "warning"); return; }
          await modelsMenu({selected:{provider:event.model.provider,modelId:event.model.id}});
        } catch(error) {
          rt.selectionError = "模型恢复/选择失败，请重新打开对话：" + error.message;
          notify(rt.selectionError,"error");
        }
      });
      pi.on("session_start", (_, ctx) => {
        ui = ctx.ui;
        ui.addAutocompleteProvider(modelsAutocomplete);
        ui.onTerminalInput((data) =>
          data === "\x1b\r" ? { data: "\x1b[13;2u" } : undefined,
        );
        ui.setHeader(() => new Text("CoThink", 1, 0));
        if (rt) configState.value = rt.effectiveConfig;
        refreshTeamStatus();
        if (!available) notify("当前 team 的主模型不可用，请 /team 选择可用组合或修复模型配置；历史仍可查看。", "warning");
      });
      for (const [name, description, handler] of [
        ["chat", "查看完整讨论", showDetails],
        ["team", "选择、新建、调整或删除 team", teamMenu],
        ["models", "设置主模型和有序副模型，另存 team", modelsMenu],
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
      modelRef: bootstrap,
      modelRuntime: catalog,
      sessionManager: manager,
      sessionStartEvent,
      allowPackageErrors: true,
      extensionFactories: [{ name: "cothink", factory: extension }],
      resourceOptions: {
        ...selectedResources(effective, targetCwd),
        ...resourceOptions,
        systemPrompt: readFileSync(
          new URL("../prompts/main.md", import.meta.url),
          "utf8",
        ),
      },
      maxOutputTokens,
      timeout,
    });
    if (rt.packageError) notify(rt.packageError.message + "；历史和 /team 仍可使用，新生成已阻断。", "warning");
    rt.effectiveConfig = effective;
    rt.needsTeam = !effective.team;
    if (fresh && effective.team) persistSelection(rt, effective.team);
    rt.hostContext = (task) => {
      hostContext.task = task;
      hostContext.runtime = rt;
    };
    contexts.set(rt.session, rt);
    rt.session.subscribe((event) => {
      const model = rt.session.model;
      const main = rt.effectiveConfig.main;
      if (
        event.type === "thinking_level_changed" &&
        !rt.applyingModel &&
        current === rt &&
        model?.provider === main.provider &&
        model.id === main.modelId
      ) {
        if (busy || managing) {
          rt.applyingModel = true;
          try { rt.session.setThinkingLevel(main.thinkingLevel ?? "off"); }
          finally { rt.applyingModel = false; }
          return;
        }
        const next = structuredClone(rt.effectiveConfig);
        next.main.thinkingLevel = event.level;
        if (next.team) {
          next.team = snapshotTeam({...next.team,main:next.main,secondary:next.secondary});
          try { persistSelection(rt,next.team); }
          catch(error) { notify(error.message,"error"); return; }
        }
        rt.effectiveConfig = configState.value = next;
        refreshTeamStatus();
      }
    });
    for (const name of ["chat", "team", "models", "one"]) {
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
    if (busy || managing) {
      notify("当前任务或设置尚未结束，草稿保留，不自动排队。", "warning");
      return;
    }
    if (current.needsTeam) { notify("此历史会话尚未绑定 team，请先 /team 选择；未发送模型请求。","warning"); return; }
    if (current.selectionError) { notify(current.selectionError,"error"); return; }
    let snapshot;
    try {
      const latest = loadConfig(home);
      snapshot = latest?.formatVersion === 3 ? resolveTeamConfig(latest, currentTeam()) : structuredClone(configState.value);
      try { rememberRecent(snapshot.team); } catch(error) { notify("本条仍使用当前 team，新对话默认未更新："+error.message,"warning"); }
    } catch(error) { notify(error.message,"error"); return; }
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
      if(e.code?.startsWith("PACKAGE_")) ui?.setStatus("cothink-packages",safeText(e.message));
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
  configState.value = current.effectiveConfig;
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
    isBusy: () => busy || managing,
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
        ["/chat", "/changelog", "/team", "/models", "/model", "/one", "/help"].includes(
          text.trim(),
        )
      ) {
        if (text.trim() === "/chat") await showDetails();
        else if (text.trim() === "/changelog") await showChangelog();
        else if (name === "team") await teamMenu();
        else if (name === "models" || name === "model") await modelsMenu();
        else
          notify(
            text.trim() === "/one"
              ? "用法：/one <任务>"
              : "/one 本条单模型；/team 管理组合；/models 设置阵容；/chat 或 Ctrl+O 详情；/changelog 更新记录；Esc / Ctrl+C 取消；/new /resume /fork /tree /reload 复用 Pi。",
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
      configState.value = current.effectiveConfig;
      current.needsTeam = !configState.value.team;
      try { rememberRecent(configState.value.team); } catch(error) { notify("新对话默认未更新："+error.message,"warning"); }
      refreshTeamStatus();
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
