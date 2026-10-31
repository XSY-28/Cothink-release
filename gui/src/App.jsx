import React, { useCallback, useEffect, useRef, useState } from "react";
import { createApi, consumeToken } from "./api.js";
import { Composer } from "./Composer.js";
import { Markdown } from "./Markdown.js";
import { Collaboration } from "./Collaboration.jsx";
import { Settings } from "./Settings.jsx";
import { ProjectDialog } from "./ProjectDialog.jsx";
import { Modal } from "./Modal.jsx";
import { createDraftBook, statusLabel, phaseLabel } from "./view.js";

const emptyBoot = {
  teams: [],
  models: [],
  providers: [],
  sessions: [],
  work: {},
  active: null,
};
function pendingFromStorage() {
  try {
    return JSON.parse(sessionStorage.getItem("cothink.pending") || "null");
  } catch {
    return null;
  }
}
function Budget({ team }) {
  const caps = team
    ? [team.main, ...team.secondary]
        .filter((m) => m.maxOutputTokens != null)
        .map((m) => `${m.modelId}: ${m.maxOutputTokens} tokens`)
    : [];
  return (
    <details className="budget-details">
      <summary>调用与预算政策</summary>
      <p>
        纯答 ONE 1 次，CoThink 3 次；工作调用次数不设上限。
        {caps.length
          ? "已设置输出额度：" + caps.join("、") + "。"
          : "可省略输出额度不设本地上限。"}
        无默认模型超时，自动重试、压缩和预热关闭。未知用量与费用保持未知，目录估算不等于账单。
      </p>
    </details>
  );
}
function ExtensionPrompt({prompt,onAnswer}) {
  const [value,setValue]=useState(""),[now,setNow]=useState(Date.now());
  useEffect(()=>{if(!prompt.expiresAt)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[prompt.expiresAt]);
  return <Modal title={prompt.title} onClose={()=>onAnswer(undefined,true)}>
    <p>已安装插件的请求</p>
    {prompt.expiresAt&&<p>将在 {Math.max(0,Math.ceil((prompt.expiresAt-now)/1000))} 秒后关闭</p>}
    {prompt.kind==="confirm"?<><p>{prompt.message}</p><button onClick={()=>onAnswer(true)}>确认</button><button onClick={()=>onAnswer(false)}>取消</button></>:<form onSubmit={e=>{e.preventDefault();onAnswer(value);}}>
      {prompt.kind==="select"?<label>选择<select aria-label="插件选项" value={value} onChange={e=>setValue(e.target.value)}><option value="" disabled>请选择</option>{prompt.options.map((option,i)=><option key={i} value={option}>{option}</option>)}</select></label>:<label>输入<input aria-label="插件输入" value={value} placeholder={prompt.placeholder} onChange={e=>setValue(e.target.value)}/></label>}
      <button type="submit" disabled={prompt.kind==="select"&&!value}>继续</button><button type="button" onClick={()=>onAnswer(undefined,true)}>取消</button>
    </form>}
  </Modal>;
}
export function App() {
  const [api] = useState(() => createApi(consumeToken())),
    [boot, setBoot] = useState(emptyBoot),
    [ready, setReady] = useState(false),
    [session, setSession] = useState(null),
    [task, setTask] = useState(null),
    [draft, setDraft] = useState(""),
    [search, setSearch] = useState(""),
    [error, setError] = useState(""),
    [toast, setToast] = useState(""),
    [connection, setConnection] = useState("connecting");
  const [pluginOpen,setPluginOpen]=useState(false),[pluginCommands,setPluginCommands]=useState([]);
  const [settings, setSettings] = useState(false),
    [settingsTab, setSettingsTab] = useState(null),
    [updateHidden,setUpdateHidden] = useState(false),
    [projectDialog, setProjectDialog] = useState(false),
    [rename, setRename] = useState(false),
    [title, setTitle] = useState(""),
    [navOpen, setNavOpen] = useState(false),
    [navHidden, setNavHidden] = useState(false),
    [detailOpen, setDetailOpen] = useState(false),
    [detailExpanded, setDetailExpanded] = useState(false),
    [detailTab, setDetailTab] = useState("collaboration"),
    [pending, setPending] = useState(pendingFromStorage),
    [submitting, setSubmitting] = useState(false),
    [pendingStatus, setPendingStatus] = useState(""),
    [notesHidden, setNotesHidden] = useState(false),
    [theme, setTheme] = useState(
      () =>
        localStorage.getItem("cothink.theme") ||
        (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
    );
  const selected = useRef(null),
    selectedTask = useRef(null),
    book = useRef(createDraftBook()),
    draftTimers = useRef(new Map()),
    draftQueue = useRef(Promise.resolve()),
    submissionBusy = useRef(false),
    refreshing = useRef(false),
    refreshAgain = useRef(false),
    mounted = useRef(true),
    detail = useRef(null),
    detailTrigger = useRef(null);
  const showNotes = !!boot.releaseNotes?.unread && !notesHidden;
  function restoreDetailFocus() {
    const candidates = [
      detailTrigger.current,
      document.querySelector(".detail-toggle"),
      document.querySelector(".nav-toggle"),
    ];
    candidates
      .find((node) => node?.isConnected && node.getClientRects().length)
      ?.focus();
  }
  useEffect(() => {
    if (!navOpen) return;
    const node = document.querySelector(".sidebar");
    node.querySelector("button")?.focus();
    const key = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setNavOpen(false);
        document.querySelector(".nav-toggle")?.focus();
      }
      if (e.key === "Tab") {
        const items = [
          ...node.querySelectorAll("button,a,input,summary"),
        ].filter((item) => !item.disabled && item.getClientRects().length);
        const first = items[0],
          last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    node.addEventListener("keydown", key);
    return () => node.removeEventListener("keydown", key);
  }, [navOpen]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("cothink.theme", theme);
  }, [theme]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 3000);
    return () => clearTimeout(t);
  }, [toast]);
  function storePending(value) {
    setPending(value);
    if (value) sessionStorage.setItem("cothink.pending", JSON.stringify(value));
    else sessionStorage.removeItem("cothink.pending");
  }
  function saveDraft(snapshot) {
    if (!snapshot?.sessionId) return Promise.resolve();
    const operation = draftQueue.current
      .catch(() => {})
      .then(() =>
        api.action("session.draft", {
          sessionId: snapshot.sessionId,
          text: snapshot.text,
        }),
      );
    draftQueue.current = operation;
    operation.catch((e) => {
      if (mounted.current)
        setError("草稿未保存到宿主：" + e.message + " 当前页面仍保留输入。");
    });
    return operation;
  }
  function editDraft(text) {
    const id = selected.current;
    if (!id) return;
    book.current.edit(id, text);
    setDraft(text);
    clearTimeout(draftTimers.current.get(id));
    const snapshot = book.current.snapshot(id);
    draftTimers.current.set(
      id,
      setTimeout(() => {
        draftTimers.current.delete(id);
        saveDraft(snapshot);
      }, 650),
    );
  }
  async function selectTask(id, open = false) {
    selectedTask.current = id;
    setTask(null);
    if (!id) return;
    try {
      const value = await api.read("task", { id });
      if (selectedTask.current === id) setTask(value);
      if (open) {
        setDetailOpen(true);
        setDetailExpanded(true);
        setDetailTab("collaboration");
      }
    } catch (e) {
      setError(e.message);
    }
  }
  async function openSession(id, taskId) {
    selected.current = id;
    sessionStorage.setItem("cothink.session", id);
    selectedTask.current = null;
    setSession(null);
    setTask(null);
    setNavOpen(false);
    setDetailOpen(false);
    setDetailExpanded(false);
    setError("");
    const next = await api.read("session", { id });
    if (selected.current !== id) return;
    setSession(next);
    setDraft(book.current.load(id, next.draft));
    await selectTask(taskId || next.turns.at(-1)?.taskId || null);
  }
  const refresh = useCallback(async () => {
    if (refreshing.current) {
      refreshAgain.current = true;
      return;
    }
    refreshing.current = true;
    try {
      const b = await api.read("bootstrap");
      if (!mounted.current) return;
      setBoot(b);
      const id = selected.current,
        taskId = selectedTask.current;
      await Promise.all([
        id &&
          api.read("session", { id }).then((value) => {
            if (mounted.current && selected.current === id) setSession(value);
          }),
        taskId &&
          api.read("task", { id: taskId }).then((value) => {
            if (mounted.current && selectedTask.current === taskId)
              setTask(value);
          }),
      ]);
    } catch (e) {
      if (mounted.current) setError(e.message);
    } finally {
      refreshing.current = false;
      if (refreshAgain.current && mounted.current) {
        refreshAgain.current = false;
        setTimeout(refresh, 160);
      }
    }
  }, [api]);
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    (async () => {
      try {
        const b = await api.read("bootstrap");
        if (cancelled) return;
        setBoot(b);
        const previous = sessionStorage.getItem("cothink.session"),
          p = pendingFromStorage();
        const id =
          b.sessions.find((s) => s.id === (p?.sessionId || previous))?.id ||
          b.sessions[0]?.id;
        if (id) await openSession(id);
        else {
          const created = await api.action("session.create", { project: null });
          if (!cancelled) {
            selected.current = created.id;
            sessionStorage.setItem("cothink.session", created.id);
            setSession(created);
            setDraft(book.current.load(created.id, created.draft));
          }
        }
        if (!b.configured) setSettings(true);
        if (p) {
          const found = await api.recover(p);
          if (found) {
            storePending(null);
            setPendingStatus("已通过保存记录确认上次提交。");
            if (selected.current === p.sessionId)
              await selectTask(found.taskId);
          } else
            setPendingStatus(
              "尚未找到这次提交的已保存记录，结果未知。不会自动重发。",
            );
        }
        if (!cancelled) setReady(true);
      } catch (e) {
        if (!cancelled) {
          setError(e.message);
          setReady(true);
        }
      }
    })();
    const stop = api.subscribe(
      () => {
        if (!cancelled) refresh();
      },
      (s) => {
        if (!cancelled) setConnection(s);
      },
    );
    const checkOnFocus=()=>{ if(!cancelled) api.action("updates.check",{manual:false}).then(()=>{if(!cancelled) refresh();}).catch(()=>{}); };
    window.addEventListener("focus",checkOnFocus);
    const timer = setInterval(refresh, 3000);
    return () => {
      cancelled = true;
      mounted.current = false;
      stop();
      clearInterval(timer);
      window.removeEventListener("focus",checkOnFocus);
      for (const t of draftTimers.current.values()) clearTimeout(t);
    };
  }, [api, refresh]);
  useEffect(() => {
    if (!detailOpen || !detailExpanded) return;
    const node = detail.current;
    if (!node) return;
    const close = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setDetailOpen(false);
        setDetailExpanded(false);
        requestAnimationFrame(restoreDetailFocus);
      }
      if (e.key === "Tab" && matchMedia("(max-width: 1199px)").matches) {
        const elements = [
          ...node.querySelectorAll('button,a[href],summary,[tabindex="0"]'),
        ].filter((n) => !n.disabled && n.getClientRects().length);
        const first = elements[0],
          last = elements.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    node.addEventListener("keydown", close);
    node.querySelector("button")?.focus();
    return () => node.removeEventListener("keydown", close);
  }, [detailOpen, detailExpanded]);
  async function createSession(project = null) {
    const value = await api.action("session.create", { project });
    await openSession(value.id);
    await refresh();
  }
  async function change(name, args) {
    if (!session) return;
    const id = session.id;
    try {
      const value = await api.action(name, { sessionId: id, ...args });
      if (selected.current === id) setSession(value);
      await refresh();
    } catch (e) {
      setError(e.message);
    }
  }
  async function submit(workRequest) {
    if (
      !session ||
      boot.active ||
      submissionBusy.current ||
      pending ||
      !draft.trim()
    )
      return;
    if(workRequest && !session.project) { setError("制作HTML/SVG需要先选择项目；草稿已保留。"); return; }
    submissionBusy.current = true;
    const snapshot = book.current.snapshot(session.id),
      input = snapshot.text;
    setSubmitting(true);
    setError("");
    clearTimeout(draftTimers.current.get(session.id));
    draftTimers.current.delete(session.id);
    let submitted = false;
    try {
      await saveDraft(snapshot);
      const slash=/^\/([^\s]+)/.exec(input)?.[1];
      if(slash&&!slash.startsWith("skill:")) {
        const commands=await api.action("extension.commands",{sessionId:session.id});
        if(commands.some(command=>command.name===slash)) {
          await api.action("extension.command",{sessionId:session.id,input});
          book.current.accepted(snapshot);setDraft(book.current.snapshot(session.id).text);await refresh();return;
        }
      }
      const association = {
        sessionId: session.id,
        submissionId: crypto.randomUUID(),
      };
      storePending(association);
      setPendingStatus("正在确认本次提交…");
      submitted = true;
      const result = await api.action("task.submit", { ...association, input, ...(workRequest ? {workRequest} : {}) });
      storePending(null);
      setPendingStatus("");
      book.current.accepted(snapshot);
      const now = book.current.snapshot(session.id);
      if (selected.current === session.id) {
        setDraft(now.text);
        await selectTask(result.taskId);
      }
      await saveDraft(now);
      await refresh();
    } catch (e) {
      if (submitted && !e.unknown) {
        storePending(null);
        setPendingStatus("");
      }
      setError(e.message);
      if (submitted && e.unknown)
        setPendingStatus(
          "提交确认丢失，先读取同一 submissionId 的记录。不会自动重发。",
        );
    } finally {
      submissionBusy.current = false;
      setSubmitting(false);
    }
  }
  async function recoverPending() {
    if (!pending) return;
    try {
      const found = await api.recover(pending);
      if (found) {
        const id = pending.sessionId;
        storePending(null);
        setPendingStatus("已确认上次提交。草稿仍保留，请自行整理。");
        if (selected.current !== id) await openSession(id, found.taskId);
        else await selectTask(found.taskId);
        await refresh();
      } else
        setPendingStatus(
          "尚未找到该提交的已保存记录，结果未知。保留草稿，不自动重发。",
        );
    } catch (e) {
      setError(e.message);
    }
  }
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      setToast("已复制原文");
    } catch {
      setError("未能访问系统剪贴板，请手动选中文字复制。");
    }
  }
  async function cancelTask() {
    if (!boot.active) return;
    try {
      await api.action("task.cancel", { taskId: boot.active.taskId });
      await refresh();
    } catch (e) {
      setError(e.message);
    }
  }
  async function bindSavedTeam(team) {
    if (session && !session.team && !session.turns.length) {
      const value = await api.action("session.team", {
        sessionId: session.id,
        teamId: team.id,
      });
      if (selected.current === session.id) setSession(value);
    }
  }
  function expandDetails(tab = "collaboration", event) {
    detailTrigger.current = event?.currentTarget || document.activeElement;
    setDetailTab(tab);
    setDetailOpen(true);
    setDetailExpanded(true);
  }
  function closeDetails() {
    setDetailOpen(false);
    setDetailExpanded(false);
    requestAnimationFrame(restoreDetailFocus);
  }
  const projects = [
      ...new Set(boot.sessions.map((s) => s.project).filter(Boolean)),
    ],
    filtered = boot.sessions.filter((s) =>
      s.title.toLowerCase().includes(search.toLowerCase()),
    );
  return (
    <div
      className={`app-shell ${navHidden ? "nav-hidden" : ""} ${detailExpanded ? "detail-expanded" : ""} ${detailOpen ? "detail-open" : ""}`}
    >
      {navOpen && (
        <button
          type="button"
          className="nav-scrim"
          aria-label="关闭导航"
          onClick={() => setNavOpen(false)}
        />
      )}
      <nav
        className={`sidebar ${navOpen ? "mobile-open" : ""}`}
        aria-label="对话导航"
      >
        <a
          className="wordmark"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setNavOpen(false);
          }}
        >
          CoThink<span className="wordmark-symbol">◌</span>
        </a>
        <p className="wordmark-caption">让思考，多一个视角。</p>
        <button
          className="new-chat"
          onClick={() => createSession().catch((e) => setError(e.message))}
        >
          <span>＋</span> 新对话 <kbd>↗</kbd>
        </button>
        <button
          className="project-action"
          onClick={() => setProjectDialog(true)}
        >
          <span aria-hidden="true">▱</span> 打开项目
        </button>
        <label className="search">
          <span aria-hidden="true">⌕</span>
          <input
            aria-label="搜索对话标题"
            placeholder="搜索对话"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <div className="history-scroll">
          <div className="nav-section-label">
            最近对话 <span>{filtered.length}</span>
          </div>
          {filtered.length ? (
            filtered
              .filter((s) => !s.project)
              .map((s) => (
                <button
                  title={s.title}
                  key={s.id}
                  className={`history-item ${session?.id === s.id ? "selected" : ""}`}
                  onClick={() =>
                    openSession(s.id).catch((e) => setError(e.message))
                  }
                >
                  <span>{s.title}</span>
                  {s.readOnly && <small>只读</small>}
                </button>
              ))
          ) : (
            <p className="nav-empty">
              {search ? "没有匹配的标题" : "从一个问题开始"}
            </p>
          )}
          {projects.length > 0 && (
            <div className="nav-section-label projects-label">
              项目 <span>{projects.length}</span>
            </div>
          )}
          {projects.map((path) => (
            <details className="project-group" key={path} open>
              <summary title={path}>
                {path.split(/[\\/]/).filter(Boolean).at(-1)}
              </summary>
              {filtered
                .filter((s) => s.project === path)
                .map((s) => (
                  <button
                    title={s.title}
                    key={s.id}
                    className={`history-item ${session?.id === s.id ? "selected" : ""}`}
                    onClick={() =>
                      openSession(s.id).catch((e) => setError(e.message))
                    }
                  >
                    {s.title}
                  </button>
                ))}
            </details>
          ))}
        </div>
        <div className="sidebar-bottom">
          <button onClick={() => setSettings(true)}>
            ⚙ <span>设置</span>
          </button>
          <button
            aria-label={theme === "light" ? "切换深色" : "切换浅色"}
            title={theme === "light" ? "切换深色" : "切换浅色"}
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          >
            {theme === "light" ? "◐" : "☀"}
          </button>
        </div>
        <div className="local-status">
          <span
            className={`status-dot ${connection === "connected" ? "live" : ""}`}
          />
          {connection === "connected"
            ? "本机已连接"
            : connection === "connecting"
              ? "正在连接本机"
              : "连接中断 · 正在重连"}
        </div>
      </nav>
      <main className="main-workspace">
        <header className="topbar">
          <button
            className="icon-button nav-toggle"
            aria-label="切换导航"
            onClick={() => {
              if (matchMedia("(max-width: 1099px)").matches)
                setNavOpen(!navOpen);
              else setNavHidden(!navHidden);
            }}
          >
            ☰
          </button>
          <div className="conversation-heading">
            <h1>{session?.title || (ready ? "CoThink" : "正在打开…")}</h1>
            <span>
              {session?.project ? session.project : "普通问答 · 无关联项目"}
            </span>
          </div>
          <button
            className="icon-button"
            disabled={!session}
            aria-label="重命名对话"
            onClick={() => {
              setTitle(session.title);
              setRename(true);
            }}
          >
            ✎
          </button>
          <button
            className="detail-toggle"
            onClick={(e) => expandDetails("collaboration", e)}
          >
            本轮协作 <span aria-hidden="true">↗</span>
          </button>
        </header>
        {boot.updates?.status === "available" && !updateHidden && (
          <div className="update-banner" role="status"><span>{boot.updates.message}{boot.updates.stale ? " · 已知缓存" : ""}</span>
            <button onClick={()=>{setSettingsTab("updates");setSettings(true);}}>查看更新方式</button>
            <button className="icon-button" aria-label="收起可用更新提示" onClick={()=>setUpdateHidden(true)}>×</button></div>
        )}
        {boot.active && (
          <div className="active-banner" role="status">
            <span className="status-dot live" />
            <span>
              正在执行 ·{" "}
              {boot.sessions.find((s) => s.id === boot.active.sessionId)
                ?.title || "当前任务"}
              <small>
                {boot.active.sessionId === session?.id &&
                task?.id === boot.active.taskId
                  ? phaseLabel(task.phase)
                  : "可浏览历史，草稿不会排队"}
              </small>
            </span>
            <button
              onClick={() =>
                openSession(boot.active.sessionId, boot.active.taskId).catch(
                  (e) => setError(e.message),
                )
              }
            >
              返回任务
            </button>
            <button className="stop-button" onClick={cancelTask}>
              停止
            </button>
          </div>
        )}
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button
              onClick={() => {
                setError("");
                refresh();
              }}
            >
              重新读取
            </button>
            <button
              className="icon-button"
              aria-label="收起错误提示"
              onClick={() => setError("")}
            >
              ×
            </button>
          </div>
        )}
        {boot.historyErrors?.length > 0 && (
          <details className="history-errors">
            <summary>存在损坏记录，原文件保留；未知提交不会重发</summary>
            <pre>{JSON.stringify(boot.historyErrors, null, 2)}</pre>
          </details>
        )}
        {(pending || pendingStatus) && (
          <div className="pending-banner" role="status">
            <span>{pendingStatus || "存在待确认的提交。"}</span>
            {pending && <button onClick={recoverPending}>读取提交记录</button>}
            {pending && !boot.active && (
              <button
                onClick={() => {
                  storePending(null);
                  setPendingStatus(
                    "已放弃关联。原提交结果仍未知，新任务仅由你再次明确发送。",
                  );
                }}
              >
                保留草稿并放弃关联
              </button>
            )}
          </div>
        )}
        <div className="conversation-scroll">
          <div className="conversation-content">
            {!session?.turns.length ? (
              <section className="empty-state">
                <span className="eyebrow">A LITTLE MORE PERSPECTIVE</span>
                <h2>
                  一起把问题
                  <br />
                  <em>想清楚。</em>
                </h2>
                <p>
                  一个主答，一个独立的视角。
                  <br />
                  你看见完整交付，也能沿着理由回看讨论。
                </p>
                {!boot.configured && ready && (
                  <button onClick={() => setSettings(true)}>
                    配置模型，开始第一次讨论 <span>→</span>
                  </button>
                )}
                {session?.project && (
                  <div className="project-empty">
                    <strong>已关联项目</strong>
                    <code>{session.project}</code>
                    <p>
                      描述要修改或检查的内容。执行沿用独立成果目录，原项目不会自动覆盖。
                    </p>
                  </div>
                )}
              </section>
            ) : (
              session.turns.map((turn, index) => (
                <section
                  className={`turn ${task?.id === turn.taskId ? "selected-turn" : ""}`}
                  key={turn.taskId}
                >
                  <div className="turn-input">
                    <span className="eyebrow">
                      YOU <span>/{String(index + 1).padStart(2, "0")}</span>
                    </span>
                    <div className="user-text">{turn.input}</div>
                  </div>
                  <article className="answer">
                    <header className="answer-heading">
                      <span className="answer-symbol" aria-hidden="true">
                        ◌
                      </span>
                      <strong>CoThink</strong>
                      <span className="turn-mode">
                        {turn.mode === "one" ? "ONE" : "讨论"}
                      </span>
                      <span className="turn-status">
                        {statusLabel(turn.status)}
                      </span>
                    </header>
                    {turn.finalText ? (
                      <div className="prose">
                        <Markdown text={turn.finalText} />
                      </div>
                    ) : (
                      <div className="incomplete-answer">
                        <p>
                          {turn.status === "running"
                            ? `${phaseLabel(task?.id === turn.taskId ? task.phase : null)}，完整交付将在结束后显示。`
                            : "这轮没有完整最终稿；已保存的原文和部分成果可在详情查看。"}
                        </p>
                        {task?.id === turn.taskId && task.error && (
                          <p className="error-text">{task.error}</p>
                        )}
                      </div>
                    )}
                    <footer className="answer-actions">
                      <button
                        onClick={async (e) => {
                          detailTrigger.current = e.currentTarget;
                          await selectTask(turn.taskId, true);
                        }}
                      >
                        {task?.id === turn.taskId && task.work
                          ? "查看协作"
                          : "查看讨论"}{" "}
                        <span aria-hidden="true">↗</span>
                      </button>
                      {turn.finalText && (
                        <button onClick={() => copy(turn.finalText)}>
                          复制原文
                        </button>
                      )}
                      {task?.id === turn.taskId && task.work && (
                        <button onClick={(e) => expandDetails("changes", e)}>
                          变更与检查
                        </button>
                      )}
                    </footer>
                  </article>
                </section>
              ))
            )}
          </div>
        </div>
        <div className="composer-area">
          {session?.project && (
            <div className="project-context">
              <span aria-hidden="true">▱</span>
              <span>
                {session.project.split(/[\\/]/).filter(Boolean).at(-1)} ·
                基于内核授予的正式版本 · 原项目未写回
              </span>
              <button
                onClick={async (e) => {
                  detailTrigger.current = e.currentTarget;
                  if (task?.work) expandDetails("changes", e);
                  else setProjectDialog(true);
                }}
              >
                查看
              </button>
            </div>
          )}
          <Composer
            session={session}
            boot={boot}
            draft={draft}
            onDraft={editDraft}
            onSubmit={submit}
            onChange={change}
            busy={!!boot.active}
            submitting={submitting}
            pending={!!pending}
            onSettings={() => setSettings(true)}
          />
          <Budget team={session?.team} />
          {session&&<button disabled={!!boot.active||!!boot.extensionUI?.command} onClick={async()=>{setPluginOpen(true);setError("");try{setPluginCommands(await api.action("extension.commands",{sessionId:session.id}));}catch(e){setError(e.message);setPluginOpen(false);}}}>插件命令</button>}
          {(boot.extensionUI?.statuses??[]).filter(item=>item.sessionId===session?.id).map(item=><p role="status" key={item.key}>{item.text}</p>)}
          {(boot.extensionUI?.notifications??[]).filter(item=>item.sessionId===session?.id).slice(-4).map(item=><p role={item.type==="error"?"alert":"status"} key={item.id}>{item.message}</p>)}
          {boot.releaseNotes?.unread && (
            <button
              className="unread-notes"
              onClick={() => setNotesHidden(false)}
            >
              查看本次更新
            </button>
          )}
        </div>
      </main>
      {detailOpen && detailExpanded && (
        <button
          className="detail-scrim"
          aria-label="关闭任务详情"
          onClick={closeDetails}
        />
      )}
      <div
        className={`detail-wrapper ${detailOpen ? "is-open" : ""}`}
        ref={detail}
        role={detailOpen && detailExpanded ? "dialog" : undefined}
        aria-modal={
          detailOpen &&
          detailExpanded &&
          matchMedia("(max-width: 1199px)").matches
            ? true
            : undefined
        }
        aria-label="本轮任务详情"
      >
        <Collaboration
          task={task}
          expanded={detailExpanded}
          tab={detailTab}
          setTab={setDetailTab}
          onExpand={() => {
            detailTrigger.current = document.activeElement;
            setDetailOpen(true);
            setDetailExpanded(true);
          }}
          onClose={closeDetails}
          api={api}
          onError={setError}
        />
      </div>
      {boot.extensionUI?.prompts?.[0]&&<ExtensionPrompt key={boot.extensionUI.prompts[0].id} prompt={boot.extensionUI.prompts[0]} onAnswer={async(value,cancelled=false)=>{const p=boot.extensionUI.prompts[0];try{await api.action("extension.respond",{sessionId:p.sessionId,promptId:p.id,value,cancelled});await refresh();}catch(e){setError(e.message);}}}/>}
      {pluginOpen&&!boot.extensionUI?.prompts?.length&&<Modal title="插件命令" onClose={()=>setPluginOpen(false)}>
        <p>本地命令不创建模型任务；需要模型工作或原生终端组件的路径会明确报错。</p>
        {!pluginCommands.length&&<p>没有已注册的插件命令。</p>}
        {pluginCommands.map(command=><p key={command.name}><button onClick={async()=>{setPluginOpen(false);setError("");try{await api.action("extension.command",{sessionId:session.id,input:"/"+command.name});await refresh();}catch(e){setError(e.message);}}}>/{command.name}</button> {command.description}</p>)}
        <button onClick={async()=>{setError("");try{await api.action("extension.reload",{sessionId:session.id});setPluginCommands(await api.action("extension.commands",{sessionId:session.id}));await refresh();}catch(e){setError(e.message);}}}>重载插件</button>
      </Modal>}
      {settings && !showNotes && (
        <Settings
          boot={boot}
          initialTab={settingsTab}
          session={session}
          api={api}
          onRefresh={refresh}
          onTeamSaved={bindSavedTeam}
          onClose={() => setSettings(false)}
        />
      )}
      {projectDialog && (
        <ProjectDialog
          api={api}
          projects={projects}
          suggestedProject={boot.suggestedProject}
          onOpen={createSession}
          active={boot.active}
          onClose={() => setProjectDialog(false)}
        />
      )}
      {rename && (
        <Modal title="重命名对话" onClose={() => setRename(false)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api.action("session.name", {
                  sessionId: session.id,
                  title,
                });
                setRename(false);
                await refresh();
              } catch (e) {
                setError(e.message);
              }
            }}
          >
            <label>
              对话标题
              <input
                required
                maxLength={200}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <div className="form-actions">
              <button className="primary">保存标题</button>
            </div>
          </form>
        </Modal>
      )}
      {showNotes && (
        <Modal title="本次更新" onClose={() => setNotesHidden(true)}>
          <pre className="release-summary">{boot.releaseNotes.summary}</pre>
          {boot.releaseNotes.error && (
            <p className="error-text" role="alert">
              {boot.releaseNotes.error}
            </p>
          )}
          <p className="field-note">
            来自随包 CHANGELOG，仅说明已安装版本。可用新版本另见设置，只有点击下方按钮才记录已读。
          </p>
          <div className="form-actions">
            <button
              className="primary"
              onClick={async () => {
                try {
                  await api.action("releaseNotes.ack", {
                    version: boot.version,
                  });
                  await refresh();
                  setNotesHidden(true);
                } catch (e) {
                  setError(e.message);
                }
              }}
            >
              已读，继续
            </button>
          </div>
        </Modal>
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
