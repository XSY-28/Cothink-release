# Pinned native host contract

`pi-subagents@0.84.0` 的 `native-host-admission-v2` 是 CoThink 披露的消费方补丁，不是上游 API。安装候选核对 npm integrity、每个原始文件与变换后 SHA-256；新增公开模块与声明也逐字节核验。公开子路径为 `pi-subagents/host-integration`。原始普通插件行为不绑定宿主时保留。

可信宿主通过 `registerHostIntegration({cwd,parentSessionId,host})` 绑定独立原生副本及真实父会话。它返回关闭 admission 的异步函数；关闭记录保留，排队的旧调用不能退回未管理模式。模型给出的 actor、session、cwd 或远端 lease 元数据本身不授予权限。

`host.admitOperation` 在原生控制器的会话／输出准备之前等待持久化；`host.admitChild` 在每次实际子会话的存储、工具／资源计划和启动合同定型之前等待持久化，返回独立 cwd 与宿主 launchId。实际 SDK／placement 边界先同步消耗不可伪造的 receipt，再等待宿主保存唯一 start claim，之后才构造 SDK 会话；失败启动不允许重放。`started` 另行绑定实际 SDK sessionId，并在请求前核对冻结模型、API 与 endpoint 摘要。子会话的原生调用继续沿真实 sessionId 绑定所属父任务。原生 workflow 的解释与调度仍由插件承担。

`terminal` 报告 `disposed`、`shutdownCompleted`、`timedOut` 和错误；同时收集 Pi 吞掉处理器异常后发送的真实 `session_shutdown` 错误事件。真实扩展清理超时或抛错均保留 partial，不能把 session.dispose 调用等同于所有 writer 停止。命令清理、扩展清理和 SDK dispose 分别尝试。宿主必须将这些事实与所属任务的后代／命令事实结合，才能冻结成果或释放资源。关闭 admission 不独自证明进程停止。

SDK terminal 之后仍有插件的结果、检查与辅助文件处理。原生 `finishHostResult` 在这些已等待的步骤结束后才固定文件结果；未知关闭不能因原生工具 Promise 返回就变成 stopped。子代理结果和原生 controller 文件结果共用既有 inspect/adopt/reject 与公共 edit/prepare/accept，没有第二个内核或模型运行循环。

原生输出在请求准入与实际输出检查／写入前复核：当前源码的绝对、相对及规范路径共用 scope/readOnly 检查，辅助输出仅限实际调用方 session 的 subagent-artifacts 目录；不允许整个任务前缀、助手私有运行目录或兄弟副本。原生工具自己的取消信号传入既有 Docker 执行，停止一个子会话不等于取消整条任务或其他助手。

原生 request 的异步上下文保存注册的输入依据与创建者覆盖层；后续子任务继承原 inputVersion 和真实 overlay digest，不会先读取较新的 C 再把旧 A 字节标成 C。顺序文本输出不是文件接纳。并行子代理各有副本；嵌套结果先由实际创建者审阅并合入其副本，父结果才可交回上层。权限变更、过期导入、未处理后代和未知导入继续阻断。

GUI 通过该固定插件的 headless API 上下文运行原工具／workflow 引擎，不模拟原生 fleet/终端输入。资源目录由显式异步上下文绑定，不并发改 process.env；模型／认证配置在任务开始冻结到私有运行材料。SDK 使用显式每子会话配置，文件工具限于副本与冻结技能资源；bash 与具名资源 runs.host 使用现有断网固定 Docker，搜索工具不自动下载可执行文件。原始插件报告用量另存，缺少实际用量证明或费用依据时为 null，不与 controller 聚合重复相加。

显式同版本 install 支持已知 `foreground-unlimited-v1` 原安装迁移：先逐项核对旧来源记录和旧变换后哈希，再还原成固定上游字节、应用当前变换。修改过的旧文件被拒绝且原安装保留；重复 install 幂等。旧清单固定保存在 `vendor/pi-patches/pi-subagents-0.84.0-foreground-unlimited-v1.base.json`，未知补丁状态不会被当作该旧版本。

当前接通原生前台 subagent、脚本 workflow 的动态顺序／并行／嵌套调用，以及可信具名 workflow 的 runs.host。原生 async:true 通过任务私有认证连接使用同一管理器；不同 cwd 的独立映射、原生 verification/gate 命令、MCP/extension bindings、外部 runner 和未映射的远端路径尚未接完，明确拒绝。已有父任务的非空 Docker 检查和正式接纳保持独立；原生 Git worktree/merge/accept 不进入正式 ref。`machine` 和可选 `hostRemoteLease` 为后续远端接点保留元数据，不授予权限。后台操作先登记不可变输入副本，再登记原生进程／包占用，配置清理与 bootstrap 写入前认证；每个 RPC 保存 requestId、载荷摘要及回执，丢失回执只能查询，重复 start claim 不返回再次启动许可。实际原生进程 close 与 SDK/命令结束分别记录；失联保留 unknown，不用 PID 存活检查冒充停止，也不自动重开生成。

检查：`node --test test/pi-plugin-host.test.js test/integration/pi-subagents-host.mjs test/integration/pi-subagents-native.mjs`。实际 npm 固定插件、localhost 模型和正常 CLI／GUI 工作入口覆盖前台子代理、动态顺序／并行、创建者覆盖层的嵌套原生 workflow、具名 host 命令和非空 Docker 正式接纳。合同场景另验证旧补丁迁移、保存失败、重复构造、抛错／迟到关闭。没有付费模型、Windows 实机、任意第三方 JS 或外部远端主机的验收结论。

后台本地证据还覆盖：真实 detached 提前返回与父任务继续读取、第二个原始 bootstrap 拒绝、延迟嵌套子代理继承 A（父任务已写 C）及旧版本导入拒绝、原生 stop 与迟到输出、宿主被终止而 Docker 仍写入时 unknown／包阻断／show 零重发。IPC 回执查询与保存失败另有确定性检查，不能替代真实服务商丢响应验收。

显式 `action:"resume"` 只接受同一创建者已停止且成果／后代已处理的单子会话，并要求具体新反馈。原生目标解析之后、其文件准备之前，由同一宿主创建当前输入版本的新操作，使用 Pi `SessionManager.forkFrom` 将历史会话分支到私有新会话；旧会话不改写，新 SDK 身份、启动 claim 与结果单独记账。运行中、未知或未审阅结果不能恢复；该接口不自动接管宿主崩溃后的未知进程。

后台补验覆盖 GUI 控制器的真实 async 入口、detached 内原生并行 workflow、实际 SDK 启动期取消零子请求、HTTP 503 单次请求无自动重试，以及显式恢复后原会话字节保持和新结果 Docker 接纳。后台 workflow 命令的局部 AbortSignal 通过 requestId 发送 cancelRpc，实际 Docker 在父任务仍活跃时停止；并发首次 admission 共享一个在途 broker 初始化 Promise。

显式 resume 限已停止且已审阅的单子会话，附加 chain 在 fork／spawn 之前拒绝；workflow 的 runs.run({resume:id,task}) 由原解析器归一后走同一接纳路径。宿主重启后接管未知工作仍明确拒绝，不凭 PID 自动接管。

递归 detached 仍使用原生 spawn/bootstrap：实际父 runner 将其持有的 ChildProcess 启动／close 事实通过已认证连接回传同一宿主，事件只接受本连接已获准的子 runner ID。宿主保存 observerRunnerId，注册回执完成后原生 startup barrier 才放行。子 runner 自己认证、占用包并向同一管理器申请实际模型会话；没有第二个 broker owner。父助手等待子 runner 关闭；活跃、未知或未处理的模型／controller 成果阻止父成果接纳。失去观察进程不会用 PID 或 SDK 结束代替进程 close。

后台每个规范源码路径只有一条 source queue：实际 scoped 文件工具、结果采用和 Docker 命令，以及发送给宿主的 operation/child admission 共同使用，复制回执返回后才释放；模型生成等待不占用它。已知原生 single-output/workflow-output 写入也通过同一 awaited 包装。最终化先排空文件操作并关闭该助手源码，再向宿主请求冻结。连接丢失立即将所属助手／runner 标成 unknown，拒绝后续源码准入；仍在进行的文件操作不会被当作已停止，也不释放未知任务的包占用。真实暂停半次文件写入并并发请求子代理的用例验证了完整快照；真实断开认证 socket 的用例验证了未停止、未冻结、零后代请求和包阻断。

远端传输准备接口：`resolveHostMachinePlacement` 在原生 placement 读取项目 machine 设置之前查询已绑定 owner 的同步 `resolvePlacement`；返回 Herdr machine 与显式绝对 `sshConfig`。连接参数保存在该对象的私有身份映射，复制或自行声明 machine 字段不会获得连接授权。未实现 owner 解析器时仍拒绝远端，不回退项目配置或 Rex。所有原生命令与 socket 转发沿用硬化 SSH 参数并显式使用该配置。`agent.start` 后等待同一 pane/terminal 的 `agent.get` 显示实际 agent、非 launch_pending、interactive_ready，再允许上层提交；这是启动技术等待，不重发模型请求。原生同步 Herdr 路径的私有资源、认证、实际 Pi 关闭及文件归集已接入；取消／失联矩阵与其他路径仍按下列边界区分。


## 未发布远端检查点 R2

显式 `async:false`、`options.machine` 沿真实 SSH → Herdr TUI 0.9.5 → 原生 Pi → 原插件桥运行。宿主仍是唯一 agent-sync owner；远端只操作从公共读取与创建者覆盖层复制出的唯一 source。`prepareHostRemote` 在唯一 start claim 之后准备运行材料；`hostChildStarted` 只由本地原生代理提交一次，远端 ready 是独立事实。提交首条 prompt 前等待原生 interactive_ready、完整托管 runtime 及 owner activation 回执。回执绑定 session、实际模型/API/endpoint/thinking、工具集、资源摘要和运行文件摘要；提前 provider/tool 调用拒绝。

配置在 CoThink 的 `work.remoteMachines` 中按已保存 Herdr selector 登记，工作开始冻结，不读取源码 `.pi` 的连接授权。每项 `provider:"herdr"`，含绝对 `herdrBin`、独立 `herdrEnvironment`（HERDR_CONFIG_PATH、XDG_CONFIG_HOME/DATA_HOME/STATE_HOME/RUNTIME_DIR）、`sshConfig`、独立 `stagingRoot`。SSH 配置复制到私有任务目录；尚不接受 Include 动态配置。`runtime` 显式指定 node、Pi CLI、nodeModules、pluginNodeModules 和 node/Pi 文件 hashes；只接受固定 Pi 的官方 **dist/cli.js**，不退回 bundled CLI。后者内嵌 SDK 的零超时行为与已补丁的外部依赖不同，现场曾在 10ms 内失败且零 HTTP 请求。运行前还核对当前 CoThink 固定 SDK 和 provider 依赖字节。所有运行材料复制到私有 job；显式 `--no-approve --no-extensions -e <staged-plugin> -e <managed-runtime>` 以及私有 `--session-dir` 排除项目配置／扩展和会话目录重定向。

`credentials` 按 provider 指向远端专用 JSON 文件 `{provider,apiKey}`，仅该 provider 写入 job 的私有模型配置；不发送宿主 auth.json 或其他 provider 密钥。端点必须与冻结模型一致；`forwardModelLoopback:true` 可显式通过 SSH 在同一端口转发测试 loopback URL，不改写 baseURL。当前仅验证假密钥、本地确定性服务，不证明真实 provider/OAuth 可用。

需要 bash 时，`execution` 必须在首请求前指定 Docker `context`、`daemonId` 和映射模式。`docker-context` 在选定远端 daemon 上挂载该 job 的 source/resources，使用同一固定 digest、断网、资源限额和无能力命令容器；运行用户来自真实远端 runtime。`fixture-copy-volume` 仅为本机容器模拟远端，另需精确 `fixtureContainerId`，通过隔离 volume 映射源码；不向模型暴露 Docker socket 或用户目录。模型命令仍在 Linux 固定镜像执行，实际 location 保存在执行记录。共享 daemon 夹具不证明外部远端 daemon 行为。可信 volume 初始化可使用 CHOWN，模型命令仍 cap-drop ALL。源码工具持有同一串行屏障直到 Docker 结果按旧摘要回写；冲突／非法输出保留现场，不覆盖较新内容。

实际 Pi 由薄 supervisor 以原 CLI 启动；原 ChildProcess close、PID/starttime、入口、cwd、contractDigest 与扩展 shutdown 分别记录。确认写入者停止后取回完整 manifest，验证路径、链接、摘要、二进制／执行位／删除，再回到创建者 inspect/adopt 和公共 edit/check/accept。当前已验正常 CLI 文件及 Docker 路径，并通过真实流式请求取消、桥接隧道断开后同身份恢复／零重复 prompt，以及同文件 A→C 后拒绝旧远端 B 的校验。GUI 远端、后台远端、外部机器和其他插件不在本轮交付范围；远端明确要求 `async:false`，不适配的 detached 路径在 spawn 前拒绝。额外扩展、MCP、特殊权限／工具预算和任意远端 cwd 映射明确拒绝，不静默丢弃或回退。


R3 收尾修正：关闭 owner 只撤销新准入，不撤销原始 opaque receipt 的停止／查询资格；收尾仍核对原 cwd/model/launch 归属，反向连接保留到实际停止与结果取回之后。完整清理结果在同一尝试内缓存，重复关闭不再次改写源码。启动／激活确认前即保留受管停止回调；启动失败先尝试受管 shutdown 与原进程退出／结果取回，再清理原生 pane 和连接。停止证据不足继续保留 unknown，清理失败不替换原启动错误。生成的 `Frozen skills[].path` 与 `Task resources` 指向远端资源；原题、技能正文和其中的字面引用不做替换。现有正向用例实际读取远端引用、在固定 Docker 运行技能脚本，并在宿主原技能被修改后继续使用已冻结字节。

实际重连记录同一 runId/nativeSessionId/terminalId/cwd，bridge tunnel 进程发生变化，cursor 从 0 推进至 13；两次 provider 请求是原 write 工具调用与其正常续答，只有一次 runtime ready，没有重发原 prompt。身份改变或证据缺口仍由原生 reconcile 的既有检查拒绝；本轮不新增跨主机／全网络中断组合结论。过期成果用例保留 A 的 inputVersion 与远端 B，父版本 C 不被覆盖；失败采用前没有 import request 或正式接纳，之后只明确接纳经过固定检查的 C。
