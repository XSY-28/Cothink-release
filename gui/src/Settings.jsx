import React, { useState, useRef, useEffect } from "react";
import { Modal } from "./Modal.jsx";
import { modelName } from "./view.js";

function ModelEditor({ label, value, onChange, models }) {
  const providers = [...new Set(models.map((m) => m.provider))];
  const choices = models.filter((m) => m.provider === value?.provider);
  const model = choices.find((m) => m.modelId === value?.modelId);
  return (
    <fieldset className="model-editor">
      <legend>{label}</legend>
      <div className="form-grid">
        <label>
          服务商
          <select
            value={value?.provider || ""}
            onChange={(e) =>
              onChange({ provider: e.target.value, modelId: "" })
            }
          >
            <option value="" disabled>
              选择服务商
            </option>
            {providers.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <label>
          模型
          <select
            value={value?.modelId || ""}
            onChange={(e) =>
              onChange({ provider: value.provider, modelId: e.target.value })
            }
          >
            <option value="" disabled>
              选择模型
            </option>
            {choices.map((m) => (
              <option value={m.modelId} key={m.modelId}>
                {m.name} · {m.modelId}
              </option>
            ))}
          </select>
        </label>
        <label>
          思考档位
          <select
            value={value?.thinkingLevel || ""}
            disabled={!model?.thinkingLevels?.length}
            onChange={(e) => {
              const ref = { ...value };
              if (e.target.value) ref.thinkingLevel = e.target.value;
              else delete ref.thinkingLevel;
              onChange(ref);
            }}
          >
            <option value="">{model?.reasoning ? "默认 high" : "默认（不启用思考）"}</option>
            {model?.thinkingLevels?.map((level) => (
              <option key={level}>{level}</option>
            ))}
          </select>
        </label>
        <label>
          {model?.api === "anthropic-messages"
            ? "输出额度（协议必填）"
            : "输出额度（可留空）"}
          <input
            type="number"
            min="1"
            value={value?.maxOutputTokens ?? ""}
            required={model?.api === "anthropic-messages"}
            placeholder={
              model?.api === "anthropic-messages"
                ? "请明确设置 tokens"
                : "不设本地上限"
            }
            onChange={(e) => {
              const ref = { ...value };
              if (e.target.value) ref.maxOutputTokens = Number(e.target.value);
              else delete ref.maxOutputTokens;
              onChange(ref);
            }}
          />
        </label>
      </div>
      <p className="field-note">
        {model
          ? `协议 ${model.api} · 目录上下文 ${model.contextWindow ?? "未知"} tokens。目录能力不代表已同意输出额度。`
          : "先选择服务商与模型；认证在服务商之间独立保存。"}
      </p>
    </fieldset>
  );
}
function TeamSettings({ boot, session, act, onTeamSaved }) {
  const preset =
    session?.team || boot.teams.find((t) => t.id === boot.currentTeamId);
  const [name, setName] = useState(""),
    [main, setMain] = useState(preset?.main || {}),
    [secondary, setSecondary] = useState(
      preset?.secondary?.length ? structuredClone(preset.secondary) : [{}],
    );
  return (
    <>
      <p>
        给主模型与有序副模型保存一个名字。阵容调整另存新
        Team，旧组合和历史保留。
      </p>
      {boot.teams.length > 0 && (
        <div className="saved-teams">
          {boot.teams.map((team) => (
            <div className="saved-team" key={team.id}>
              <div>
                <strong>{team.name}</strong>
                <small>
                  {modelName(team.main)}
                  {session?.team?.id === team.id ? " · 当前对话" : ""}
                </small>
              </div>
              <button
                type="button"
                onClick={() => {
                  setMain({ ...team.main });
                  setSecondary(structuredClone(team.secondary));
                  setName("");
                }}
              >
                复制编辑
              </button>
              <button
                type="button"
                className="danger-text"
                disabled={
                  !session ||
                  team.id === session.team?.id ||
                  boot.teams.length === 1
                }
                onClick={() =>
                  act("team.remove", { teamId: team.id, sessionId: session.id })
                }
              >
                删除
              </button>
            </div>
          ))}
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          act("team.save", { name, main, secondary }, async (team) => {
            setName("");
            await onTeamSaved(team);
          });
        }}
      >
        <label>
          新 Team 名称
          <input
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：日常讨论"
          />
        </label>
        <ModelEditor
          label="主模型 · 负责交付"
          value={main}
          onChange={setMain}
          models={boot.models}
        />
        {secondary.map((ref, i) => (
          <div className="reviewer-editor" key={i}>
            <ModelEditor
              label={`副模型 ${i + 1}${i === 0 ? " · 普通问答由此模型评审" : " · 项目工作可参与"}`}
              value={ref}
              onChange={(value) =>
                setSecondary((items) =>
                  items.map((item, j) => (i === j ? value : item)),
                )
              }
              models={boot.models}
            />
            <div className="inline-actions">
              <button
                type="button"
                disabled={i === 0}
                onClick={() =>
                  setSecondary((items) => {
                    const next = [...items];
                    [next[i - 1], next[i]] = [next[i], next[i - 1]];
                    return next;
                  })
                }
              >
                上移
              </button>
              <button
                type="button"
                disabled={secondary.length === 1}
                onClick={() =>
                  setSecondary((items) => items.filter((_, j) => i !== j))
                }
              >
                移除席位
              </button>
            </div>
          </div>
        ))}
        <div className="form-actions">
          <button
            type="button"
            onClick={() => setSecondary([...secondary, {}])}
          >
            ＋ 添加副模型
          </button>
          <button className="primary" type="submit">
            另存为新 Team
          </button>
        </div>
        <p className="field-note">
          普通 CoThink 问答仅调用第一位副模型。保存不发送生成请求；当前 Team
          和最后一个已保存 Team 不能删除。
        </p>
      </form>
    </>
  );
}
function ProviderSettings({ boot, act }) {
  const [custom, setCustom] = useState(false),
    [providerId, setProviderId] = useState(""),
    [key, setKey] = useState("");
  const [config, setConfig] = useState({
    baseUrl: "",
    api: "openai-completions",
    modelId: "",
    name: "",
    contextWindow: "",
    maxTokens: "",
  });
  const set = (k, value) => setConfig({ ...config, [k]: value });
  const provider = boot.providers.find((p) => p.id === providerId);
  return (
    <>
      <p>
        已有认证直接复用。API Key 只发送给本机宿主，页面不读取或保存历史密钥。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const apiKey = key;
          setKey("");
          let args = { providerId, apiKey };
          if (custom) {
            args.custom = {
              baseUrl: config.baseUrl,
              api: config.api,
              modelId: config.modelId,
              ...(config.name ? { name: config.name } : {}),
              ...(config.contextWindow
                ? { contextWindow: Number(config.contextWindow) }
                : {}),
              ...(config.maxTokens
                ? { maxTokens: Number(config.maxTokens) }
                : {}),
            };
          }
          act("provider.save", args);
        }}
      >
        <label className="checkbox">
          <input
            type="checkbox"
            checked={custom}
            onChange={(e) => {
              setCustom(e.target.checked);
              setProviderId("");
              setKey("");
            }}
          />
          添加自定义服务商
        </label>
        <label>
          {custom ? "新的唯一配置 ID" : "服务商"}
          {custom ? (
            <input
              required
              value={providerId}
              onChange={(e) => setProviderId(e.target.value)}
              pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}"
              placeholder="例如：my-provider"
            />
          ) : (
            <select
              required
              value={providerId}
              onChange={(e) => {
                setProviderId(e.target.value);
                setKey("");
              }}
            >
              <option value="">选择服务商</option>
              {boot.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.configured ? " · 已有认证" : ""}
                  {!p.apiKey ? " · CLI 登录" : ""}
                </option>
              ))}
            </select>
          )}
        </label>
        {custom && (
          <>
            <p className="field-note">
              一个新配置提供一个模型。不能覆盖已有配置
              ID；需要多个常规模型时使用服务商目录。
            </p>
            <label>
              API 根地址
              <input
                required
                type="url"
                value={config.baseUrl}
                onChange={(e) => set("baseUrl", e.target.value)}
                placeholder="https://api.example.com/v1"
              />
            </label>
            <div className="form-grid">
              <label>
                协议
                <select
                  value={config.api}
                  onChange={(e) => set("api", e.target.value)}
                >
                  <option value="openai-completions">OpenAI compatible</option>
                  <option value="anthropic-messages">Anthropic messages</option>
                </select>
              </label>
              <label>
                模型 ID
                <input
                  required
                  value={config.modelId}
                  onChange={(e) => set("modelId", e.target.value)}
                  placeholder="服务商给出的实际模型 ID"
                />
              </label>
              <label>
                显示名称（可选）
                <input
                  value={config.name}
                  onChange={(e) => set("name", e.target.value)}
                />
              </label>
              <label>
                上下文能力（可选）
                <input
                  type="number"
                  min="1"
                  value={config.contextWindow}
                  onChange={(e) => set("contextWindow", e.target.value)}
                />
              </label>
              <label>
                最大输出能力（可选）
                <input
                  type="number"
                  min="1"
                  value={config.maxTokens}
                  onChange={(e) => set("maxTokens", e.target.value)}
                />
              </label>
            </div>
          </>
        )}
        {!custom && provider && (
          <p className="field-note">
            {provider.configured
              ? "已配置认证，可直接在 Team 中复用。"
              : "尚未配置认证。"}
            {provider.oauth ? " 此服务商支持 OAuth；已有登录直接复用。" : ""}
          </p>
        )}
        <label>
          新的 API Key
          <input
            required
            type="password"
            autoComplete="new-password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="输入本次要保存的密钥"
            disabled={!custom && !provider?.apiKey}
          />
        </label>
        <div className="form-actions">
          <button className="primary" disabled={!custom && !provider?.apiKey}>
            保存认证
          </button>
        </div>
        <p className="field-note">
          保存代表本地认证已保存，远端权限尚未验证。提交后输入框清空，不自动发送试题。
        </p>
      </form>
      <div className="inset-note">
        <strong>OAuth 与环境认证</strong>
        <p>
          需要新授权时，在终端运行 <code>cothink</code>，使用{" "}
          <code>/login</code> 完成现有 Pi 登录，然后刷新此页。GUI 复用该认证。
        </p>
      </div>
    </>
  );
}
function WorkSettings({ boot, act }) {
  const [validationError, setValidationError] = useState("");
  const existing = boot.work || {},
    execution = existing.execution;
  const [enabled, setEnabled] = useState(!!execution),
    [image, setImage] = useState(execution?.image || ""),
    [memory, setMemory] = useState(
      execution?.limits?.memoryBytes
        ? execution.limits.memoryBytes / 1048576
        : "",
    ),
    [cpus, setCpus] = useState(execution?.limits?.cpus ?? ""),
    [pids, setPids] = useState(execution?.limits?.pids ?? ""),
    [artifacts, setArtifacts] = useState(
      execution?.artifactPaths?.join("\n") || "",
    );
  const [policy, setPolicy] = useState(
    existing.checks === undefined
      ? "auto"
      : existing.checks.length
        ? "custom"
        : "none",
  );
  const [checks, setChecks] = useState(
    existing.checks?.length
      ? existing.checks.map((c) => ({
          command: c.command,
          args: JSON.stringify(c.args || []),
        }))
      : [{ command: "", args: "[]" }],
  );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setValidationError("");
        const work = {};
        if (policy === "none") work.checks = [];
        if (policy === "custom") {
          try {
            work.checks = checks.map((c) => {
              const args = JSON.parse(c.args);
              if (
                !Array.isArray(args) ||
                args.some((value) => typeof value !== "string")
              )
                throw Error("invalid args");
              return { command: c.command, args };
            });
          } catch {
            setValidationError('检查参数需要 JSON 字符串数组，例如 ["test"]。');
            return;
          }
        }
        if (enabled)
          work.execution = {
            engine: "docker",
            image,
            network: "none",
            limits: {
              memoryBytes: Number(memory) * 1048576,
              cpus: Number(cpus),
              pids: Number(pids),
            },
            artifactPaths: artifacts
              .split(/\r?\n/)
              .map((s) => s.trim())
              .filter(Boolean),
          };
        act("settings.work", { work });
      }}
    >
      {validationError && (
        <p className="error-text" role="alert">
          {validationError}
        </p>
      )}
      <p>
        共享全局设置，对后续任务生效。Shell 与非空正式检查使用固定 Docker
        镜像；不会退回宿主执行。
      </p>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        配置 Docker 执行环境
      </label>
      {enabled && (
        <>
          <label>
            固定镜像 digest
            <input
              required
              value={image}
              onChange={(e) => setImage(e.target.value)}
              placeholder="repository@sha256:…"
            />
          </label>
          <div className="form-grid three">
            <label>
              内存上限（MiB）
              <input
                required
                type="number"
                min="16"
                step="1"
                value={memory}
                onChange={(e) => setMemory(e.target.value)}
              />
            </label>
            <label>
              CPU 上限
              <input
                required
                type="number"
                min="0.01"
                step="any"
                value={cpus}
                onChange={(e) => setCpus(e.target.value)}
              />
            </label>
            <label>
              进程数上限
              <input
                required
                type="number"
                min="2"
                value={pids}
                onChange={(e) => setPids(e.target.value)}
              />
            </label>
          </div>
          <p className="field-note">
            网络固定关闭（network: none）。镜像须已在本机 Docker
            可用，不会在这里拉取镜像。
          </p>
          <label>
            辅助产物目录（相对路径，每行一个）
            <textarea
              rows="2"
              value={artifacts}
              onChange={(e) => setArtifacts(e.target.value)}
              placeholder="node_modules"
            />
          </label>
        </>
      )}
      <label>
        正式检查策略
        <select value={policy} onChange={(e) => setPolicy(e.target.value)}>
          <option value="auto">自动解析项目 package.json 的 test</option>
          <option value="none">空检查策略（未验证）</option>
          <option value="custom">指定检查命令</option>
        </select>
      </label>
      {policy === "custom" && (
        <>
          {checks.map((c, i) => (
            <div className="check-editor" key={i}>
              <label>
                容器内命令
                <input
                  required
                  value={c.command}
                  onChange={(e) =>
                    setChecks((rows) =>
                      rows.map((row, j) =>
                        i === j ? { ...row, command: e.target.value } : row,
                      ),
                    )
                  }
                  placeholder="npm"
                />
              </label>
              <label>
                参数（JSON 数组）
                <input
                  required
                  value={c.args}
                  onChange={(e) =>
                    setChecks((rows) =>
                      rows.map((row, j) =>
                        i === j ? { ...row, args: e.target.value } : row,
                      ),
                    )
                  }
                  placeholder={'["test"]'}
                />
              </label>
              <button
                type="button"
                disabled={checks.length === 1}
                onClick={() =>
                  setChecks((rows) => rows.filter((_, j) => j !== i))
                }
              >
                移除
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setChecks([...checks, { command: "", args: "[]" }])}
          >
            ＋ 添加检查
          </button>
        </>
      )}
      <p className="field-note">
        空策略会明确显示“未验证”，不能代表测试通过。命令使用参数数组，不接受宿主绝对路径、秘密环境变量或自定义挂载。
      </p>
      <div className="form-actions">
        <button className="primary">保存工作设置</button>
      </div>
    </form>
  );
}
export function Settings({
  boot,
  session,
  api,
  onRefresh,
  onClose,
  onTeamSaved,
  initialTab,
}) {
  const [tab, setTab] = useState(initialTab || (boot.configured ? "teams" : "providers")),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  async function act(name, args, after) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api.action(name, args);
      await after?.(result);
      await onRefresh();
      setNotice(
        name === "provider.save"
          ? "认证已保存；远端权限尚未验证。"
          : name === "updates.check" ? "检查结束，结果见下方。" : "设置已保存。",
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="设置" onClose={onClose} wide>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分类">
          {[
            ["providers", "服务商与认证"],
            ["teams", "具名 Team"],
            ["work", "项目执行"],
            ["updates", "可用更新"],
            ["notes", "本地更新记录"],
          ].map(([id, label]) => (
            <button
              type="button"
              aria-current={tab === id ? "page" : undefined}
              key={id}
              onClick={() => {
                setTab(id);
                setError("");
                setNotice("");
              }}
            >
              {label}
            </button>
          ))}
          <small>
            CoThink {boot.version}
            <br />
            页面连接本机宿主；查新由宿主访问 npm
          </small>
        </nav>
        <div className="settings-body">
          <h3>
            {
              {
                providers: "服务商与认证",
                teams: "具名 Team",
                work: "项目执行",
                updates: "可用更新",
                notes: "本地更新记录",
              }[tab]
            }
          </h3>
          {!boot.configured && (
            <div className="inset-note onboarding">
              首次使用：先保存认证，再选主副模型并命名
              Team。全部设置均不产生模型调用。
            </div>
          )}
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="success-text" role="status">
              {notice}
            </p>
          )}
          <fieldset
            disabled={busy || !!boot.active}
            className="settings-fields"
          >
            {boot.active && (
              <p className="field-note">
                任务进行中，等待结束或停止后再修改设置。
              </p>
            )}
            {tab === "providers" && <ProviderSettings boot={boot} act={act} />}{" "}
            {tab === "teams" && (
              <TeamSettings
                boot={boot}
                session={session}
                act={act}
                onTeamSaved={onTeamSaved}
              />
            )}{" "}
            {tab === "work" && (
              <WorkSettings
                boot={boot}
                act={(name, args) => {
                  try {
                    return act(name, args);
                  } catch (e) {
                    setError(e.message);
                  }
                }}
              />
            )}
          </fieldset>
          {tab === "updates" && <UpdateSettings state={boot.updates} busy={busy} act={act} />}
          {tab === "notes" && (
            <pre className="changelog">{boot.releaseNotes.full}</pre>
          )}
        </div>
      </div>
    </Modal>
  );
}

function UpdateSettings({state:s, busy, act}) {
  const [installation,setInstallation]=useState("unknown");
  const lastControl=useRef(null);
  const checking=busy || s?.status === "checking";
  useEffect(()=>{
    // Disabling the clicked control can move browser focus to body. Restore it
    // after the request, but never pull focus away from another chosen control.
    const control=lastControl.current;
    if(control?.isConnected && (document.activeElement === document.body || document.activeElement === control.closest('[role="dialog"]'))) {
      if(checking) control.closest('[role="dialog"]')?.focus();
      else control.focus();
    }
  },[checking]);
  if(!s) return <p>尚未读取更新状态。</p>;
  return <section className="update-settings" aria-label="可用更新">
    <p className="update-result" role="status">{s.message}</p>
    <dl className="update-versions"><div><dt>当前版本</dt><dd>{s.currentVersion}</dd></div>
      <div><dt>已知发布版本</dt><dd>{s.latestVersion || "未知"}{s.prerelease && "（预发布版本）"}</dd></div>
      <div><dt>最近成功检查</dt><dd>{s.checkedAt == null ? "尚无" : new Date(s.checkedAt).toLocaleString()}{s.stale && " · 旧缓存，不代表本次在线结论"}</dd></div></dl>
    {s.storageError && <p className="error-text" role="alert">{s.storageError}</p>}
    <label className="checkbox"><input type="checkbox" checked={s.preference} disabled={checking || s.offline || s.environmentDisabled || !!s.storageError}
      onChange={e=>{lastControl.current=e.currentTarget;e.currentTarget.closest('[role="dialog"]')?.focus();act("updates.configure",{automatic:e.target.checked});}}/>自动检查更新</label>
    <p className="field-note">默认在后台访问官方 npm 发布源，每 24 小时尝试一次；不发送密钥或对话，不调用模型。关闭后仍可手动检查。仅提供指引，不执行安装。</p>
    {s.environmentDisabled && <p className="field-note">COTHINK_NO_UPDATE_CHECK=1 已禁止自动检查。</p>}
    <button type="button" className="secondary" disabled={checking || s.offline} onClick={e=>{lastControl.current=e.currentTarget;e.currentTarget.closest('[role="dialog"]')?.focus();act("updates.check",{});}}>{checking ? "正在检查…" : "检查更新"}</button>
    <p className="update-links"><a href={s.releaseUrl} target="_blank" rel="noreferrer">官方说明与下载 ↗</a><a href={s.npmUrl} target="_blank" rel="noreferrer">npm 发布页 ↗</a></p>
    <label>原安装方式<select value={installation} onChange={e=>setInstallation(e.target.value)}>
      <option value="unknown">源码、托管目录或无法判断</option><option value="npm">npm 全局安装</option><option value="zip">Windows ZIP</option></select></label>
    {installation === "npm" ? <><p className="field-note">macOS / Linux 使用 npm；Windows 使用 npm.cmd。自定义 prefix 沿用原 prefix。</p>
      {s.instructions.npm ? <pre className="update-command">{s.instructions.npm}</pre> : <p>暂无已验证的更高目标版本，不建议执行升级命令。</p>}</>
      : <p>{installation === "zip" ? s.instructions.zip : s.instructions.source}</p>}
    <p className="field-note">{s.instructions.note}</p><p className="field-note">当前程序：<code>{s.programPath}</code></p>
    <p className="field-note">npm 推荐版本已可发现，不代表所有平台下载资产均已核实。旧版需先手动安装一次含提醒功能的版本。</p>
  </section>;
}
