import { readFileSync, realpathSync, existsSync } from "node:fs";
import { join, resolve, isAbsolute, relative } from "node:path";
import { createHash } from "node:crypto";
import {pathToFileURL} from 'node:url';
import { createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { moonshotaiCnProvider } from "@earendil-works/pi-ai/providers/moonshotai-cn";
import { moonshotaiProvider } from "@earendil-works/pi-ai/providers/moonshotai";
import {
  configureHttpDispatcher,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSessionServices,
  createAgentSessionFromServices,
} from "@earendil-works/pi-coding-agent";
import { createRequestPolicy } from "./request-policy.js";
import {
  privateDirectory,
  acquireSessionWriter,
  assertPackageReadable,
} from "./storage.js";
import { problem } from "./task.js";
import { resolveModelThinking } from "./thinking.js";
import { resolvePackageResources, localNames } from "./packages.js";
export const managedSettings = {
  retry: { enabled: false, provider: { maxRetries: 0, timeoutMs: 0 } },
  compaction: { enabled: false },
  cacheWarming: "off",
  httpIdleTimeoutMs: 0,
  quietStartup: true,
  tuiMode: "fullscreen",
  fullscreenExitOutput: "resume-hint",
  fullscreenCopyOnSelect: true,
};
export async function createModelRuntime(home) {
  const agentDir = join(home, "pi");
  privateDirectory(agentDir);
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false,
  });
  // Pi's flag covers create() only; native UI refreshes must use the same pinned catalog.
  const refresh = runtime.refresh.bind(runtime);
  const managedProviders = new Set();
  const builtinIds = new Set([...getBuiltinProviders(), "radius"]);
  let registering = false, pending = Promise.resolve();
  runtime.refresh = (options = {}) => {
    // Pi registration invokes refresh synchronously in the background. The enclosing
    // pass performs that refresh after all declarations are installed instead.
    if (registering) return Promise.resolve({ aborted: false, errors: new Map() });
    const run = pending.then(async () => {
      registering = true;
      try {
        for (const id of managedProviders) runtime.unregisterProvider(id);
        managedProviders.clear();
      } finally { registering = false; }
      // Reconcile the whole local config even when the UI requested one provider:
      // deleted identities must disappear and newly imported identities must appear.
      const first = await refresh({ ...options, providers: undefined, allowNetwork: false });
      registering = true;
      try { addModels(); } finally { registering = false; }
      const last = await refresh({ ...options, allowNetwork: false });
      return { aborted: first.aborted || last.aborted, errors: new Map([...first.errors, ...last.errors]) };
    });
    pending = run.catch(() => {});
    return run;
  };
  function addModels() {
    // Fixed additions use Pi's public provider API; credentials and models.json stay owned by Pi/the user.
    for (const provider of runtime.getProviders()) {
      let official = false;
      try {
        const url = new URL(provider.baseUrl);
        official = url.protocol === "https:" &&
          ["api.moonshot.cn", "api.moonshot.ai"].includes(url.hostname) &&
          !url.port && !url.username && !url.password && !url.search && !url.hash &&
          url.pathname.replace(/\/+$/, "") === "/v1";
      } catch { /* Other providers keep their own model catalog. */ }
      const moonshot = ["moonshotai-cn", "moonshotai"].includes(provider.id);
      if (!moonshot && (!official || builtinIds.has(provider.id))) continue;
      if (!provider.getModels().some((model) => model.api === "openai-completions")) continue;
      // Never capture a composed provider: it can retain revoked user keys/headers after refresh.
      const base = provider.id === "moonshotai-cn" ? moonshotaiCnProvider()
        : provider.id === "moonshotai" ? moonshotaiProvider()
          : createProvider({
              id: provider.id, name: provider.name, baseUrl: provider.baseUrl, models: [],
              auth: { apiKey: envApiKeyAuth("API key", []) }, api: openAICompletionsApi(),
            });
      const model = {
        type: "chat", id: "kimi-k3.1-pro", name: "Kimi K3.1 Pro",
        provider: provider.id, api: "openai-completions", baseUrl: base.baseUrl,
        reasoning: true, input: ["text", "image"],
        contextWindow: 1048576, maxTokens: 1048576,
        thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
        // Pi's zero-price sentinel leaves CoThink's catalog estimate null, never a claim of free usage.
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: {
          supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true,
          maxTokensField: "max_completion_tokens", supportsStrictMode: false,
          thinkingFormat: "openai", requiresReasoningContentOnAssistantMessages: true,
          supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true,
        },
      };
      managedProviders.add(provider.id);
      runtime.registerNativeProvider({
        ...base,
        getModels: () => [...base.getModels(), model],
        getAllModels: () => [...(base.getAllModels?.() ?? base.getModels()), model],
      });
    }
  }
  await runtime.refresh({ allowNetwork: false });
  return runtime;
}
export function secretValues(home) {
  const values = [];
  for (const name of ["auth.json", "models.json"]) {
    try {
      const walk = (o) => {
        for (const [k, v] of Object.entries(o ?? {})) {
          if (
            typeof v === "string" &&
            /key|token|secret/i.test(k) &&
            v.length > 3
          )
            values.push(v);
          else if (v && typeof v === "object") walk(v);
        }
      };
      walk(JSON.parse(readFileSync(join(home, "pi", name), "utf8")));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  return values;
}
// Explicitly selected native extensions are trusted code. Hashes record provenance,
// not permission or an OS sandbox. Agent-sync still controls formal file acceptance.
export function auditHostResources(paths = [], cwd = process.cwd()) {
  return paths.map((path) => {
    const absolute = realpathSync(resolve(cwd, path));
    return {
      path: absolute,
      sha256: createHash("sha256").update(readFileSync(absolute)).digest("hex"),
      kind: "extension",
    };
  });
}
const resourceWithin=(root,path)=>{const rel=relative(root,path);return rel===""||(!isAbsolute(rel)&&!/^\.\.(?:[\\/]|$)/.test(rel));};
let transportConfigured = false;

export async function createRuntime({
  sessionStartEvent,
  home,
  cwd = process.cwd(),
  modelRef,
  modelRuntime,
  sessionManager,
  extensionFactories = [],
  nativePluginTools = false,
  nativeContext,
  uiContext,
  uiMode = uiContext ? "rpc" : "print",
  resourceOptions = {},
  useFrozenSkills = false,
  role = "main",
  maxOutputTokens,
  timeout,
  toolDefinitions = [],
  extraToolNames = [],
  activeToolNames,
  packageSnapshot,
  allowPackageErrors = false,
}) {
  const agentDir = join(home, "pi");
  privateDirectory(agentDir);
  nativePluginTools ||= Boolean(nativeContext);
  let binding,
    runtime,
    disposal,
    disposed = false;
  const manager =
    sessionManager ??
    SessionManager.create(cwd, join(agentDir, "sessions", role));
  await nativeContext?.bindSession?.(manager.getSessionId(),manager.getSessionFile());
  const writer = acquireSessionWriter(
    join(home, "pi"),
    manager.getSessionId(),
    () => {
      if (!disposed && binding)
        void binding.task.cancel().catch((error) => {
          binding.task.record.status = "partial";
          binding.task.record.error = "取消记录保存失败：" + error.message;
          binding.task.recovery = {
            record: binding.task.record,
            requests: binding.task.requests(),
          };
        });
    },
  );
  let projectLease;
  let inNativeContext=callback=>callback();
  try {
    let packageError;
    if(packageSnapshot&&!packageSnapshot.project)packageSnapshot={project:realpathSync(cwd),...packageSnapshot};
    const packageProject=packageSnapshot?.project ?? cwd;
    try {
    if(existsSync(join(packageProject,".pi/settings.json"))) {
      const hostSettings=existsSync(join(home,"pi/settings.json")) ? JSON.parse(readFileSync(join(home,"pi/settings.json"),"utf8")) : {};
      if(hostSettings.cothinkProjects?.[realpathSync(packageProject)]) {
        assertPackageReadable(home,{agentDir:join(packageProject,".pi")});
        projectLease = acquireSessionWriter(join(packageProject,".pi"), manager.getSessionId());
        assertPackageReadable(home,{agentDir:join(packageProject,".pi")});
      }
    }
      assertPackageReadable(home);
      packageSnapshot ??= await resolvePackageResources({
        home,
        cwd,
        manual: {
          skills: resourceOptions.additionalSkillPaths ?? [],
          prompts: resourceOptions.additionalPromptTemplatePaths ?? [],
          themes: resourceOptions.additionalThemePaths ?? [],
        },
      });
    } catch (error) {
      if (!allowPackageErrors) throw error;
      packageError = error;
      packageSnapshot = {
        packages: [],
        extensions: [],
        skills: [],
        prompts: [],
        themes: [],
        diagnostics: [],
      };
    }
    const originalResourceOptions = resourceOptions;
    const merge = (key, kind) => [
      ...new Set(
        [...(resourceOptions[key] ?? []), ...packageSnapshot[kind]].map((p) =>
          realpathSync(resolve(cwd, p)),
        ),
      ),
    ];
    resourceOptions = {
      ...resourceOptions,
      additionalExtensionPaths: merge("additionalExtensionPaths", "extensions"),
      // Work receives the already frozen main-file material, never reload live skill metadata.
      additionalSkillPaths: useFrozenSkills ? [] : merge("additionalSkillPaths", "skills"),
      additionalPromptTemplatePaths: merge(
        "additionalPromptTemplatePaths",
        "prompts",
      ),
      additionalThemePaths: merge("additionalThemePaths", "themes"),
    };
    const resourceAudit = auditHostResources(
      resourceOptions.additionalExtensionPaths ?? [],
      cwd,
    );
    const nativePackage=packageSnapshot.packages.find(p=>p.name==='pi-subagents'&&p.version==='0.84.0'&&p.compatibility&&p.installedPath);
    if(nativePackage){const {withHostResources}=await import(pathToFileURL(join(nativePackage.installedPath,'src/runs/shared/host-integration.js')));inNativeContext=callback=>withHostResources(join(home,'pi'),callback,{headlessUI:Boolean(uiContext&&uiMode==='rpc')});}
    const verifyResourceAudit = () => {
      const current = auditHostResources(
        resourceAudit.map((r) => r.path),
        cwd,
      );
      if (JSON.stringify(current) !== JSON.stringify(resourceAudit))
        throw problem("UNADAPTED_PLUGIN", "冻结扩展来源发生变化");
    };
    resourceOptions = {
      ...resourceOptions,
      additionalExtensionPaths: resourceAudit.map((r) => r.path),
    };
    if (!transportConfigured) {
      configureHttpDispatcher(0);
      transportConfigured = true;
    }
    const guiManagedPaths=!nativeContext?.supportsNativeSubagents&&(role!=="main"||(uiContext&&uiMode==="rpc")) ? resourceAudit.filter(r=>packageSnapshot.packages.some(p=>p.name==="pi-subagents"&&p.version==="0.84.0"&&p.compatibility&&p.installedPath&&resourceWithin(p.installedPath,r.path))).map(r=>r.path) : [];
    if(guiManagedPaths.length) {
      resourceOptions={...resourceOptions,additionalExtensionPaths:resourceOptions.additionalExtensionPaths.filter(path=>!guiManagedPaths.includes(path))};
      if(uiContext&&uiMode==="rpc")uiContext.notify("pi-subagents: the native terminal manager is not loaded in GUI. Managed CoThink helpers remain available; use the terminal for the native manager UI.","warning");
    }
    const mr = modelRuntime ?? (await createModelRuntime(home));
    const policy = createRequestPolicy({
      getBinding: () => binding,
      getSecrets: async (model) => {
        const resolution = await mr.getAuth(model);
        return [
          ...secretValues(home),
          resolution?.auth?.apiKey,
          ...Object.values(resolution?.auth?.headers ?? {}),
        ].filter((v) => typeof v === "string" && v.length > 3);
      },
    });
    for (const method of ["stream", "streamSimple"]) {
      const original = mr[method].bind(mr);
      mr[method] = (model, context, options) => {
        // Pi's direct virtual route re-enters streamSimple with the physical model.
        if (method === "streamSimple" && model.api === "pi-virtual")
          return original(model, context, {
            ...options,
            signal:
              options?.signal && binding
                ? AbortSignal.any([options.signal, binding.task.signal])
                : (binding?.task.signal ?? options?.signal),
          });
        return policy.stream(model, context, options, original);
      };
    }
    const settingsManager = SettingsManager.inMemory(managedSettings);
    // Explicit task resources, never project .pi settings; native children inherit this public trust policy.
    settingsManager.setProjectTrusted(false);
    const services = await inNativeContext(()=>createAgentSessionServices({
      cwd,
      agentDir,
      modelRuntime: mr,
      settingsManager,
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: role !== "main",
        ...resourceOptions,
        noExtensions: true,
        extensionFactories: [...extensionFactories, {name:"cothink-policy",factory:pi=>{
          pi.on("session_start",()=>{validateNativeTools();gateNativeCommands();enforce();});
          pi.on("before_agent_start",async event=>{
            validateNativeTools();gateNativeCommands();enforce();
            const note=await nativeContext?.beforePrompt?.({phase:binding?.stage.phase});
            return note?{systemPrompt:event.systemPrompt+"\n\n"+note}:undefined;
          });
          pi.on("tool_call",async event=>{
            validateNativeTools();
            const owner=pluginOwners().get(event.toolName);
            if(!owner) {
              if(!hostNames.has(event.toolName)||!managedNames.includes(event.toolName))throw problem("UNMANAGED_TOOL","Uncontrolled built-in or unknown native tool: "+event.toolName);
              return;
            }
            if(!nativeEnabled())throw problem("UNADAPTED_PLUGIN","Native tools require the current task's independent work copy; unavailable in pure answers/preparation/conflict resolution");
            if(isUnadaptedOwner(owner))throw problem("UNADAPTED_PLUGIN","This installed plugin's native delegation/background route is not tracked. Use cothink_helper for supported pi-subagents foreground work.");
            writer.assertOwned();const {task,stage}=binding;
            if(task.signal.aborted||task.record.status!=="running"||task.ioError||stopAfterTurn)throw problem("TASK_ENDED","Task no longer permits plugin tools");
            await nativeContext?.beforeTool?.(event);
            const trace={toolCallId:event.toolCallId,name:event.toolName,source:owner,cwd:nativeContext?.cwd??cwd,parentActorId:nativeContext?.actor,stageId:stage.id,sessionFile:stage.sessionFile,status:"running",kind:"native_plugin_tool"};
            (task.record.tools??=[]).push(trace);nativeTraces.set(event.toolCallId,trace);task.save();
          });
          pi.on("tool_result",event=>{
            const trace=nativeTraces.get(event.toolCallId);if(!trace)return;
            trace.usage=event.usage??null;trace.usageSource=event.usage?"extension_report":null;
            if(typeof event.details?.runId==='string')trace.nativeRunId=event.details.runId;
            trace.status=binding?.task.signal.aborted?"cancelled":event.isError?"failed":"completed";
            const extra=nativeContext?.afterTool?.(event);binding?.task.save();return extra;
          });
        }}],
      },
    }));
    const loaded = services.resourceLoader.getExtensions();
    const failures = [
      ...(loaded.errors ?? []).map((e) => e.error),
      ...services.diagnostics
        .filter((d) => d.type === "error")
        .map((d) => d.message),
    ];
    const hostRoutingTools = () => {
      const owners = services.resourceLoader.getExtensions().extensions
        .filter((extension) => extension.tools.has("start_work"));
      const hostFactory = extensionFactories.some((input) =>
        input?.name === "cothink" && typeof input.factory === "function");
      if (owners.length > 1 || owners.some((owner) =>
        !hostFactory || owner.path !== "<inline:cothink>"))
        throw problem("TOOL_COLLISION", "start_work 是 CoThink 宿主专用工具，扩展不得覆盖");
      return owners.length === 1;
    };
    hostRoutingTools();
    if (failures.length) throw problem("EXTENSION_LOAD", failures.join("\n"));
    const gateNativeCommands = () => {
      // Validate ownership before discovery filters or any session/tool activation.
      hostRoutingTools();
      const owners = new Map();
      for (const extension of services.resourceLoader.getExtensions().extensions) {
        if (!resourceAudit.some((r) => r.path === extension.path)) continue;
        for (const [name, command] of extension.commands) {
          if (localNames.has(name) || owners.has(name))
            throw problem("COMMAND_COLLISION", "扩展命令与宿主或其他扩展冲突：" + name);
          owners.set(name, extension.path);
        }
      }
    };
    gateNativeCommands();
    const hostNames=new Set([...toolDefinitions.map(t=>t.name),...(hostRoutingTools()?["start_work"]:[])]);
    const builtinNames=new Set(["read","write","edit","bash","powershell","grep","find","ls"]);
    const nativeTraces=new Map();
    const pluginOwners=()=>{
      const owners=new Map();
      for(const extension of services.resourceLoader.getExtensions().extensions)for(const name of extension.tools.keys()) {
        if(name==="start_work"&&extension.path==="<inline:cothink>")continue;
        if(hostNames.has(name)||builtinNames.has(name)||owners.has(name))throw problem("TOOL_COLLISION","扩展工具与宿主或其他扩展冲突："+name);
        owners.set(name,extension.path);
      }
      return owners;
    };
    const validateNativeTools=()=>{hostRoutingTools();pluginOwners();};
    const isUnadaptedOwner=owner=>!nativeContext?.supportsNativeSubagents&&packageSnapshot.packages.some(p=>p.name==="pi-subagents"&&p.installedPath&&resourceWithin(p.installedPath,owner));
    const nativeEnabled=()=>nativePluginTools&&Boolean(binding)&&binding.task.record.status==='running'&&!binding.task.signal.aborted&&["work","worker","worker-feedback"].includes(binding.stage.phase);
    if(!nativePluginTools&&extraToolNames.length)throw problem("UNADAPTED_PLUGIN","原生插件工具需要独立工作目录与工作适配器");
    validateNativeTools();
    const customTools=toolDefinitions;
    const allowedNames=[...hostNames];
    const selectManagedNames=names=>{
      if(!Array.isArray(names)||names.some(n=>!hostNames.has(n)))throw problem("TOOL_UNAVAILABLE","只能启用此宿主已定义的受控工具");
      return [...new Set(names)];
    };
    let managedNames=selectManagedNames(activeToolNames??allowedNames);
    const model = mr.getModel(modelRef.provider, modelRef.modelId);
    if (!model)
      throw problem(
        "MODEL_UNAVAILABLE",
        `模型不可用：${modelRef.provider}/${modelRef.modelId}`,
      );
    let result;
    try {
      result = await createAgentSessionFromServices({
        services: {...services,cwd:nativeContext?.cwd ?? (()=>{
          const path=join(home,"pi/plugin-contexts",manager.getSessionId());privateDirectory(path);return path;
        })()},
        sessionManager: manager,
        sessionStartEvent,
        model,
        thinkingLevel: await resolveModelThinking(model, modelRef.thinkingLevel),
        ...(nativePluginTools ? {noTools:"builtin"} : {tools:allowedNames}),
        customTools,
      });
    } catch (e) {
      writer.release();
      throw e;
    }
    const appendMessage = manager.appendMessage.bind(manager);
    manager.appendMessage = (message) => {
      const id = appendMessage(message);
      if (
        binding &&
        binding.stage.phase === "draft" &&
        message.role === "user" &&
        !binding.task.record.branchMarkerId
      ) {
        binding.task.record.branchMarkerId = manager.appendCustomEntry(
          "cothink-task",
          {
            taskId: binding.task.record.id,
          },
        );
        binding.task.save();
      }
      return id;
    };
    const session = result.session;
    const hostSendCustomMessage=session.sendCustomMessage.bind(session),nativeSendUserMessage=session.sendUserMessage.bind(session);
    const unmanagedGeneration=()=>problem("UNADAPTED_PLUGIN","UNADAPTED_PLUGIN: Plugin-triggered model work requires a running managed work task; local commands and pure answers cannot launch it.");
    session.sendUserMessage=(...args)=>nativeEnabled()?nativeSendUserMessage(...args):Promise.reject(unmanagedGeneration());
    session.sendCustomMessage=(message,options)=>options?.triggerTurn&&!nativeEnabled()?Promise.reject(unmanagedGeneration()):hostSendCustomMessage(message,options);

    let extensionsBound = false;
    const bindExtensions = session.bindExtensions.bind(session);
    session.bindExtensions = async (...args) => {
      if(uiContext&&!args[0]?.uiContext)args[0]={...args[0],uiContext,mode:uiMode};
      await inNativeContext(()=>bindExtensions(...args));
      extensionsBound = true;
      if(runtime&&args[0]?.uiContext){runtime.extensionUI=args[0].uiContext;runtime.extensionMode=args[0].mode??"print";}
    };
    session.setActiveToolsByName(managedNames);
    let stopAfterTurn = false;
    const finishTurn = session.agent.finishTurn;
    session.agent.finishTurn = async (...args) => {
      const decision = await finishTurn?.(...args);
      return stopAfterTurn ? { action: "end" } : decision;
    };
    const originalDispose = session.dispose.bind(session);
    session.dispose = () => {
      disposed = true;
      writer.release();
      projectLease?.release();
      originalDispose();
    };
    let runtimeError, unsubscribeError;
    const bindErrors = () => {
      unsubscribeError?.();
      unsubscribeError = session.extensionRunner.onError((event) => {
        runtimeError = problem(event.error?.includes("EXTENSION_UI_UNSUPPORTED")?"EXTENSION_UI_UNSUPPORTED":event.error?.includes("UNADAPTED_PLUGIN")?"UNADAPTED_PLUGIN":"EXTENSION_ERROR", event.error ?? "扩展异常");
        if (binding) binding.error = runtimeError;
      });
    };
    bindErrors();
    const enforce = () => {
      session.setAutoCompactionEnabled(false);
      session.setAutoRetryEnabled(false);
      settingsManager.setCacheWarmingMode("off");
      validateNativeTools();
      session.setActiveToolsByName([...managedNames,...(nativeEnabled()?[...pluginOwners()].filter(([,owner])=>!isUnadaptedOwner(owner)).map(([name])=>name):[])]);
    };
    const originalReload = session.reload.bind(session);
    session.reload = async (options) => {
      if (binding?.task.record.status === "running")
        throw problem(
          "TASK_BUSY",
          "逻辑任务尚未结束，请先取消或等待后再 reload。",
        );
      try {
      // Idle reload is the explicit revalidation point for live local extension development.
      const refreshed=auditHostResources(resourceAudit.map(r=>r.path),cwd);
      await runtime.checkPackages();
      resourceAudit.splice(0,resourceAudit.length,...refreshed);
      runtimeError = null;
      await originalReload({
        ...options,
        beforeSessionStart: async () => {
          bindErrors();
          await options?.beforeSessionStart?.();
        },
      });
      bindErrors();
      gateNativeCommands();
      const errors = services.resourceLoader.getExtensions().errors ?? [];
      if (errors.length)
        throw problem("EXTENSION_LOAD", errors.map((e) => e.error).join("\n"));
      enforce();
      if (runtimeError) throw runtimeError;
      } catch(error) {runtimeError=error;throw error;}
    };
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "extension_error" && binding) {
        binding.error = problem("EXTENSION_ERROR", event.error ?? "扩展异常");
      }
    });
    runtime = {
      packageSnapshot,
      extensionUI:uiContext,
      extensionMode:uiMode,
      packageError,
      resourceOptions,
      async checkPackages({
        resourceOptions: currentOptions = originalResourceOptions,
      } = {}) {
        if (packageError) throw packageError;
        assertPackageReadable(home);
        const current = await resolvePackageResources({
          home,
          cwd:packageProject,
          manual: {
            skills: currentOptions.additionalSkillPaths ?? [],
            prompts: currentOptions.additionalPromptTemplatePaths ?? [],
            themes: currentOptions.additionalThemePaths ?? [],
          },
        });
        if (JSON.stringify(current) !== JSON.stringify(packageSnapshot))
          throw problem(
            "PACKAGE_CHANGED",
            "包资源与本次启动快照不符，请退出后重新打开。历史与 team 仍可查看。",
          );
      },
      async bindUI(){if(!extensionsBound)await session.bindExtensions({mode:uiMode,uiContext});},
      async dispatchCommand(text) {
        if(binding?.task.record.status==="running")throw problem("TASK_BUSY","当前任务尚未结束；插件命令不自动排队。");
        gateNativeCommands();validateNativeTools();
        const name=/^\/([^\s]+)/.exec(text)?.[1];
        const owner=services.resourceLoader.getExtensions().extensions.find(e=>e.commands.has(name));
        if(owner&&isUnadaptedOwner(owner.path))throw problem("UNADAPTED_PLUGIN","This pi-subagents native command route is not tracked; use cothink_helper inside managed work.");
        if(!name||!session.extensionRunner.getRegisteredCommands().some(c=>c.name===name))throw problem("COMMAND_UNAVAILABLE","未知插件命令。");
        if(!extensionsBound)await session.bindExtensions({mode:"print"});
        await session.prompt(text);
        validateNativeTools();gateNativeCommands();
        if(runtimeError)throw runtimeError;
      },
      commands(){gateNativeCommands();return session.extensionRunner.getRegisteredCommands();},
      session,
      services,
      modelRuntime: mr,
      sessionManager: manager,
      assertOwned: writer.assertOwned,
      stopAfterTurn() {
        stopAfterTurn = true;
      },
      setToolNames(names) {
        managedNames = selectManagedNames(names);
        enforce();
      },
      async selectModel(ref) {
        runtime.applyingModel = true;
        try {
          const model = mr.getModel(ref.provider, ref.modelId);
          if (!model) throw problem("MODEL_UNAVAILABLE", "模型不可用");
          const thinkingLevel = await resolveModelThinking(model, ref.thinkingLevel);
          await session.setModel(model);
          session.setThinkingLevel(thinkingLevel);
        } finally {
          runtime.applyingModel = false;
        }
      },
      unbindTask() {
        if (binding) binding.task.runtimes.delete(runtime);
        binding = undefined;
      },
      bindTask(task, stage) {
        if (binding) binding.task.runtimes.delete(runtime);
        binding = {
          task,
          stage,
          modelRef: stage.modelRef,
          maxOutputTokens,
          timeout,
          error: null,
          assertOwned: writer.assertOwned,
        };
        task.runtimes.add(runtime);
        enforce();
        stage.resourceAudit = [
          ...resourceAudit.map(r=>{const p=[...packageSnapshot.packages].sort((a,b)=>(b.scope==="project")-(a.scope==="project")).find(p=>p.installedPath&&resourceWithin(p.installedPath,r.path));return {...r,...(guiManagedPaths.includes(r.path)?{nativeLoaded:false,route:"managed-helper-backend",reason:"Managed child loads the selected plugin; native manager remains in the terminal shell"}:{}),...(p?{source:p.source,scope:p.scope,version:p.version,commit:p.commit}: {})};}),
          ...["skills", "prompts", "themes"].flatMap((kind) =>
            packageSnapshot[kind].map((path) => {
              const source = packageSnapshot.packages.find((p) =>
                p.installedPath ? resourceWithin(p.installedPath,path) : path.includes("/node_modules/" + p.name + "/"),
              );
              return {
                path,
                kind,
                source: source?.source,
                version: source?.version,
              };
            }),
          ),
          ...packageSnapshot.diagnostics.map((d) => ({ ...d, enabled: false })),
        ];
        stage.sessionId = manager.getSessionId();
        stage.sessionFile = manager.getSessionFile();
        task.save();
      },
      async prompt(input, { custom = false, ...options } = {}) {
        writer.assertOwned();
        if (!extensionsBound) await session.bindExtensions({ mode: "print" });
        enforce();
        if (runtimeError) throw runtimeError;
        if (!binding) throw problem("NO_TASK", "请先绑定逻辑任务");
        const { task, stage } = binding;
        stopAfterTurn = false;
        await runtime.selectModel(stage.modelRef);
        const abort = () => {
          void session.abort();
        };
        task.signal.addEventListener("abort", abort, { once: true });
        try {
          if (task.signal.aborted) throw task.signal.reason;
          if (custom)
            await hostSendCustomMessage(
              {
                customType: typeof custom === "string" ? custom : "cothink-review",
                content: input,
                display: false,
                details: { taskId: task.record.id, phase: stage.phase },
              },
              { triggerTurn: true },
            );
          else await session.prompt(input, options);
          if (binding.error) throw binding.error;
          if (task.ioError) throw task.ioError;
          if (task.signal.aborted) throw task.signal.reason;
          const call = task.requests().findLast((c) => c.stageId === stage.id);
          if (!call || call.status !== "completed") {
            let detail = call?.response?.errorMessage ?? call?.error;
            if (!detail && call?.response?.stopReason === "length") {
              const phase = {
                draft: "主答初稿",
                review: "独立评审",
                revision: "主答修订",
              }[stage.phase] ?? stage.phase;
              const cap = call.limits?.maxOutputTokens;
              detail = `${phase}（${call.actualModel.provider}/${call.actualModel.modelId}）回复截断（partial）：服务返回 length，表示达到输出额度或上下文限制。` +
                (cap == null
                  ? "本次未指定输出额度，服务商默认额度仍可能生效。"
                  : `本次明确设置的输出额度为 ${cap} tokens。`) +
                "请检查模型设置中的输出额度；CLI 可用 --max-output-tokens N 显式调整服务商支持的额度；如已达到服务商限制，请缩短问题、材料或所需输出。已接收内容保留，未自动重试。";
            }
            throw problem(
              call?.status ?? "FAILED",
              detail ??
                (call?.status === "partial"
                  ? "回复截断（partial），保留已有内容。"
                  : "请求未完成，未自动重发。"),
            );
          }
          nativeContext?.afterPrompt?.();
          stage.status = "completed";
          stage.entryId = manager.getLeafId();
          stage.sessionFile = manager.getSessionFile();
          task.save();
          return { call, text: call.text, message: call.response };
        } catch (error) {
          stage.status = task.signal.aborted ? "cancelled" : "partial";
          stage.error = error.message;
          try {
            task.save();
          } catch {
            /* caller exports memory recovery */
          }
          throw error;
        } finally {
          task.signal.removeEventListener("abort", abort);
        }
      },
      async dispose() {
        if (disposed) return;
        if (disposal) return disposal;
        disposal = (async()=>{
          let cleanupTimer;
          try {
            const priorError = runtimeError;
            await Promise.race([
              (async()=>{await session.abort();await session.extensionRunner.emit({type:"session_shutdown",reason:"quit"});})(),
              new Promise((_,reject)=>{cleanupTimer=setTimeout(()=>reject(problem("SHUTDOWN_UNKNOWN","Native extension cleanup did not confirm shutdown within the 15-second technical cleanup window; session/package lease retained.")),15000);}),
            ]);
            if (runtimeError && runtimeError !== priorError) throw runtimeError;
            let lateOutputError;
            try {
              const pending=nativeContext?.afterShutdown?.()??[];
              if(pending.length&&!binding?.task.signal.aborted)lateOutputError=problem("PLUGIN_RESULTS_PENDING","Awaited native session_shutdown produced unreviewed file results: "+pending.join(", ")+"; preserved, not imported");
            }catch(error){lateOutputError=error;}
            if (binding) binding.task.runtimes.delete(runtime);
            unsubscribeError();
            unsubscribe();
            session.dispose();
            if(lateOutputError)throw lateOutputError;
          } catch(error) {
            // Keep the lease when cleanup cannot be confirmed, and preserve the failure.
            if(binding) {binding.task.record.nativeShutdownError??=error.message;if(binding.task.record.status!=="outcome_unknown"||!disposed)binding.task.record.status=disposed?"partial":"outcome_unknown";binding.task.save();}
            throw error;
          } finally {
            clearTimeout(cleanupTimer);
          }
        })();
        return disposal;
      },
    };
    for(const name of ['prompt','dispatchCommand','bindUI']){const method=runtime[name].bind(runtime);runtime[name]=(...args)=>inNativeContext(()=>method(...args));}
    return runtime;
  } catch (error) {
    writer.release();
    projectLease?.release();
    throw error;
  }
}

/** Native Pi explicit resource paths; no global Pi settings are imported or modified. */
export function selectedResources(config, cwd = process.cwd()) {
  const r = config.piResources ?? {};
  for (const key of ["extensions", "skills", "prompts", "themes", "tools"]) {
    if (
      r[key] !== undefined &&
      (!Array.isArray(r[key]) ||
        r[key].some((x) => typeof x !== "string" || !x.trim()))
    )
      throw Error("piResources 的路径和工具列表必须是非空字符串数组");
  }
  return {
    additionalExtensionPaths: (r.extensions ?? []).map((p) => resolve(cwd, p)),
    additionalSkillPaths: (r.skills ?? []).map((p) => resolve(cwd, p)),
    additionalPromptTemplatePaths: (r.prompts ?? []).map((p) =>
      resolve(cwd, p),
    ),
    additionalThemePaths: (r.themes ?? []).map((p) => resolve(cwd, p)),
  };
}
