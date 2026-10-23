import { readFileSync, realpathSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
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
import { resolvePackageResources } from "./packages.js";
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
  return ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false,
  });
}
function secretValues(home) {
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
// Reviewed pure-UI source only. Packages with clone/cache/model/server effects are not
// host-isolated just because a tool name is selected. Audit before loading any JS.
const approvedUiHashes = new Set([
  "e607af659560463bcb2b009d125b73cf493dd0fdde659798ce3cb427ca9b0494",
]);
export function auditHostResources(paths = [], cwd = process.cwd()) {
  return paths.map((path) => {
    const absolute = resolve(cwd, path);
    let bytes;
    try {
      bytes = readFileSync(absolute);
    } catch {
      throw problem(
        "UNADAPTED_PLUGIN",
        "未适配宿主扩展：需要精确的、已审查纯UI文件：" + path,
      );
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (!approvedUiHashes.has(sha256))
      throw problem(
        "UNADAPTED_PLUGIN",
        "扩展尚未适配agent-sync隔离合同，加载前拒绝：" +
          absolute +
          "。写入、克隆、缓存、自有模型循环或MCP服务器不能获得宿主写权限。",
      );
    return { path: absolute, sha256, kind: "ui" };
  });
}
let transportConfigured = false;

export async function createRuntime({
  sessionStartEvent,
  home,
  cwd = process.cwd(),
  modelRef,
  modelRuntime,
  sessionManager,
  extensionFactories = [],
  resourceOptions = {},
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
  let binding,
    runtime,
    disposed = false;
  const manager =
    sessionManager ??
    SessionManager.create(cwd, join(agentDir, "sessions", role));
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
  try {
    let packageError;
    try {
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
      additionalSkillPaths: merge("additionalSkillPaths", "skills"),
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
    if (extraToolNames.length)
      throw problem(
        "UNADAPTED_PLUGIN",
        "尚无已适配隔离合同的宿主查询/写入扩展工具：" +
          extraToolNames.join(", "),
      );
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
    const services = await createAgentSessionServices({
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
        extensionFactories,
      },
    });
    const loaded = services.resourceLoader.getExtensions();
    const failures = [
      ...(loaded.errors ?? []).map((e) => e.error),
      ...services.diagnostics
        .filter((d) => d.type === "error")
        .map((d) => d.message),
    ];
    if (failures.length) throw problem("EXTENSION_LOAD", failures.join("\n"));
    const pluginDefinitions = [];
    for (const name of extraToolNames) {
      if (toolDefinitions.some((t) => t.name === name) || name === "start_work")
        throw problem("TOOL_COLLISION", "扩展工具与宿主冲突：" + name);
      const owners = loaded.extensions.flatMap((e) =>
        e.tools.has(name)
          ? [{ path: e.path, definition: e.tools.get(name).definition }]
          : [],
      );
      if (owners.length !== 1)
        throw problem("TOOL_UNAVAILABLE", "扩展工具不可用或重名：" + name);
      const { definition, path } = owners[0];
      if (path.includes("pi-web-access") && name !== "fetch_content")
        throw problem(
          "UNMANAGED_PLUGIN",
          "当前 pi-web-access 只验收 fetch_content raw；其他请求路径未纳管",
        );
      pluginDefinitions.push({
        ...definition,
        async execute(id, args, signal, onUpdate, ctx) {
          if (!binding) throw problem("UNMANAGED_TOOL", "扩展工具未绑定任务");
          const { task, stage } = binding;
          writer.assertOwned();
          if (stopAfterTurn)
            throw problem(
              "HANDOFF",
              "当前执行者正在切换，禁止继续调用扩展工具",
            );
          if (
            task.signal.aborted ||
            task.record.status !== "running" ||
            task.ioError
          )
            throw (
              task.signal.reason ??
              task.ioError ??
              problem("TASK_ENDED", "任务已停止")
            );
          const combined = signal
            ? AbortSignal.any([signal, task.signal])
            : task.signal;
          const trace = {
            toolCallId: id,
            name,
            source: path,
            cwd,
            stageId: stage.id,
            sessionFile: stage.sessionFile,
            status: "preparing",
          };
          (task.record.tools ??= []).push(trace);
          try {
            try {
              task.save();
            } catch (error) {
              task.ioError = error;
              throw error;
            }
            if (combined.aborted) throw combined.reason;
            trace.status = "running";
            if (
              path.includes("pi-web-access") &&
              (args.mode !== "raw" ||
                args.auth !== undefined ||
                args.proxy !== undefined)
            )
              throw problem(
                "UNMANAGED_PLUGIN",
                "当前 pi-web-access 仅允许显式 raw URL 查询；answer/浏览器认证/代理等路径未纳管",
              );
            const result = await definition.execute(
              id,
              args,
              combined,
              onUpdate,
              ctx,
            );
            trace.status = combined.aborted ? "cancelled" : "completed";
            return result;
          } catch (error) {
            trace.status = combined.aborted ? "cancelled" : "failed";
            trace.error = error.message;
            throw error;
          } finally {
            try {
              task.save();
            } catch (error) {
              task.ioError = error;
              throw error;
            }
          }
        },
      });
    }
    const customTools = [...toolDefinitions, ...pluginDefinitions];
    const allowedNames = [
      ...customTools.map((t) => t.name),
      ...(loaded.extensions.some((e) => e.tools.has("start_work"))
        ? ["start_work"]
        : []),
    ];
    const selectManagedNames = (names) => {
      if (!Array.isArray(names) || names.some((n) => !allowedNames.includes(n)))
        throw problem("TOOL_UNAVAILABLE", "只能启用此宿主已定义的受控工具");
      return [...new Set(names)];
    };
    let managedNames = selectManagedNames(activeToolNames ?? allowedNames);
    const model = mr.getModel(modelRef.provider, modelRef.modelId);
    if (!model)
      throw problem(
        "MODEL_UNAVAILABLE",
        `模型不可用：${modelRef.provider}/${modelRef.modelId}`,
      );
    let result;
    try {
      result = await createAgentSessionFromServices({
        services,
        sessionManager: manager,
        sessionStartEvent,
        model,
        thinkingLevel: modelRef.thinkingLevel ?? "off",
        tools: allowedNames,
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
      originalDispose();
    };
    let runtimeError, unsubscribeError;
    const bindErrors = () => {
      unsubscribeError?.();
      unsubscribeError = session.extensionRunner.onError((event) => {
        runtimeError = problem("EXTENSION_ERROR", event.error ?? "扩展异常");
        if (binding) binding.error = runtimeError;
      });
    };
    bindErrors();
    const enforce = () => {
      session.setAutoCompactionEnabled(false);
      session.setAutoRetryEnabled(false);
      settingsManager.setCacheWarmingMode("off");
      session.setActiveToolsByName(managedNames);
    };
    const originalReload = session.reload.bind(session);
    session.reload = async (options) => {
      if (binding?.task.record.status === "running")
        throw problem(
          "TASK_BUSY",
          "逻辑任务尚未结束，请先取消或等待后再 reload。",
        );
      verifyResourceAudit();
      await runtime.checkPackages();
      runtimeError = null;
      await originalReload({
        ...options,
        beforeSessionStart: async () => {
          bindErrors();
          await options?.beforeSessionStart?.();
        },
      });
      bindErrors();
      const errors = services.resourceLoader.getExtensions().errors ?? [];
      if (errors.length)
        throw problem("EXTENSION_LOAD", errors.map((e) => e.error).join("\n"));
      enforce();
      if (runtimeError) throw runtimeError;
    };
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "extension_error" && binding) {
        binding.error = problem("EXTENSION_ERROR", event.error ?? "扩展异常");
      }
    });
    runtime = {
      packageSnapshot,
      packageError,
      resourceOptions,
      async checkPackages({
        resourceOptions: currentOptions = originalResourceOptions,
      } = {}) {
        if (packageError) throw packageError;
        assertPackageReadable(home);
        const current = await resolvePackageResources({
          home,
          cwd,
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
          const { validateModelThinking } = await import("./thinking.js");
          await validateModelThinking(model, ref.thinkingLevel);
          await session.setModel(model);
          session.setThinkingLevel(ref.thinkingLevel ?? "off");
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
        stage.resourceAudit = [
          ...resourceAudit,
          ...["skills", "prompts", "themes"].flatMap((kind) =>
            packageSnapshot[kind].map((path) => {
              const source = packageSnapshot.packages.find((p) =>
                path.includes("/node_modules/" + p.name + "/"),
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
            await session.sendCustomMessage(
              {
                customType: "cothink-review",
                content: input,
                display: false,
                details: { taskId: task.record.id, phase: "revision" },
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
                "可用 --max-output-tokens N 显式调整服务商支持的额度；如已达到服务商限制，请缩短问题、材料或所需输出。已接收内容保留，未自动重试。";
            }
            throw problem(
              call?.status ?? "FAILED",
              detail ??
                (call?.status === "partial"
                  ? "回复截断（partial），保留已有内容。"
                  : "请求未完成，未自动重发。"),
            );
          }
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
      dispose() {
        if (binding) binding.task.runtimes.delete(runtime);
        unsubscribeError();
        unsubscribe();
        session.dispose();
      },
    };
    return runtime;
  } catch (error) {
    writer.release();
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
  if (
    (r.extensions ?? []).some((x) =>
      /(^|[/\\-])(subagent|agent-teams)([/\\.]|$)/i.test(x),
    )
  )
    throw Error("当前用户禁止安装或加载 subagent/agent-teams 插件");
  return {
    additionalExtensionPaths: (r.extensions ?? []).map((p) => resolve(cwd, p)),
    additionalSkillPaths: (r.skills ?? []).map((p) => resolve(cwd, p)),
    additionalPromptTemplatePaths: (r.prompts ?? []).map((p) =>
      resolve(cwd, p),
    ),
    additionalThemePaths: (r.themes ?? []).map((p) => resolve(cwd, p)),
  };
}
