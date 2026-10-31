import React, { useEffect, useRef, useState } from "react";
import { Markdown } from "./Markdown.js";
import {
  modelName,
  statusLabel,
  phaseLabel,
  checkLabel,
  revisionExplanation,
  outputReferences,
  elapsedLabel,
} from "./view.js";

function Participant({ p, onSelect }) {
  return (
    <button type="button" className="participant" onClick={onSelect}>
      <span
        className={`participant-mark ${p.status === "running" ? "live" : ""}`}
      >
        {p.role === "main" ? "主" : p.role === "member" ? "工" : "评"}
      </span>
      <span>
        <strong>
          {p.role === "main"
            ? "主答"
            : p.role === "member"
              ? "成员 " + p.id
              : "评审 " + p.role.replace("reviewer-", "")}
        </strong>
        <small>{modelName(p.model)}</small>
      </span>
      <em>{statusLabel(p.status)}</em>
    </button>
  );
}
function VisualFrame({image,taskId,api,entry}) {
  const [src,setSrc]=useState(null),[error,setError]=useState('');
  useEffect(()=>{let active=true,url;setSrc(null);setError('');api.image({id:taskId,ref:image.ref,index:image.index}).then(value=>{url=value;if(active)setSrc(value);else URL.revokeObjectURL(value);}).catch(e=>{if(active)setError(e.message);});return ()=>{active=false;if(url)URL.revokeObjectURL(url);};},[taskId,image.ref,image.index,api]);
  return <figure className="visual-frame">{src?<a href={src} target="_blank" rel="noreferrer"><img src={src} alt={`${entry}，采样 ${Math.round(image.capturedAtMs??0)} 毫秒`}/></a>:<p>{error||'读取截图…'}</p>}<figcaption>{Math.round(image.capturedAtMs??0)} ms · PNG</figcaption></figure>;
}
function VisualEvidence({work,api,taskId}) {
  if (!work.visualEvidence?.length) return null;
  const verdict = {match:'模型判断符合',mismatch:'模型判断不符合',uncertain:'证据不足，判断不确定'};
  return <section className="visual-evidence"><h3>视觉检查</h3>
    <p className="muted">接纳表示版本已保存；图片发送、审查完成和模型判断分别记录。模型判断不等于客观证明。</p>
    {work.visualEvidence.map(e => <details key={e.toolCallId} open={!!e.review || e.result==='failed'}>
      <summary>{e.entry} · {e.result==='failed'?'截图失败':e.checked?'最终版本审查完成':e.review?'审查未完成或版本已过期':e.imageRequestCompleted?'图像请求已完成':e.imageRequestId?'图像已发送，请求未完成':'尚未回传模型'}</summary>
      <p>{e.actor} · {e.viewport?.width} × {e.viewport?.height}</p>
      {e.review && <div className="prose"><strong>{e.checked ? verdict[e.review.verdict] : '未获得当前版本的有效判断'}</strong>
        <Markdown text={[e.review.observation,e.review.reasons,e.review.text].filter(Boolean).join('\n\n')}/>
        {e.review.error && <p role="alert" className="error-text">{e.review.error}</p>}
      </div>}
      <div className="visual-frames">{e.images.map(i=><VisualFrame key={i.index} image={i} taskId={taskId} api={api} entry={e.entry}/>)}</div>
      {e.error&&<p role="alert" className="error-text">{e.error}</p>}
      <details><summary>版本与诊断</summary><pre>{JSON.stringify({sourceVersion:e.sourceVersion,privateVersion:e.privateVersion,integrationVersion:e.integrationVersion,imageRequestId:e.imageRequestId,imageRequestCompleted:e.imageRequestCompleted,review:e.review,diagnostics:e.diagnostics},null,2)}</pre></details>
    </details>)}
  </section>;
}
function MemberConflicts({members}) {
  return members?.filter(m=>m.taskConflict).map(m=><section key={m.id} className="work-detail">
    <h3>成员题意冲突 · {m.taskConflict.unresolved?'尚未解决':'成员已确认更正'}</h3>
    <p>{modelName(m.model)}</p><Markdown text={m.taskConflict.message}/>
    {m.feedback?.map((text,i)=><details key={i}><summary>主模型具体反馈 {i+1}</summary><Markdown text={text}/></details>)}
    {m.taskConflict.resolution&&<Markdown text={m.taskConflict.resolution}/>}
    <small>确认表示冲突处理步骤完成，不证明理解必然正确。</small>
  </section>);
}
function Checks({ work, api, taskId }) {
  const [log, setLog] = useState(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const refs = [
    ...new Set([...(work.outputRefs || []), ...outputReferences(work)]),
  ];
  async function load(ref, offset = 0) {
    setLoading(true);
    setError("");
    try {
      const page = await api.read("output", {
        id: taskId,
        ref,
        offset,
        limit: 65536,
      });
      setLog((prior) => ({
        ...page,
        ref,
        text: offset && prior?.ref === ref ? prior.text + page.text : page.text,
      }));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="work-detail">
      <VisualEvidence work={work} api={api} taskId={taskId}/>
      <h3>检查与执行记录</h3>
      <div
        className={`check-outcome ${work.finalCheck?.status === "passed" && work.finalCheck?.verification === "passed" ? "verified" : ""}`}
      >
        <strong>{checkLabel(work.finalCheck)}</strong>
        <p>检查只证明记录中对应版本的结果。</p>
      </div>
      <dl className="facts">
        <dt>正式版本</dt>
        <dd>{work.version || "未记录"}</dd>
        <dt>检查版本</dt>
        <dd>
          {work.finalCheck?.version ||
            work.finalCheck?.candidateVersion ||
            "以下原始回执为准"}
        </dd>
      </dl>
      {work.finalCheck?.checks?.map((check, i) => (
        <section className="check-card" key={i}>
          <strong>{check.command || check.name || `检查 ${i + 1}`}</strong>
          <pre>{JSON.stringify(check, null, 2)}</pre>
          {check.outputRef && (
            <button disabled={loading} onClick={() => load(check.outputRef)}>
              读取检查日志
            </button>
          )}
        </section>
      ))}
      <details>
        <summary>检查与接纳原始回执</summary>
        <pre>
          {JSON.stringify(
            { finalCheck: work.finalCheck, acceptance: work.acceptance },
            null,
            2,
          )}
        </pre>
      </details>
      <h4>只读日志</h4>
      {refs.length ? (
        refs.map((ref) => (
          <button
            className="log-ref"
            key={ref}
            disabled={loading}
            onClick={() => load(ref)}
          >
            {ref}
          </button>
        ))
      ) : (
        <p className="muted">此任务没有已保存的日志引用。</p>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {log && (
        <section className="log-output">
          <div className="small-label">{log.ref}</div>
          <pre tabIndex={0}>{log.text || "（空日志）"}</pre>
          {!log.eof && (
            <button
              disabled={loading}
              onClick={() => load(log.ref, log.nextOffset)}
            >
              继续读取日志
            </button>
          )}
        </section>
      )}
    </div>
  );
}
function Changes({ task, api, onError }) {
  const [diff, setDiff] = useState(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setDiff(null);
    setError("");
    api
      .read("diff", { id: task.id })
      .then((r) => {
        if (current) setDiff(r);
      })
      .catch((e) => {
        if (current) setError(e.message);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [api, task.id, task.work?.version]);
  async function download() {
    try {
      const text = await api.read("patch", { id: task.id }),
        url = URL.createObjectURL(
          new Blob([text], { type: "text/x-diff;charset=utf-8" }),
        ),
        a = document.createElement("a");
      a.href = url;
      a.download = `cothink-${task.id}.patch`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      onError(e.message);
    }
  }
  return (
    <div className="work-detail">
      <h3>交付版本差异</h3>
      <p>
        固定起点 →
        本次已保存终点。这个版本区间可能包含其他客户端已接纳的成果，各成员贡献请结合执行记录阅读。
      </p>
      <div className="inset-note">
        <strong>未写回原项目</strong>
        <p>
          {task.status !== "completed"
            ? "任务未完整完成，已接纳的部分成果仍保留。"
            : "成果在独立目录中，原分支没有自动覆盖。"}
        </p>
      </div>
      <dl className="facts">
        <dt>项目</dt>
        <dd>{task.work.root}</dd>
        <dt>起点</dt>
        <dd>{diff?.fromVersion || task.work.startVersion || "未记录"}</dd>
        <dt>终点</dt>
        <dd>{diff?.toVersion || task.work.version || "未记录"}</dd>
        <dt>集成引用</dt>
        <dd>{task.work.integrationRef || "未记录"}</dd>
        <dt>成果目录</dt>
        <dd>{task.work.resultWorkspace || "尚未产生最终成果目录"}</dd>
      </dl>
      <div className="form-actions">
        <button disabled={!diff} onClick={download}>
          下载完整补丁
        </button>
        <button
          disabled={!task.work.resultWorkspace}
          onClick={() =>
            api
              .action("task.reveal", { taskId: task.id })
              .catch((e) => onError(e.message))
          }
        >
          打开成果目录
        </button>
      </div>
      {loading && <p role="status">读取固定版本差异…</p>}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {diff && (
        <>
          <div className="diff-files">
            {diff.files?.map((file, i) => (
              <span key={i}>
                {typeof file === "string" ? file : JSON.stringify(file)}
              </span>
            ))}
          </div>
          {diff.binaryFiles?.length > 0 && (
            <p className="field-note">含二进制文件；完整补丁保留二进制内容。</p>
          )}
          <pre className="diff" tabIndex={0}>
            {diff.text
              ? diff.text.split("\n").map((line, i) => (
                  <span
                    key={i}
                    className={
                      line.startsWith("+")
                        ? "add"
                        : line.startsWith("-")
                          ? "remove"
                          : line.startsWith("@@")
                            ? "hunk"
                            : ""
                    }
                  >
                    {line}
                    {"\n"}
                  </span>
                ))
              : "这两个版本之间没有差异。"}
          </pre>
        </>
      )}
    </div>
  );
}
export function Collaboration({
  task,
  expanded,
  tab,
  setTab,
  onExpand,
  onClose,
  api,
  onError,
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (task?.status !== "running") return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [task?.id, task?.status]);
  const [target, setTarget] = useState(null),
    pane = useRef(null);
  const participants = (task?.participants || []).filter(
    (p) => p.participated || p.role === "main" || (task?.work && p.role === "member"),
  );
  // A work member may use a model whose reviewer role was never called. Keep
  // the recorded role/author intact, but do not label that same model unused.
  const modelKey = (model) => model?.provider && model?.modelId
    ? JSON.stringify([model.provider, model.modelId]) : null;
  const usedWorkModels = new Set(task?.work ? [
    ...participants.map((p) => modelKey(p.model)),
    ...(task.messages || []).map((message) => modelKey(message.model)),
  ].filter(Boolean) : []);
  const rest = (task?.participants || []).filter(
    (p) => !participants.includes(p) && !usedWorkModels.has(modelKey(p.model)),
  );
  useEffect(() => {
    if (expanded && target) {
      const message = [...pane.current.querySelectorAll("[data-role]")].find(
        (node) => node.dataset.role === target,
      );
      message?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      setTarget(null);
    }
  }, [expanded, target]);
  const select = (p) => {
    setTab("collaboration");
    onExpand();
    setTarget(p.role === "member" ? "member:" + p.id : p.role);
  };
  return (
    <aside
      className={`collaboration ${expanded ? "expanded" : ""}`}
      aria-label="本轮协作"
      ref={pane}
    >
      <header className="panel-heading">
        <div>
          <span className="eyebrow">THIS TURN</span>
          <h2>本轮协作</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="收起本轮协作"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      {!task ? (
        <div className="collaboration-empty">
          <span className="orbit-mark" aria-hidden="true">
            ◌
          </span>
          <h3>让理由彼此相遇</h3>
          <p>发送后，这里呈现真实参与者与本轮记录。</p>
        </div>
      ) : (
        <>
          <div className="turn-timing">
            {typeof task.usage?.calls === "number"
              ? task.usage.helpers
                ? `Team 已发 ${task.usage.calls} 次；插件助手 ${task.usage.helpers.reportedTurns ?? "未知"} 轮（单独记账）`
                : `已发 ${task.usage.calls} 次调用`
              : "调用次数尚未汇总"}{" "}
            {task.usage?.nativeTools&&`；原生工具 ${task.usage.nativeTools.count} 次（扩展用量独立，未知不计为零）`}
            · {elapsedLabel(task, now)}
          </div>
          {task.workRequest && <details className="field-note"><summary>制作HTML/SVG · 本条冻结技能</summary>{task.answerSkills?.map(s=><p key={s.hash}>{s.name}<br/><code>{s.hash}</code></p>)}</details>}
          <div className="roster">
            <div className="roster-title">
              <strong>{task.team?.name || "当时未记录 Team"}</strong>
              <span>{task.mode === "one" ? "ONE" : "CoThink"}</span>
            </div>
            <p className="field-note">所选任务的冻结阵容</p>
            {participants.map((p) => (
              <Participant p={p} key={p.id} onSelect={() => select(p)} />
            ))}
            {rest.length > 0 && (
              <details>
                <summary>完整阵容 · {rest.length} 位本轮未参与</summary>
                {rest.map((p) => (
                  <div className="inactive-member" key={p.id}>
                    <strong>{modelName(p.model)}</strong>
                    <small>
                      本轮未参与 ·{" "}
                      {p.status === "not_called"
                        ? "尚未调用"
                        : statusLabel(p.status)}
                    </small>
                  </div>
                ))}
              </details>
            )}
          </div>
          {!expanded ? (
            <div className="compact-actions">
              <p>
                <span
                  className={
                    task.status === "running" ? "status-dot live" : "status-dot"
                  }
                />
                {statusLabel(task.status)} · {phaseLabel(task.phase)}
              </p>
              <button
                onClick={() => {
                  setTab("collaboration");
                  onExpand();
                }}
              >
                展开{task.work ? "协作" : "讨论"}{" "}
                <span aria-hidden="true">↗</span>
              </button>
              {task.work && (
                <button
                  onClick={() => {
                    setTab("changes");
                    onExpand();
                  }}
                >
                  查看变更与检查
                </button>
              )}
            </div>
          ) : (
            <>
              <nav className="detail-tabs" aria-label="任务详情">
                <button
                  aria-current={tab === "collaboration" ? "page" : undefined}
                  onClick={() => setTab("collaboration")}
                >
                  {task.work ? "协作" : "讨论"}
                </button>
                {task.work && (
                  <>
                    <button
                      aria-current={tab === "changes" ? "page" : undefined}
                      onClick={() => setTab("changes")}
                    >
                      变更
                    </button>
                    <button
                      aria-current={tab === "checks" ? "page" : undefined}
                      onClick={() => setTab("checks")}
                    >
                      检查
                    </button>
                  </>
                )}
              </nav>
              <div className="detail-scroll">
                {tab === "collaboration" && (
                  <>
                    <p className="detail-caption">
                      以下均为已有调用原文。主答的处理说明不等于评审确认最终稿。
                    </p>
                    <div className="discussion-thread">
                      {task.messages.map((message) => {
                        const explanation =
                          message.phase === "revision"
                            ? revisionExplanation(message.text)
                            : null;
                        return (
                          <article
                            className="message-card"
                            key={message.id}
                            data-role={message.role}
                          >
                            <header>
                              <span className="thread-node" />
                              <div>
                                <strong>{phaseLabel(message.phase)}</strong>
                                <small>{modelName(message.model)}</small>
                              </div>
                              <span className="message-status">
                                {statusLabel(message.status)}
                              </span>
                            </header>
                            {message.phase === "draft" ? (
                              <details>
                                <summary>主答初稿 · 展开原文</summary>
                                <div className="prose">
                                  <Markdown text={message.text} />
                                </div>
                              </details>
                            ) : explanation !== null ? (
                              <>
                                <h4>对评审意见的处理说明</h4>
                                <div className="prose">
                                  <Markdown text={explanation} />
                                </div>
                                <details>
                                  <summary>完整修订原文</summary>
                                  <div className="prose">
                                    <Markdown text={message.text} />
                                  </div>
                                </details>
                              </>
                            ) : (
                              <div className="prose">
                                <Markdown
                                  text={message.text || "尚无已保存的正文。"}
                                />
                              </div>
                            )}
                            <small className="source-ref">
                              调用 {message.id}
                            </small>
                            <details className="raw-message">
                              <summary>查看纯文本原文</summary>
                              <pre tabIndex={0}>
                                {message.text || "（尚无正文）"}
                              </pre>
                            </details>
                          </article>
                        );
                      })}
                    </div>
                    {task.work && <MemberConflicts members={task.work.members}/>}
                    {task.work && (
                      <details className="activities">
                        <summary>
                          执行记录 · {task.work.activities.length} 条
                        </summary>
                        {task.work.activities.map((activity, i) => (
                          <section key={i}>
                            <div className="small-label">
                              {activity.type === "handoff"
                                ? "已保存交接"
                                : "活动记录"}{" "}
                              · {activity.action} ·{" "}
                              {statusLabel(activity.status)}
                            </div>
                            {activity.memberId && (
                              <p>关联成员 {activity.memberId}</p>
                            )}
                            {activity.text && (
                              <div className="prose">
                                <Markdown text={activity.text} />
                              </div>
                            )}
                            <pre>{JSON.stringify(activity, null, 2)}</pre>
                          </section>
                        ))}
                      </details>
                    )}
                    {task.error && <p className="error-text">{task.error}</p>}
                    <details>
                      <summary>用量记录</summary>
                      <p className="field-note">
                        未知保持未知；目录费用估算不等于服务商账单。
                      </p>
                      <pre>
                        {JSON.stringify(task.usage ?? "尚未汇总", null, 2)}
                      </pre>
                    </details>
                  </>
                )}
                {tab === "changes" && task.work && (
                  <Changes task={task} api={api} onError={onError} />
                )}
                {tab === "checks" && task.work && (
                  <Checks
                    key={task.id}
                    work={task.work}
                    taskId={task.id}
                    api={api}
                  />
                )}
              </div>
            </>
          )}
        </>
      )}
    </aside>
  );
}
