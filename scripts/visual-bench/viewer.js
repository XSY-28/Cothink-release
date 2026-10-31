const $ = (id) => document.getElementById(id);
let state,
  queue = Promise.resolve();
const element = (tag, text, cls) => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};
const frame = (url) => {
  const f = document.createElement("iframe");
  f.sandbox = "allow-scripts";
  f.referrerPolicy = "no-referrer";
  f.src = url;
  return f;
};
async function post(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw Error(data.error);
  return data;
}
function save(question, selected, note) {
  queue = queue
    .catch(() => {})
    .then(() => post("/api/vote", { question, selected, note }))
    .then(() => {
      state.votes.choices[question] = { selected, note };
      $("message").textContent = "选择已保存";
    })
    .catch((e) => {
      $("message").textContent = "保存失败：" + e.message;
      throw e;
    });
  queue.catch(() => {});
}
let refreshTimer;
function showProgress(snapshot) {
  if (snapshot.ready) return;
  const n = snapshot.progress?.waitingRequests ?? 0;
  const next = snapshot.progress?.nextRetryAt;
  $("message").textContent = n
    ? `服务过载、限流或暂时不可用，${n} 个请求正在等待重试${next ? "；最近计划时间 " + new Date(next).toLocaleTimeString() : ""}。其他任务独立继续，可在运行终端按 Ctrl+C 停止。`
    : "本轮正在执行；结束后可选择。可在运行终端按 Ctrl+C 停止。";
}
function refreshProgress() {
  clearTimeout(refreshTimer);
  if (state.ready) return;
  refreshTimer = setTimeout(async () => {
    try {
      const latest = await (await fetch("/api/state")).json();
      if (latest.ready) {
        $("message").textContent = "本轮已结束，可以开始盲选。";
        await load();
        return;
      }
      showProgress(latest);
    } catch (e) {
      $("message").textContent = "读取进度失败：" + e.message;
    }
    refreshProgress();
  }, 2000);
}
async function load() {
  state = await (await fetch("/api/state")).json();
  $("artifactNotice").textContent=state.ready?`本轮可查看 ${state.presentation.available} 份 HTML，其中 ${state.presentation.partial} 份来自部分完成的任务；${state.presentation.missing} 项没有完整 HTML。原始状态在揭晓后可查看。`:"";
  showProgress(state);
  refreshProgress();
  $("questions").replaceChildren();
  for (const q of state.questions) {
    const section = element("section", undefined, "question");
    section.append(element("h2", q.title));
    const cards = element("div", undefined, "cards"),
      inputs = [],
      choice = state.votes.choices[q.id];
    const note = element("textarea");
    note.placeholder = "选择理由（可选）";
    note.maxLength = 2000;
    note.value = choice?.note ?? "";
    note.disabled = state.votes.revealed || !state.ready;
    note.setAttribute("aria-label", q.title + "的选择理由");
    const selected = () => inputs.flatMap((x, i) => (x.checked ? [i] : []));
    q.cards.forEach((c, i) => {
      const card = element("article", undefined, "card"),
        tools = element("div", undefined, "tools");
      tools.append(element("span", c.label, "label"));
      let f;
      if (c.url) {
        f = frame(c.url);
        const replay = element("button", "重播");
        replay.onclick = () => {
          const n = frame(c.url);
          f.replaceWith(n);
          f = n;
        };
        const zoom = element("button", "放大");
        zoom.onclick = () => {
          $("zoomContent").replaceChildren(frame(c.url));
          $("zoom").showModal();
        };
        tools.append(replay, zoom);
      }
      card.append(
        tools,
        c.url ? f : element("div", "没有可展示的最终 HTML", "missing"),
      );
      const vote = element("label", undefined, "vote"),
        input = document.createElement("input");
      input.type = "checkbox";
      input.checked = choice?.selected.includes(i) ?? false;
      input.disabled = state.votes.revealed || !state.ready;
      input.onchange = () => save(q.id, selected(), note.value);
      inputs.push(input);
      vote.append(
        input,
        document.createTextNode("选择 " + c.label + "（可多选并列）"),
      );
      card.append(vote);
      cards.append(card);
    });
    section.append(cards);
    const feedback = element("div", undefined, "feedback"),
      none = element("button", "都不合格");
    none.disabled = state.votes.revealed || !state.ready;
    none.onclick = () => {
      for (const x of inputs) x.checked = false;
      save(q.id, [], note.value);
    };
    note.onchange = () => {
      if (state.votes.choices[q.id] || selected().length)
        save(q.id, selected(), note.value);
    };
    feedback.append(none, note);
    section.append(feedback);
    $("questions").append(section);
  }
  $("reveal").disabled = state.votes.revealed || !state.ready;
  if (state.report) {
    $("report").hidden = false;
    $("results").replaceChildren();
    for (const q of state.report.questions) {
      const choice = q.choice.selected.length
        ? q.choice.selected.map((i) => "ABC"[i]).join("、")
        : "都不合格";
      const lines = q.mapping.map(
        (m, i) =>
          `${"ABC"[i]} → ${m.group} · ${m.outcome?.status ?? "未运行"}\n耗时 ${m.durationMs === null ? "未知" : (m.durationMs / 1000).toFixed(1) + "秒"} · 退避等待 ${m.retryWaitMs === null ? "未知" : (m.retryWaitMs / 1000).toFixed(1) + "秒"} · 其余执行 ${m.otherElapsedMs === null ? "未知" : (m.otherElapsedMs / 1000).toFixed(1) + "秒"}\n实际HTTP尝试 ${m.requestAttempts}（含重试 ${m.retryCount}） · 成员 ${m.outcome?.members?.length ?? 0}\n${
            m.costs
              .filter(
                (c) =>
                  c.settledCeiling || c.heldForUnknown || c.unknownRequests,
              )
              .map(
                (c) =>
                  `${c.model}: 上界计账 ${c.settledCeiling.toFixed(6)} ${c.currency}${c.heldForUnknown ? "；未知预留 " + c.heldForUnknown.toFixed(6) : ""}${c.unknownRequests ? "；费用未知请求 " + c.unknownRequests + " 次" : ""}`,
              )
              .join(" / ") || "无模型费用记录"
          }（实际账单未知）`,
      );
      $("results").append(
        element("h3", q.title),
        element(
          "p",
          `你的选择：${choice}\n${lines.join("\n")}${q.choice.note ? "\n理由：" + q.choice.note : ""}`,
        ),
      );
    }
  }
}
$("reveal").onclick = async () => {
  try {
    await queue;
    await post("/api/reveal", {});
    await load();
    $("report").scrollIntoView();
  } catch (e) {
    $("message").textContent = e.message;
  }
};
$("closeZoom").onclick = () => {
  $("zoom").close();
  $("zoomContent").replaceChildren();
};
$("zoom").addEventListener("close", () => $("zoomContent").replaceChildren());
$("export").onclick = async () => {
  try {
    const r = await post("/api/export", {});
    $("message").textContent = "报告已保存：" + r.file;
  } catch (e) {
    $("message").textContent = e.message;
  }
};
load().catch((e) => {
  $("message").textContent = e.message;
});
