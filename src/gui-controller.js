import {createUpdateService, formatUpdateStatus, updateInstructions} from "./updates.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { readSessionTeam, resolveTeamConfig } from "./teams.js";
import {
  createModelRuntime,
  createRuntime,
  selectedResources,
  secretValues,
} from "./pi-runtime.js";
import { runTurn } from "./discussion.js";
import { cothinkExtension } from "./extensions/cothink.js";
import { readTask, readRequests, taskDisplayStatus } from "./task.js";
import {
  acquireSessionWriter,
  sessionWriterBusy,
  privateDirectory,
  redact,
  releaseNotesSeen,
  markReleaseNotesSeen,
} from "./storage.js";
import { validateModelThinking } from "./thinking.js";
import { parseTurnInput } from "./setup.js";
import { releaseNotes } from "./presentation.js";
import {
  appendConversationEntry,
  readSessionMode,
  readSessionProject,
  conversationCwd,
  neutralDirectory,
  readConversationMetadata,
  saveSessionMode,
  saveSessionTeam,
  selectConversationTeam,
  resolveConversationConfig,
  rememberRecentTeam,
  conversationTaskIds,
} from "./conversation.js";
import { publicTeam, projectGuiTask, finalGuiText } from "./gui-projection.js";
import {
  saveGuiTeam,
  removeGuiTeam,
  saveGuiWork,
  saveGuiProvider,
  validateGuiThinking,
} from "./gui-settings.js";
import {
  inspectGuiProject,
  guiDiff,
  guiOutput,
  guiArtifact,
  revealGuiTask,
} from "./gui-work.js";

/** Local host adapter. Pi sessions and task records remain the only durable stores. */
export async function createGuiController({ home, cwd = process.cwd(), updateService }) {
  const directory = join(home, "pi/sessions/main");
  privateDirectory(directory);
  const holders = new Map(),
    listeners = new Set(),
    live = new Map();
  let active = null,
    closed = false,
    management = false;
  // Serialize only selection acceptance and metadata writes, never task execution.
  let selectionWrite = Promise.resolve();
  function writeSelection(operation) {
    const result = selectionWrite.then(operation);
    selectionWrite = result.catch(() => {});
    return result;
  }
  const safe = (value) => redact(value, secretValues(home));
  const emit = () => {
    for (const listener of listeners)
      try {
        listener({ type: "invalidate" });
      } catch {
        /* A page cannot stop task execution. */
      }
  };
  const extensionPrompts=new Map(),extensionNotifications=[],extensionStatuses=new Map();
  let extensionCommand;
  const uiError=method=>Object.assign(new Error(`EXTENSION_UI_UNSUPPORTED: ${method} requires the cothink terminal entry; native terminal components have no GUI mapping.`),{code:"EXTENSION_UI_UNSUPPORTED"});
  function cancelExtensionPrompts(sessionId) {for(const prompt of extensionPrompts.values())if(!sessionId||prompt.sessionId===sessionId)prompt.finish(undefined,true);}
  function extensionUI(sessionId) {
    const request=(kind,title,detail,opts={})=>new Promise((resolve,reject)=>{
      if(closed)return reject(Error("宿主已关闭。"));
      if(typeof title!=="string" || (kind==="select"&&(!Array.isArray(detail)||detail.some(v=>typeof v!=="string"))))return reject(Error("插件提示参数无效。"));
      const id=randomUUID(),signal=opts.signal??(active?.sessionId===sessionId?active.abort.signal:extensionCommand?.sessionId===sessionId?extensionCommand.abort.signal:undefined);
      let timer;
      const prompt={id,sessionId,kind,title,...(kind==="select"?{options:detail}:kind==="confirm"?{message:detail}:{placeholder:detail??""}),
        ...(opts.timeout?{expiresAt:Date.now()+opts.timeout}:{}),
        finish(value,cancelled=false){clearTimeout(timer);signal?.removeEventListener("abort",abort);extensionPrompts.delete(id);resolve(cancelled?(kind==="confirm"?false:undefined):value);emit();}};
      const abort=()=>prompt.finish(undefined,true);
      if(signal?.aborted)return abort();
      extensionPrompts.set(id,prompt);signal?.addEventListener("abort",abort,{once:true});
      if(opts.timeout)timer=setTimeout(abort,opts.timeout);
      emit();
    });
    const ui={
      select:(title,options,opts)=>request("select",title,options,opts),
      input:(title,placeholder,opts)=>request("input",title,placeholder,opts),
      confirm:(title,message,opts)=>request("confirm",title,message,opts),
      notify(message,type="info"){extensionNotifications.push({id:randomUUID(),sessionId,message:String(message),type});if(extensionNotifications.length>32)extensionNotifications.shift();emit();},
      setStatus(key,text){const id=sessionId+":"+key;if(text===undefined)extensionStatuses.delete(id);else extensionStatuses.set(id,{sessionId,key,text:String(text)});emit();},
      setWorkingMessage(text){this.setStatus("working",text);},
    };
    for(const method of ["onTerminalInput","setWorkingVisible","setWorkingIndicator","setHiddenThinkingLabel","setWidget","setFooter","setHeader","setTitle","custom","pasteToEditor","setEditorText","getEditorText","editor","addAutocompleteProvider","setEditorComponent","getEditorComponent","getAllThemes","getTheme","setTheme","getToolsExpanded","setToolsExpanded"])ui[method]=()=>{throw uiError(method);};
    ui.setWidget=(key,content)=>{
      if(content===undefined)return ui.setStatus("widget:"+key,undefined);
      if(Array.isArray(content)&&content.every(line=>typeof line==="string"))return ui.setStatus("widget:"+key,content.join("\n"));
      ui.notify(`EXTENSION_UI_UNSUPPORTED: setWidget(${key}) uses a native terminal component; it was not rendered. Use cothink in the terminal for this decoration.`,"warning");
    };
    for(const method of ["setFooter","setHeader"])ui[method]=factory=>{if(factory)ui.notify(`EXTENSION_UI_UNSUPPORTED: ${method} is a terminal decoration and was not rendered.`,"warning");};
    ui.theme={fg:()=>{throw uiError("theme.fg");},bg:()=>{throw uiError("theme.bg");}};
    return ui;
  }
  const extensionSnapshot=()=>({prompts:[...extensionPrompts.values()].map(({finish,...p})=>p),notifications:extensionNotifications,statuses:[...extensionStatuses.values()],command:extensionCommand?{sessionId:extensionCommand.sessionId}:null});
  async function extensionRuntime(sessionId) {
    const holder=await owner(sessionId),config=loadConfig(home);
    if(config?.formatVersion!==3)throw Error("请先配置具名 Team。");
    return runtime(sessionId,holder,resolveConversationConfig(config,holder.sessionManager).config);
  }
  const updates=updateService ?? createUpdateService({home});
  const unsubscribeUpdates=updates.subscribe(()=>{if(!closed) emit();});
  const updateSnapshot=()=>{const s=updates.snapshot();return {...s,message:formatUpdateStatus(s),instructions:updateInstructions(s)};};
  const checkForUpdates=()=>updates.check();
  function taskIndex() {
    let files;
    try {
      files = readdirSync(join(home, "tasks"));
    } catch (error) {
      if (error.code === "ENOENT") return { records: [], errors: [] };
      throw error;
    }
    const records = [],
      errors = [];
    for (const name of files.filter((name) => name.endsWith(".json"))) {
      const taskId = name.slice(0, -5);
      try {
        records.push(readTask(home, taskId));
      } catch {
        errors.push({
          taskId,
          error: "任务记录损坏或版本不支持；原文件保留，未知提交不自动重发。",
        });
      }
    }
    records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { records, errors };
  }
  const taskRecords = () => taskIndex().records;
  async function summaries() {
    return SessionManager.listAll(directory);
  }
  function sessionEntries(path) {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }
  async function reader(id) {
    if (holders.has(id)) {
      const manager = holders.get(id).sessionManager;
      // Empty conversations intentionally have no file. Once persisted, a cached
      // runtime must not conceal later disk damage from history/continuation.
      if (manager.getEntries().some((e) => e.type === "message" && ["user", "assistant"].includes(e.message.role)))
        sessionEntries(manager.getSessionFile());
      return manager;
    }
    const info = (await summaries()).find((s) => s.id === id);
    if (!info) throw Error("会话不存在，请刷新历史。");
    const entries = sessionEntries(info.path);
    return SessionManager.inMemory(info.cwd, undefined, entries);
  }
  async function owner(id) {
    // Pi's writable reader tolerates malformed lines. Validate our strict history
    // projection before acquiring a writer so damaged facts cannot be skipped.
    const readable = await session(id);
    if (readable.selectionError) throw Error(readable.selectionError);
    let holder = holders.get(id);
    if (holder) {
      if (holder.opening) await holder.opening;
      holder.assertOwned();
      return holder;
    }
    const info = (await summaries()).find((s) => s.id === id);
    if (!info) throw Error("会话不存在，请刷新历史。");
    const writer = acquireSessionWriter(join(home, "pi"), id);
    try {
      const manager = SessionManager.open(info.path);
      holder = {
        sessionManager: manager,
        writer,
        assertOwned: writer.assertOwned,
      };
      holders.set(id, holder);
      return holder;
    } catch (e) {
      writer.release();
      throw e;
    }
  }
  function runtime(id, holder, effective) {
    if (holder.runtime) return Promise.resolve(holder.runtime);
    if (holder.opening) return holder.opening;
    holder.opening = (async () => {
      const manager = holder.sessionManager,
        project = readSessionProject(manager),
        host = { allowWork: project !== null };
      holder.writer.release();
      holder.writer = null;
      try {
        const rt = await createRuntime({
          home,
          cwd: conversationCwd(manager, home),
          sessionManager: manager,
          modelRef: effective.main,
          uiContext:extensionUI(id),
          extensionFactories: [
            { name: "cothink", factory: cothinkExtension(host) },
          ],
          resourceOptions: {
            ...selectedResources(effective, conversationCwd(manager, home)),
            systemPrompt: readFileSync(
              new URL("../prompts/main.md", import.meta.url),
              "utf8",
            ),
            ...(project === null ? { noContextFiles: true } : {}),
          },
          ...(project === null ? { activeToolNames: [] } : {}),
        });
        rt.hostContext = (task) => {
          host.task = task;
          host.runtime = rt;
        };
        rt.effectiveConfig = effective;
        rt.singleModel = readSessionMode(manager);
        rt.needsTeam = false;
        holder.runtime = rt;
        holder.assertOwned = rt.assertOwned;
        return rt;
      } catch (e) {
        holders.delete(id);
        throw e;
      }
    })();
    const opening = holder.opening;
    void opening
      .finally(() => {
        holder.opening = null;
      })
      .catch(() => {});
    return opening;
  }
  function rawTask(id) {
    return (
      live.get(id) ?? {
        record: readTask(home, id),
        requests() {
          return readRequests(home, this.record);
        },
      }
    );
  }
  async function session(id) {
    const records = taskRecords();
    let ids = [];
    // ID-only associations survive branch navigation without exposing sibling content.
    const submissions = () => records
      .filter((t) => t.sessionId === id)
      .filter((t) => t.submissionId)
      .map((t) => ({ taskId: t.id, submissionId: t.submissionId }));
    try {
      const manager = await reader(id),
        meta = readConversationMetadata(manager);
      ids = conversationTaskIds(manager);
      // An accepted task can be observed before Pi appends its first branch marker.
      if (active?.sessionId === id && live.has(active.taskId) && !ids.includes(active.taskId))
        ids.push(active.taskId);
      const turns = ids.map((taskId) => {
        const current = active?.taskId === taskId ? live.get(taskId) : null,
          record = current?.record ?? records.find((t) => t.id === taskId);
        if (!record) throw Error("分支引用的任务记录缺失或损坏。");
        return {
          taskId: record.id,
          submissionId: record.submissionId ?? null,
          input: record.input,
          status: taskDisplayStatus(record),
          mode: record.singleModel ? "one" : "cothink",
          finalText: finalGuiText(
            record,
            current?.requests() ?? readRequests(home, record),
          ),
        };
      });
      const selectionError = holders.get(id)?.runtime?.selectionError ??
        holders.get(id)?.selectionError ?? null;
      const readOnly = !!selectionError ||
        (!holders.has(id) && sessionWriterBusy(join(home, "pi"), id));
      return safe({
        id,
        title: meta.title || turns[0]?.input.slice(0, 60) || "新对话",
        project: readSessionProject(manager),
        mode: readSessionMode(manager) ? "one" : "cothink",
        team: publicTeam(readSessionTeam(manager.getBranch())),
        draft: meta.draft,
        thinking: meta.thinking ?? null,
        turns,
        submissions: submissions(),
        readOnly,
        selectionError,
      });
    } catch {
      const info = (await summaries()).find((s) => s.id === id);
      if (!info && !holders.has(id)) throw Error("会话不存在，请刷新历史。");
      // Retain a cached, previously accepted mode only as a read-only selection.
      let mode = "cothink";
      try {
        const cached = holders.get(id)?.sessionManager;
        if (cached && readSessionMode(cached)) mode = "one";
      } catch { /* Corrupt selections carry no usable default for generation. */ }
      return safe({
        id, title: "历史不可用", project: null, mode, team: null,
        thinking: null, draft: "", turns: [], submissions: submissions(), readOnly: true,
        selectionError: "会话历史或任务请求记录损坏、缺失或不可用；原文件保留，请修复后重新打开。禁止继续生成，未知提交不会重发。",
      });
    }
  }
  async function bootstrap() {
    const config = loadConfig(home),
      catalog = await createModelRuntime(home),
      notes = releaseNotes();
    try {
      notes.unread = !releaseNotesSeen(home, notes.version);
    } catch {
      notes.unread = true;
      notes.error = "更新摘要显示状态损坏，原文件已保留；无法保存已读状态。";
    }
    const ids = [
      ...new Set([...(await summaries()).map((s) => s.id), ...holders.keys()]),
    ];
    const historyErrors = taskIndex().errors;
    const sessions = await Promise.all(
      ids.map(async (id) => {
        const s = await session(id);
        if (s.selectionError) historyErrors.push({ sessionId: id, error: s.selectionError });
        const info = (await summaries()).find((i) => i.id === id);
        return {
          id: s.id,
          title: s.title,
          project: s.project,
          updatedAt: info?.modified?.toISOString() ?? null,
          readOnly: s.readOnly,
        };
      }),
    );
    return safe({
      version: notes.version,
      extensionUI:extensionSnapshot(),
      configured: config?.formatVersion === 3,
      suggestedProject: cwd,
      teams: (config?.teams ?? []).map(publicTeam),
      currentTeamId: config?.lastUsedTeamId ?? null,
      providers: catalog.getProviders().map((p) => ({
        id: p.id,
        name: p.name ?? p.id,
        configured: catalog.hasConfiguredAuth(p.id),
        oauth: !!p.auth?.oauth?.login,
        apiKey: !!p.auth?.apiKey?.login,
      })),
      models: await Promise.all(
        catalog
          .getModels()
          .filter((m) => !m.type || m.type === "chat")
          .map(async (m) => ({
            provider: m.provider,
            modelId: m.id,
            name: m.name ?? m.id,
            reasoning: !!m.reasoning,
            thinkingLevels: await validateModelThinking(m),
            api: m.api,
            contextWindow: m.contextWindow,
            maxTokens: m.maxTokens,
          })),
      ),
      sessions,
      active: active
        ? {
            taskId: active.taskId,
            sessionId: active.sessionId,
            status: live.get(active.taskId) ? taskDisplayStatus(live.get(active.taskId).record) : "running",
          }
        : null,
      work: config?.work ?? {},
      releaseNotes: notes,
      updates: updateSnapshot(),
      historyErrors,
    });
  }
  async function submit(args) {
    const { sessionId, input, submissionId } = args;
    if (
      typeof submissionId !== "string" ||
      !submissionId.trim() ||
      submissionId.length > 200
    )
      throw Error("submissionId 必须是 1—200 字符。");
    const prior = taskRecords().find(
      (t) => t.sessionId === sessionId && t.submissionId === submissionId,
    );
    if (prior) return { taskId: prior.id, sessionId: prior.sessionId };
    if (taskIndex().errors.length)
      throw Error(
        "存在损坏任务记录，无法确认旧提交身份；请保留并修复记录后再提交。历史和设置仍可查看。",
      );
    if (active?.sessionId === sessionId && active.submissionId === submissionId)
      return active.ready;
    if (active || management)
      throw Error("当前任务或设置尚未结束；草稿保留，不自动排队。");
    if (
      typeof input !== "string" ||
      !input.trim() ||
      (!args.workRequest && parseTurnInput(input).local)
    )
      throw Error("请输入问题；模式命令请使用模式控件。");
    const slash=/^\/([^\s]+)/.exec(input)?.[1];
    if(slash&&!slash.startsWith("skill:")) {
      const rt=await extensionRuntime(sessionId);
      if(rt.commands().some(c=>c.name===slash))throw Object.assign(Error("插件命令请从插件命令入口执行；未创建模型任务。"),{code:"EXTENSION_COMMAND"});
    }
    void checkForUpdates();
    let resolveReady, rejectReady;
    const ready = new Promise((yes, no) => {
      resolveReady = yes;
      rejectReady = no;
    });
    const state = {
      taskId: randomUUID(),
      sessionId,
      submissionId,
      ready,
      abort: new AbortController(),
    };
    active = state;
    state.promise = (async () => {
      try {
        const accepted = await writeSelection(async () => {
          const holder = await owner(sessionId),
            manager = holder.sessionManager;
          if (holder.runtime?.selectionError || holder.selectionError)
            throw Error(
              holder.runtime?.selectionError ?? holder.selectionError,
            );
          const config = loadConfig(home);
          if (config?.formatVersion !== 3) throw Error("请先配置具名 Team。");
          if (!readSessionTeam(manager.getBranch()))
            throw Error("此历史会话尚未绑定 Team，请明确选择。");
          const snapshot = {
            config: resolveConversationConfig(config, manager).config,
            singleModel: readSessionMode(manager),
            cwd: conversationCwd(manager, home),
            allowWork: readSessionProject(manager) !== null,
          };
          const thinking = readConversationMetadata(manager).thinking;
          if (thinking !== undefined)
            snapshot.config.main.thinkingLevel = thinking;
          // Publish the initialization promise before allowing later selection writes.
          return {
            snapshot,
            opening: runtime(sessionId, holder, snapshot.config),
          };
        });
        const { snapshot } = accepted,
          rt = await accepted.opening;
        if (closed) throw Error("宿主已关闭。");
        if (rt.selectionError) throw Error(rt.selectionError);
        await runTurn({
          home,
          cwd: snapshot.cwd,
          input,
          workRequest: args.workRequest,
          config: snapshot.config,
          singleModel: snapshot.singleModel,
          mainRuntime: rt,
          allowWork: snapshot.allowWork,
          id: state.taskId,
          submissionId,
          signal: state.abort.signal,
          onProgress: (event) => {
            live.set(event.task.record.id, event.task);
            resolveReady({ taskId: event.task.record.id, sessionId });
            emit();
          },
        });
      } catch (error) {
        rejectReady(error);
      } finally {
        if (active === state) active = null;
        cancelExtensionPrompts(sessionId);
        clearInterval(state.timer);
        emit();
      }
    })();
    state.timer = setInterval(emit, 250);
    state.timer.unref();
    return ready;
  }
  async function action(name, args = {}) {
    if (closed) throw Error("宿主已关闭。");
    if(name==="extension.respond") {
      const prompt=extensionPrompts.get(args.promptId);
      if(!prompt||prompt.sessionId!==args.sessionId)throw Error("插件提示已结束或不属于此会话。");
      if(!args.cancelled && ((prompt.kind==="select"&&!prompt.options.includes(args.value))||(prompt.kind==="input"&&typeof args.value!=="string")||(prompt.kind==="confirm"&&typeof args.value!=="boolean")))throw Error("插件提示回复无效。");
      prompt.finish(args.value,args.cancelled===true);return {answered:true};
    }
    if(name==="extension.commands") {
      if(active||management)throw Error("当前任务或设置尚未结束。");
      const rt=await extensionRuntime(args.sessionId);
      // Binding starts native lifecycle only on this explicit plugin interaction.
      await rt.bindUI();
      return rt.commands().filter(c=>!c.source?.includes?.("inline:cothink")).map(c=>({name:c.name,description:c.description??""}));
    }
    if(name==="extension.command"||name==="extension.reload") {
      if(active||management)throw Error("当前任务或设置尚未结束；插件操作不自动排队。");
      management=true;extensionCommand={sessionId:args.sessionId,abort:new AbortController()};emit();
      const command=extensionCommand;
      const operation=(async()=>{
        const rt=await extensionRuntime(args.sessionId);
        if(name==="extension.reload") {for(const [key,status] of extensionStatuses)if(status.sessionId===args.sessionId)extensionStatuses.delete(key);await rt.session.reload();}else {
          if(typeof args.input!=="string"||!/^\/[^\s]+(?:[ \t][^\n]*)?$/.test(args.input))throw Error("请输入单条插件命令。");
          await rt.dispatchCommand(args.input);
        }
        return {completed:true};
      })();
      command.finished=operation;
      try{return await operation;} finally {cancelExtensionPrompts(args.sessionId);extensionCommand=null;management=false;emit();}
    }
    if (name === "updates.check" || name === "updates.configure") {
      const allowed=name === "updates.check" ? ["manual"] : ["automatic"];
      if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(key=>!allowed.includes(key))) throw Error("更新操作参数无效。");
      if (name === "updates.configure") {
        if(typeof args.automatic !== "boolean") throw Error("自动检查设置必须是布尔值。");
        updates.setAutomatic(args.automatic);
      } else {
        if(args.manual !== undefined && typeof args.manual !== "boolean") throw Error("检查方式必须是布尔值。");
        await updates.check({manual:args.manual ?? true});
      }
      return updateSnapshot();
    }
    if (name === "releaseNotes.ack") {
      const { version } = releaseNotes();
      if (args.version !== version)
        throw Error("只能确认当前安装版本的更新摘要。");
      markReleaseNotesSeen(home, version);
      emit();
      return { version, unread: false };
    }
    if (name === "task.submit") return submit(args);
    if (name === "task.cancel") {
      if (active?.taskId === args.taskId) {
        cancelExtensionPrompts(active.sessionId);
        active.abort.abort();
        await live.get(args.taskId)?.cancel();
      } else rawTask(args.taskId);
      emit();
      return { taskId: args.taskId };
    }
    if (name === "task.reveal")
      return revealGuiTask(rawTask(args.taskId).record);
    if (name === "project.inspect")
      return inspectGuiProject(home, args.path, loadConfig(home)?.work);
    if (name === "session.create") {
      let project = null;
      if (args.project != null) {
        const p = await inspectGuiProject(
          home,
          args.project,
          loadConfig(home)?.work,
        );
        if (!p.valid) throw Error(p.error);
        project = p.path;
      }
      const manager = SessionManager.create(
          project ?? neutralDirectory(home),
          directory,
        ),
        id = manager.getSessionId(),
        writer = acquireSessionWriter(join(home, "pi"), id),
        holder = {
          sessionManager: manager,
          writer,
          assertOwned: writer.assertOwned,
        };
      holders.set(id, holder);
      appendConversationEntry(holder, "cothink-project", { project });
      const config = loadConfig(home);
      if (config?.formatVersion === 3)
        saveSessionTeam(holder, resolveTeamConfig(config).team);
      emit();
      return session(id);
    }
    if (
      [
        "session.name",
        "session.draft",
        "session.mode",
        "session.team",
        "session.thinking",
      ].includes(name)
    ) {
      const switchingTeam = name === "session.team";
      if (switchingTeam) {
        if (active || management)
          throw Error("当前任务或设置尚未结束，请先取消或等待。");
        management = true;
      }
      try {
        return await writeSelection(async () => {
          const holder = await owner(args.sessionId),
            target = holder.runtime ?? holder;
          if (name === "session.name") {
            if (
              typeof args.title !== "string" ||
              !args.title.trim() ||
              args.title.length > 200
            )
              throw Error("标题需要 1—200 字符。");
            appendConversationEntry(target, "cothink-title", {
              title: args.title.trim(),
            });
          }
          if (name === "session.draft") {
            if (typeof args.text !== "string") throw Error("草稿必须是文本。");
            appendConversationEntry(target, "cothink-draft", {
              text: args.text,
            });
          }
          if (name === "session.mode") {
            if (!["one", "cothink"].includes(args.mode))
              throw Error("模式无效");
            saveSessionMode(target, args.mode === "one");
          }
          if (name === "session.team") {
            const config = loadConfig(home),
              team = config?.teams?.find((t) => t.id === args.teamId);
            if (!team) throw Error("Team 不存在。");
            if (holder.runtime)
              await selectConversationTeam({
                home,
                owner: holder.runtime,
                team,
              });
            else {
              saveSessionTeam(target, team);
              rememberRecentTeam(home, team);
            }
          }
          if (name === "session.thinking") {
            const team = readSessionTeam(holder.sessionManager.getBranch());
            if (!team) throw Error("请先绑定 Team。");
            await validateGuiThinking(home, team, args.level);
            appendConversationEntry(target, "cothink-thinking", {
              level: args.level,
            });
          }
          emit();
          return session(args.sessionId);
        });
      } finally {
        if (switchingTeam) management = false;
      }
    }

    if (
      ["team.save", "team.remove", "provider.save", "settings.work"].includes(
        name,
      )
    ) {
      if (active || management)
        throw Error("当前任务或设置尚未结束，请先取消或等待。");
      management = true;
      try {
        let result;
        if (name === "team.save")
          result = publicTeam(await saveGuiTeam(home, args));
        if (name === "team.remove") {
          const manager = await reader(args.sessionId);
          removeGuiTeam(
            home,
            args.teamId,
            readSessionTeam(manager.getBranch()),
          );
          result = { removed: true };
        }
        if (name === "provider.save") {
          result = await saveGuiProvider(home, args);
          const catalogs = new Set(
            [...holders.values()]
              .map((holder) => holder.runtime?.modelRuntime)
              .filter(Boolean),
          );
          for (const catalog of catalogs) {
            const refreshed = await catalog.refresh({ allowNetwork: false });
            if (refreshed?.aborted || refreshed?.errors?.size)
              throw Error(
                "服务商已保存，但会话模型目录同步未完成；请重新打开宿主后继续。不会自动发送模型请求。",
              );
          }
        }
        if (name === "settings.work") result = saveGuiWork(home, args.work);
        emit();
        return result;
      } finally {
        management = false;
      }
    }
    throw Error("未知 action。");
  }
  async function close() {
    if (closed) return;
    closed = true;
    const command=extensionCommand;command?.abort.abort();cancelExtensionPrompts();
    try{await command?.finished;}catch{}
    unsubscribeUpdates();
    updates.close();
    if (active) {
      const state = active;
      state.abort.abort();
      await live.get(state.taskId)?.cancel();
      await state.promise;
    }
    for (const holder of holders.values()) {
      await holder.runtime?.dispose();
      holder.writer?.release();
    }
    holders.clear();
    listeners.clear();
  }
  const wrap =
    (fn) =>
    async (...args) => {
      try {
        return safe(await fn(...args));
      } catch (error) {
        const secrets = [
          ...secretValues(home),
          ...(args[1]?.apiKey ? [args[1].apiKey] : []),
        ];
        throw Object.assign(new Error(redact(error.message, secrets)), {
          code: error.code,
        });
      }
    };
  return {
    bootstrap: wrap(bootstrap),
    checkForUpdates,
    session: wrap(session),
    task: wrap(async (id) => {
      const t = rawTask(id);
      const files = [
        ...new Set(
          t.record.stages.map((stage) => stage.sessionFile).filter(Boolean),
        ),
      ];
      const entries = files.flatMap((path) => {
        try {
          return readFileSync(path, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line));
        } catch {
          return [];
        }
      });
      const p = projectGuiTask(t.record, t.requests(), entries);
      if (live.has(id)) p.usage = t.usage();
      return p;
    }),
    action: wrap(action),
    diff: wrap((id) => guiDiff(home, rawTask(id).record)),
    output: wrap((id, ref, offset, limit) =>
      guiOutput(home, rawTask(id).record, ref, offset, limit),
    ),
    artifact: async (id,ref,index) => {
      try { return guiArtifact(home,rawTask(id).record,ref,index); }
      catch(error) { throw Error(safe(error.message)); }
    },
    patch: wrap(async (id) => (await guiDiff(home, rawTask(id).record)).text),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close,
  };
}
