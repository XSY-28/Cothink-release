import { readFileSync } from "node:fs";
import { readTask, readRequests } from "./task.js";
import { finalAnswerText, safeText } from "./terminal.js";
export function releaseNotes() {
  const { version } = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const full = readFileSync(
    new URL("../CHANGELOG.md", import.meta.url),
    "utf8",
  );
  const entries = [
    ...full.matchAll(/^## ([^\s]+)[^\n]*\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm),
  ];
  const entry = entries.find((match) => match[1] === version);
  const bullets = entry?.[2]
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .slice(0, 3);
  if (!bullets?.length) throw Error(`CoThink ${version} 缺少随包更新记录。`);
  return {
    version,
    full,
    summary: [
      `CoThink ${version} 本次更新`,
      ...bullets,
      "/changelog 查看完整更新记录",
    ].join("\n"),
  };
}
export function workCheckText(check) {
  if (!check) return "未记录";
  if (check.status !== "passed")
    return `未通过（${check.status ?? "unknown"}）`;
  if (check.verification !== "passed") return "未验证（空检查策略）";
  return check.reusedFrom ? "通过（复用既有检查）" : "通过";
}
export function finalText(record, requests) {
  if (record.status !== "completed") return "";
  const text = finalAnswerText(
    requests.find((c) => c.id === record.finalCallId)?.text ?? "",
  );
  if (!record.work) return text;
  return (
    text +
    `\n\n宿主记录：正式版本 ${record.work.version}；检查${workCheckText(record.work.finalCheck)}。\n成果工作区：${record.work.resultWorkspace}\n集成引用：${record.work.integrationRef}（写回原分支须显式合并）。`
  );
}
export function detailsText(record, requests) {
  return [
    `任务 ${record.id ?? ""} · ${record.status}`,
    record.input ?? "",
    record.error ?? "",
    record.team ? `team：${record.team.name} · ${record.team.id}\n主模型：${record.team.main.provider}/${record.team.main.modelId}\n有序副模型：${record.team.secondary.map(m => `${m.provider}/${m.modelId}`).join("、")}（阵容不等于已调用）` : "当时未记录 team",
    ...(record.answerSkills?.length
      ? [
          "\n本条已预载技能（提供材料，不代表已使用）：",
          ...record.answerSkills.map(
            (s) => `${s.name} · ${s.path} · SHA-256 ${s.hash}`,
          ),
        ]
      : []),
    ...requests.map(
      (c) =>
        `\n${c.phase ?? ""} · ${c.role ?? ""} · ${c.actualModel?.provider ?? ""}/${c.actualModel?.modelId ?? ""} · ${c.status ?? ""}\n${c.text ?? c.error ?? ""}`,
    ),
    ...(record.work
      ? [
          `\n工作与版本：${JSON.stringify(record.work, null, 2)}`,
          `\n成员：${JSON.stringify(record.members, null, 2)}`,
          `\n工具来源：${JSON.stringify(record.tools, null, 2)}`,
        ]
      : []),
    ...(record.workFacts
      ? [`\n只读恢复事实：${JSON.stringify(record.workFacts, null, 2)}`]
      : []),
    ...(record.workFacts?.outputs ?? []).map(
      (o) =>
        `\n完整执行日志 output:${o.outputRef}：\n${o.error ?? Buffer.from(o.contentBase64, "base64").toString("utf8")}`,
    ),
    ...toolTranscripts(record),
    `\n用量：${JSON.stringify(record.usage ?? "尚未汇总")}`,
  ].join("\n");
}
export function projectMessage(home, message) {
  if (message.role === "assistant") {
    if (!message.cothinkTaskId || !message.cothinkMessageId) return null;
    let record, requests;
    try {
      record = readTask(home, message.cothinkTaskId);
      requests = readRequests(home, record);
    } catch {
      return null;
    }
    const final = requests.find((c) => c.id === record.finalCallId);
    if (
      record.status !== "completed" ||
      !final ||
      final.displayId !== message.cothinkMessageId
    )
      return null;
    return {
      ...message,
      content: [{ type: "text", text: finalText(record, requests) }],
    };
  }
  if (message.role === "custom" && message.customType?.startsWith("cothink-"))
    return null;
  return message;
}
export function budgetText(config, singleModel = false, limits = {}) {
  const modelCaps = [config.main, ...(singleModel ? [] : config.secondary)]
    .map((m, i) =>
      m.maxOutputTokens != null
        ? `${i === 0 ? "主模型" : "副" + i} ${m.maxOutputTokens} tokens`
        : null,
    )
    .filter(Boolean);
  const output =
    limits.maxOutputTokens != null
      ? `输出额度 ${limits.maxOutputTokens} tokens`
      : modelCaps.length
        ? `配置输出额度：${modelCaps.join("、")}；未指定者不设本地上限`
        : "可省略输出额度不设本地上限";
  const timing = limits.timeout
    ? `模型超时 ${limits.timeout}ms`
    : "无默认模型超时";
  return `预算：纯答 ${singleModel ? 1 : 3} 次；工作调用次数不设上限；${output}；${timing}；自动重试/压缩/预热关闭。未知用量保留未知，费用为目录估算。`;
}
export function taskJson(home, record) {
  return {
    task: record,
    requests: readRequests(home, record),
    taskEnd: record.status,
  };
}
export function renderTask(home, record, all = false) {
  const requests = readRequests(home, record);
  return (
    safeText(
      all ? detailsText(record, requests) : finalText(record, requests),
    ) + "\n"
  );
}

function toolTranscripts(record) {
  return [
    ...new Set(
      (record.stages ?? [])
        .filter((s) => s.phase.startsWith("work"))
        .map((s) => s.sessionFile)
        .filter(Boolean),
    ),
  ].map((path) => {
    try {
      return (
        `\nPi 工具原文（${path}）：\n` +
        readFileSync(path, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter(
            (e) => e.type === "message" && e.message?.role === "toolResult",
          )
          .map((e) => JSON.stringify(e.message))
          .join("\n")
      );
    } catch (error) {
      return `\nPi 工具记录无法读取（保留引用 ${path}）：${error.message}`;
    }
  });
}
/** Recover acceptance facts only. Never continue a model, merge or check on history reads. */
export async function inspectWork(
  home,
  record,
  { includeOutputs = false } = {},
) {
  if (!record.work) return null;
  let v;
  try {
    const { createVersioning } = await import("./versioning.js");
    v = await createVersioning({
      home,
      toolHome: record.work.toolHome,
      backend: record.work.backend,
      project: record.work.root,
      checks: record.work.checks ?? [],
      readOnly: true,
    });
    const project = await v.inspect();
    const acceptance = await Promise.all(
      (record.work.acceptance ?? []).map((r) =>
        v.inspect({ requestId: r.requestId }),
      ),
    );
    const requestIds = [
      ...new Set(
        [
          ...(record.work.requests ?? []).map((r) => r.requestId),
          ...(record.tools ?? [])
            .filter((t) => t.kernelInput)
            .map((t) => t.requestId),
        ].filter(Boolean),
      ),
    ];
    const requests = await Promise.all(
      requestIds.map((requestId) => v.inspect({ requestId })),
    );
    const outputs = [];
    if (includeOutputs) {
      const refs = [
        ...new Set(
          [
            ...(record.tools ?? []).map((t) => t.outputRef),
            ...(record.work.acceptance ?? []).flatMap((r) =>
              (r.checks ?? []).map((c) => c.outputRef),
            ),
            ...(record.work.finalCheck?.checks ?? []).map((c) => c.outputRef),
          ].filter(Boolean),
        ),
      ];
      for (const outputRef of refs) {
        try {
          const pages = [];
          let offset = 0;
          for (;;) {
            const r = await v.read({ outputRef, offset });
            pages.push(Buffer.from(r.contentBase64, "base64"));
            if (r.eof) break;
            offset = r.nextOffset;
          }
          outputs.push({
            outputRef,
            contentBase64: Buffer.concat(pages).toString("base64"),
          });
        } catch (e) {
          outputs.push({ outputRef, error: e.message });
        }
      }
    }
    return {
      ...project,
      acceptance,
      requests,
      ...(includeOutputs ? { outputs } : {}),
    };
  } catch (error) {
    return { status: "unavailable", error: error.message };
  } finally {
    await v?.close();
  }
}
