import { freezeAnswerSkills } from "../../src/context.js";
import { visualManifest } from "../../src/visual-preview.js";
import { createHash, randomUUID, randomInt } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  realpathSync,
  existsSync,
} from "node:fs";
import { join, resolve, relative, dirname, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { writePrivateJson } from "../../src/storage.js";
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
export function save(p, value) {
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writePrivateJson(p, value);
}
export const hash = (s) => createHash("sha256").update(s).digest("hex");
export const promptFor = (title) =>
  `做一个${title}的动态html界面，svg，不允许联网`;
export function fingerprint() {
  const digest = createHash("sha256");
  const visit = (p) => {
    for (const n of readdirSync(join(ROOT, p)).sort()) {
      const f = join(p, n),
        s = lstatSync(join(ROOT, f));
      if (s.isDirectory()) visit(f);
      else if (s.isFile()) {
        digest.update(f);
        digest.update(readFileSync(join(ROOT, f)));
      } else if (s.isSymbolicLink())
        throw Error("运行文件不能为符号链接: " + f);
    }
  };
  for (const p of [
    "src",
    "prompts",
    "packages/agent-sync/src",
    "scripts/visual-bench",
    "vendor/pi-deps",
    "docker",
  ])
    visit(p);
  for (const p of [
    "package.json",
    "package-lock.json",
    "scripts/visual-bench.mjs",
    "scripts/visual-preview.mjs",
  ]) {
    digest.update(p);
    digest.update(readFileSync(join(ROOT, p)));
  }
  return digest.digest("hex");
}
export function validateConfig(c) {
  if (!Array.isArray(c.models) || c.models.length !== 2)
    throw Error("需要两个不同的模型");
  if (c.models[0].modelId === c.models[1].modelId)
    throw Error("两个模型必须不同");
  for (const m of c.models) {
    if (
      !m.provider ||
      !m.modelId ||
      m.api !== "openai-completions" ||
      !Number.isSafeInteger(m.contextWindow) ||
      m.contextWindow <= 0
    )
      throw Error("模型必须提供有效的 OpenAI Chat Completions 目录信息");
    const u = new URL(m.baseUrl);
    if (
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      !(
        u.protocol === "https:" ||
        (u.protocol === "http:" && u.hostname === "127.0.0.1")
      )
    )
      throw Error("无效的服务商地址");
  }
  for (const k of ["maxMinutes", "maxCalls", "outputTokens"])
    if (
      c.limits?.[k] !== null &&
      (!Number.isSafeInteger(c.limits?.[k]) || c.limits[k] <= 0)
    )
      throw Error("必须明确设置 limits." + k);
  if (!Array.isArray(c.budgets) || c.budgets.length !== 2)
    throw Error("需要分别设置两个模型的预算");
  for (const b of c.budgets) {
    if (!["CNY", "USD"].includes(b.currency))
      throw Error("预算币种为 CNY 或 USD");
    for (const k of ["limit", "inputPerMillion", "outputPerMillion"])
      if (
        !(k === "limit" && b[k] === null) &&
        (typeof b[k] !== "number" || !Number.isFinite(b[k]) || b[k] <= 0)
      )
        throw Error("请明确填写 budgets 的金额及每百万 token 价格上界");
  }
  if (
    c.execution?.engine !== "docker" ||
    c.execution.network !== "none" ||
    !/(?:@|^)sha256:[a-f0-9]{64}$/.test(c.execution.image ?? "")
  )
    throw Error("必须使用固定摘要的 Docker 镜像并关闭网络");
  for (const k of ["memoryBytes", "cpus", "pids"])
    if (!(c.execution.limits?.[k] > 0))
      throw Error("必须明确设置 execution.limits." + k);
  for (const m of c.models)
    if (c.limits.outputTokens > m.maxTokens)
      throw Error("输出上限超过模型声明");
}
export async function prepareRound({ out, tasks, config }) {
  validateConfig(config);
  if (
    !tasks.length ||
    tasks.some((t) => typeof t !== "string" || !t.trim() || t.includes("\n"))
  )
    throw Error("题目需为非空单行文本");
  const manifest=visualManifest();
  if(config.execution.image!==manifest.image)throw Error("新视觉轮次需要已核验的visual-preview镜像digest");
  if(config.models.some(m=>!m.input?.includes('image')))throw Error("新视觉轮次的两个模型均须支持图像");
  const skills=freezeAnswerSkills({cwd:ROOT,home:config.sourceHome??ROOT,paths:config.piResources?.skills??[]});
  if(!skills.length)throw Error("请显式配置 piResources.skills；不扫描个人目录");
  const frozenSkills=skills.map(s=>({...s,source:readFileSync(s.path,'utf8')}));
  if(frozenSkills.some(s=>hash(s.source)!==s.hash))throw Error("技能读取时发生变化，请重新prepare");
  out = resolve(out);
  mkdirSync(out, { mode: 0o700 });
  const r = {
    schema: 1,
    workRequest:{kind:"html-svg"},
    visualWorkflow:{skills:frozenSkills,preview:{...manifest,viewport:{width:1440,height:900},frameTimesMs:[0,500,1000],maxActions:6}},
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    runtime: {
      version: readJson(join(ROOT, "package.json")).version,
      hash: fingerprint(),
    },
    config: structuredClone(config),
    questions: [],
    attempts: [],
  };
  for (const title of tasks) {
    const q = {
      id: randomUUID(),
      title,
      prompt: promptFor(title),
      promptHash: hash(promptFor(title)),
      order: [],
    };
    for (let group = 0; group < 3; group++) {
      const a = { id: randomUUID(), question: q.id, group };
      q.order.push(a.id);
      r.attempts.push(a);
    }
    for (let i = q.order.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [q.order[i], q.order[j]] = [q.order[j], q.order[i]];
    }
    r.questions.push(q);
  }
  save(join(out, "round.json"), r);
  writeFileSync(
    join(out, "round.sha256"),
    hash(readFileSync(join(out, "round.json"))) + "\n",
    { mode: 0o600 },
  );
  save(join(out, "votes.json"), { revealed: false, choices: {} });
  return r;
}
export async function loadRound(dir) {
  const bytes = readFileSync(join(resolve(dir), "round.json"));
  if (
    hash(bytes) !==
    readFileSync(join(resolve(dir), "round.sha256"), "utf8").trim()
  )
    throw Error("轮次配置已被改动，请准备新轮次");
  const r = JSON.parse(bytes);
  if (r.schema !== 1) throw Error("不支持的轮次版本");
  return r;
}
export function extractHtml(text) {
  const blocks = [...text.matchAll(/```(?:html|HTML)\s*\n([\s\S]*?)\n```/g)];
  if (blocks.length) return blocks.length === 1 ? blocks[0][1] : null;
  const docs = [
    ...text.matchAll(
      /(?:<!doctype html[^>]*>\s*)?<html\b[\s\S]*?<\/html\s*>/gi,
    ),
  ];
  return docs.length === 1 ? docs[0][0] : null;
}
export function safeFile(root, path) {
  const inside = (p) => {
    const r = relative(root, p);
    return r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r);
  };
  root = resolve(root);
  const p = resolve(root, path);
  if (!inside(p)) throw Error("越界路径");
  const real = realpathSync(p);
  root = realpathSync(root);
  if (!inside(real)) throw Error("符号链接越界");
  if (!lstatSync(p).isFile()) throw Error("不是文件");
  return p;
}
const units = (n) => Math.ceil(n * 1e6);
export function reserveCost(c, slot) {
  const b = c.budgets[slot];
  if (b.limit === null) return null;
  return Math.ceil(
    c.models[slot].contextWindow * b.inputPerMillion +
      (c.limits.outputTokens ?? c.models[slot].maxTokens) * b.outputPerMillion,
  );
}
export function createLedger(path, c) {
  const state = existsSync(path)
    ? readJson(path)
    : { requests: {}, blocked: false };
  state.blockedAttempts ??= {};
  state.progress ??= {};
  const persist = () => {
    try {
      save(path, state);
    } catch (error) {
      state.blocked = true;
      throw error;
    }
  };
  const used = (slot) =>
    Object.values(state.requests)
      .filter((r) => r.slot === slot)
      .reduce((n, r) => n + (r.cost ?? r.reserved), 0);
  return {
    state,
    preflight(attempts) {
      for (let slot = 0; slot < 2; slot++) {
        if (c.budgets[slot].limit === null) continue;
        const n = attempts.filter(
          (a) => a.group === slot || a.group === 2,
        ).length;
        if (
          used(slot) + n * reserveCost(c, slot) >
          units(c.budgets[slot].limit)
        )
          throw Error(
            `模型 ${slot + 1} 的预算不足以同时预留 ${n} 条通道；全上下文保守预留至少 ${((n * reserveCost(c, slot)) / 1e6).toFixed(6)} ${c.budgets[slot].currency}，并非预计实扣`,
          );
      }
    },
    reserve(attempt, slot, metadata = {}) {
      if (state.blocked) throw Error("存在未知请求或用量，禁止继续发送");
      if (state.blockedAttempts[attempt])
        throw Error("此任务已失败或请求结果未知，不自动重发");
      if (
        c.limits.maxCalls !== null &&
        Object.values(state.requests).filter((r) => r.attempt === attempt)
          .length >= c.limits.maxCalls
      )
        throw Error("本任务请求次数已达上限");
      const reserved = reserveCost(c, slot);
      if (
        c.budgets[slot].limit !== null &&
        used(slot) + reserved > units(c.budgets[slot].limit)
      )
        throw Error("剩余预算不足；未发送");
      const id = randomUUID();
      state.requests[id] = {
        ...metadata,
        id,
        attempt,
        slot,
        reserved,
        cost: null,
        status: "reserved",
        startedAt: new Date().toISOString(),
      };
      persist();
      return id;
    },
    annotate(id, diagnostics) {
      const r = state.requests[id];
      if (!r) throw Error("请求不存在");
      r.transport = structuredClone(diagnostics);
      persist();
    },
    settle(id, usage, terminal) {
      const r = state.requests[id];
      if (!r || r.status !== "reserved") throw Error("请求状态不允许重复结算");
      const i = usage?.prompt_tokens,
        o = usage?.completion_tokens;
      const valid =
        terminal &&
        Number.isSafeInteger(i) &&
        i >= 0 &&
        i <= c.models[r.slot].contextWindow &&
        Number.isSafeInteger(o) &&
        o >= 0 &&
        (c.limits.outputTokens === null || o <= c.limits.outputTokens);
      r.endedAt = new Date().toISOString();
      r.usage = usage ?? null;
      if (valid) {
        r.status = "settled";
        const b = c.budgets[r.slot];
        r.cost = Math.ceil(i * b.inputPerMillion + o * b.outputPerMillion);
      } else {
        r.status = "unknown";
        r.reason = terminal
          ? "invalid_or_missing_usage"
          : "transport_or_terminal_unknown";
        if (!terminal) state.blockedAttempts[r.attempt] = true;
        state.blocked ||= c.budgets[r.slot].limit !== null;
      }
      persist();
    },
    httpError(id, httpStatus, responseBody, responseHeaders, retryKind = null) {
      const r = state.requests[id];
      if (!r || r.status !== "reserved") throw Error("请求状态不允许重复结算");
      Object.assign(r, {
        status: "http_error",
        httpStatus,
        responseBody,
        responseHeaders,
        retryKind,
        cost: null,
        usage: null,
        endedAt: new Date().toISOString(),
      });
      if (!retryKind) state.blockedAttempts[r.attempt] = true;
      persist();
    },
    progress(logicalId, value) {
      state.progress[logicalId] = {
        ...state.progress[logicalId],
        ...value,
        updatedAt: new Date().toISOString(),
      };
      persist();
    },
    beginWait(id, delayMs) {
      const r = state.requests[id];
      r.waitStartedAt = new Date().toISOString();
      r.retryDelayMs = delayMs;
      r.nextRetryAt = new Date(Date.now() + delayMs).toISOString();
      persist();
    },
    endWait(id, outcome) {
      const r = state.requests[id];
      r.waitEndedAt = new Date().toISOString();
      r.waitMs = Date.parse(r.waitEndedAt) - Date.parse(r.waitStartedAt);
      r.waitOutcome = outcome;
      persist();
    },
    summary() {
      return c.models.map((m, i) => ({
        model: m.provider + "/" + m.modelId,
        currency: c.budgets[i].currency,
        ceilingUsedOrHeld: used(i) / 1e6,
        unknownRequests: Object.values(state.requests).filter(
          (r) => r.slot === i && r.cost === null,
        ).length,
        actualBilled: null,
      }));
    },
  };
}
