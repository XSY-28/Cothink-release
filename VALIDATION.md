# 0.8.9-native.1 GitHub 预览版（2026-10-31）

本轮沿用固定 Pi 1.4.0 与 pi-subagents@0.84.0 + native-host-admission-v2。原生 workflow、本地 detached／递归助手及显式 async:false Herdr 远端已接入同一受管副本、创建者审阅、公共 edit/check/accept 路径；以下旧章节是当时检查点，其阻断描述不覆盖本轮新增支持。

远端仅以本机私有容器中的真实 SSH／Herdr0.9.5／Pi 和确定性 localhost provider 验证，不是外部机器或付费服务商验收。部署要求显式隔离 XDG_STATE_HOME、可信 SSH 配置及固定官方 unbundled Pi CLI／已补丁 provider 依赖；bundled CLI 不静默回退。旧 fixture 曾写入默认 host state，已按精确归属备份、核验并清理，不能宣称历来无宿主状态副作用。

独立审查已关闭启动清理 P2：源与实际 bundle 均先保留受管 stop，再进行易失败的启动确认。启动／部分构造异常由真实工厂与 admission 函数加边界 doubles 检查；实际远端取消证据覆盖激活后流式请求，二者不混称。此前源回归、失败与来源哈希保留在 work/native-plugin-routes 各报告；本轮安装候选关键复验和精确产物身份见本地 delivery-report.md。

未验证或不支持：远端 GUI／后台完整组合（async:true 拒绝）、外部机器／远端 Docker daemon、任意其他插件、未知后台任务重启接管、多子 attached-chain resume、付费模型质量／账单、Windows 实机与物理键盘。可信插件不是 OS 沙箱；未知停止／费用仍未知。本轮 GitHub 发行只更新说明并分发既有已验证运行代码，未发布到 npm；不修改 agent-sync 内核。此前本地候选的无全局切换／无发布记录属于历史检查点。

# 以下为历史检查点（保留原始范围与失败）

# 未发布：远端限定收尾 R3（2026-10-31）

真实取消用例只发送一次远端请求：关闭 admission 后仍完成原 Pi child 的 shutdown/close 取证，按 PID/starttime/入口/合同绑定，结果为 cancelled。原失败暴露了提前关闭反向连接的问题，失败日志保留。清理资格与新操作权限已分开；并未重新开放已取消的准入。

实际断开本次拥有的 bridge SSH tunnel 后，原生重连保持同一 run/nativeSession/terminal/cwd，证据 cursor 0→13；两次远端请求为 write 和正常续答，runtime ready 只有一次。另一实际用例在远端响应保持期间通过正常主工具将同文件 A 改为 C；旧 B 被 STALE_PRIVATE 拒绝，拒绝时正式接纳数为 0、未创建 import request，B 保留，随后仅 C 经非空固定 Docker 检查接纳。原 checkout 始终保持 A。

R2 技能路径修正复用现有正向用例：远端使用实际广告路径读取引用，在固定 Docker 执行脚本；修改宿主原技能后仍使用已冻结资源，技能正文与原题保持原文。GUI／后台远端完整组合、外部真实机器和其他插件明确延期，不纳入本轮验收；远端只支持显式 async:false。独立固定差异审查及干净候选关键复验由后续交付检查提供，本段不提前宣称完成。

# 未发布：同步原生远端 R2（2026-10-31）

实际宿主 CLI 在容器外，通过独立 SSH 配置和真实 Herdr0.9.5/protocol22 启动唯一远端 cwd 中的固定 Pi unbundled CLI 与当前补丁插件。本地确定性服务验证两次文件调用及另一轮四次文件/Docker调用：远端 read-after-Shell、二进制、执行位、删除全部经父审阅和非空 Docker 正式检查接纳，原 checkout 保持。模型/API/endpoint/thinking、工具/资源/运行文件摘要及私有 session 路径有真实 ready/activation 回执；supervisor 实际 ChildProcess close 与 starttime 绑定。正式检查仍由宿主的同一公共 agent-sync 执行。

Shell 夹具使用明确记录的共享 daemon 隔离 volume 映射，模型无 socket／用户目录挂载；不冒充外部远端 Docker 验收。保留了空 catalogue（缺 XDG_STATE_HOME）、本地路径规范化、未映射 contact_supervisor、bundled SDK 10ms 零 HTTP 超时以及 Docker cp UID 权限失败。旧 fixture 的默认 state 残留另经精确归属核验清理；不能沿用先前“所有 host state 已隔离”的说法。无全局安装、真实密钥、付费调用或内核修改。本段是 R2 历史检查点；限定取消／重连／冲突补验见上方 R3。GUI／后台远端及外部机器不在本轮范围。

# 未发布：原生后台与递归协作检查点（2026-10-31）

当前源码及实际安装的固定 pi-subagents 插件通过 31/31 原生／宿主／IPC 测试，相关 package/helper/import/GUI controller 回归 60/60。覆盖 CLI 与 GUI 控制器 async、原生递归 detached、并行／嵌套 workflow、创建者逐层审阅及非空 Docker 正式接纳；显式 action resume 和原 workflow 简写使用新尝试并保留旧会话字节，附加 chain 在启动前拒绝。

实际文件写入半途暂停并并发请求子代理，验证共享源码屏障不会复制半写内容；真实认证 socket 断开、宿主被终止且 Docker 仍运行、启动期取消和 503 单次请求分别保留正确未知／停止边界。未知结果不得导入或释放包占用，重新查看任务零模型重发。源文件、实际 bundle、公开类型及安装候选仍逐字节追溯。具体原始失败、命令和过程清理见本地 native-background-report.md B3。远端执行、未知宿主重启接管、付费服务商质量／费用、Windows 实机及浏览器点击没有由这些测试证明；无全局安装、发布或内核改动。

# 未发布：原生前台工作流检查点（2026-10-31）

`native-host-admission-v2` 接通原生前台 subagent 和原脚本 workflow 引擎。源码入口、实际安装的固定 npm 插件与 localhost 模型通过普通 CLI，以及 GUI 控制器 session.create/task.submit 路径，验证动态顺序／并行、嵌套创建者覆盖层及显式回交、具名 runs.host 的真实断网 Docker 执行。五项原生入口场景都使用原有非空 Docker 检查与正式接纳；GUI 证据是控制器真实使用路径，不冒称浏览器点击／物理键盘验收。原目录未自动覆盖。

`node --test test/pi-plugin-host.test.js test/integration/pi-subagents-host.mjs test/integration/pi-subagents-native.mjs` 10/10；相关 package/plugin/import/GUI controller 回归 60/60。冻结后的原生助手租约补充另做 CLI／GUI 短复验，命令、原始失败和证据见本地 native-local-report.md。模型/API/endpoint 在 SDK 启动及实际 provider 请求前核对冻结的调用方配置；运行配置不借助并发环境变量切换。用量与原生聚合分开保留，未知成本仍为 null。前台结果等到 SDK 清理及原插件结果处理都完成才冻结；抛错／超时保留未知及包占用。

原生 async:true 的当前本地验收覆盖真实 detached 提前返回、父任务继续读取、重复原始 runner 认证拒绝、延迟嵌套 A→C 旧版本拒绝、原生 stop／迟到输出以及宿主丢失时 Docker 仍运行的 unknown／包阻断／show 零重发。GUI 控制器 async、detached 内原生并行 workflow、真实 SDK 启动期取消零子请求、503 单次请求无自动重试及带反馈的原生显式 resume 已补验；resume 保留旧会话字节并以新 SDK 身份和输入副本另记尝试。递归 detached 已验两层原生进程、同一 broker/owner 和实际父进程 close 回传，以及整条任务取消；workflow resume 简写走原解析器并保留原会话。IPC 查询与持久化失败另有确定性检查。remote、不同 cwd 映射、附加 chain 的多子恢复、verification/gate 及未适配 MCP bindings 仍拒绝；真实外部服务故障和重新接管未知后台任务未验。没有付费模型验收、全局安装、推送／发布或 agent-sync 内核改动。

前台独立审查另修正绝对输出范围绕过与 native exec 丢失工具取消信号。真实固定插件的只读／限域场景中，运行材料 auth.json、兄弟源码与当前越界源码三个绝对目标均在额外模型请求／写入前拒绝；原字节保持。真实原生子会话的 required extension 在 Docker ready 后调用该子会话 ctx.abort，容器停止，父任务与无关助手继续完成并接纳。CLI／GUI 原有正向路径与嵌套路径按影响范围复验；具体失败、命令与证据见本地 foreground-review-fix-report.md。

# 未发布：原生宿主合同检查点（2026-10-31）

候选变换升级为 `native-host-admission-v2`；公开模块、类型、源文件与实际 bundle 均有固定前后哈希，保留原前台单助手兼容。`node --test test/pi-plugin-host.test.js test/integration/pi-subagents-host.mjs` 4/4 通过：固定 npm 插件公开原生委派在持久化失败时零模型请求，允许后实际创建 Pi SDK 子会话、记录真实 sessionId，真实扩展超过关闭等待后写文件时保留 `shutdownCompleted:false`。该检查使用 localhost 确定性模型，没有付费调用。它只验证插件合同接点，不是正常 CoThink native workflow/background/remote 验收；这些入口仍受保护。合同与剩余边界见 [宿主合同](docs/pi-subagents-host-contract.md)。

独立审查后补验实际已打旧补丁安装的同版本迁移／重复安装，并拒绝且保留被改动的旧文件；真实抛错关闭处理器不再被 Pi 的异常吞掉机制误报干净停止。真实 default factory 并发两次创建同一 receipt 只产生一次 session_start，终结后的第三次创建同样在启动前拒绝。检查仍为上述 4 个用例，实际集成用例扩展覆盖这些场景；原有 CLI 助手与非空 Docker 检查接纳也按影响范围复验。

# 0.8.8-plugins.1 本地未发布候选：Pi 插件来源、动态工具与基础界面（2026-10-31）

最终源码核心检查 316 项中 313 通过、0 失败、3 项既有 Windows 平台跳过；GUI 87/87、内核 48/48、工作入口 37/37。终端 PTY 与 slash 原期限通过；首次 changelog 夹具误计已授权的 CoThink 启动查新，保留失败后用 COTHINK_NO_UPDATE_CHECK=1 隔离该夹具，零联网／零生成通过。文档检查通过。

候选以 npm run pack:npm 重新构建 GUI，并实际安装到项目内全新独立 prefix；验收通过 COTHINK_TEST_PACKAGE_ROOT 与 COTHINK_TEST_CLI 加载安装后的产品和 SDK，而非源码。固定公开 pi-subagents@0.84.0 + foreground-unlimited-v1 的 10/10 实际集成通过，覆盖 CLI／GUI、成员与嵌套、并行冲突、取消与原 requestId 恢复；其中正常 CLI／GUI 还在断网固定 Docker 中检查精确成果内容，finalCheck.verification 为 passed，其他空检查场景仍仅证明 unverified 接纳机制。安装后的动态工具／启动与关闭输出保护、GUI 基础交互和真实 Chromium、local／Git／项目来源共 9/9 通过。首个验证包 15,172 个常规文件与安装内容逐字节相同；文档更新后最终包的运行代码、GUI 静态资源和依赖与该已验证包另做字节一致核验。确切源码版本、产物哈希、prefix 和失败日志保存在本地阶段交付报告，不以版本号代替产物身份。

动态检查点独立审查修正两项结果保护：旧已应用 requestId 重放只观察回执，不重置其他 change／当前副本；awaited session_shutdown 产生的文件在关闭后固定保存，未审阅结果使任务 partial，既有接纳历史不回滚、不自动导入。既有正常 CLI 夹具扩展为普通、next_change 后旧 ID／新 pending copy 重放、关闭钩子输出三场景；与丢回执恢复共 4/4，相关回归 52/52。另修正空包列表的手工模板冲突漏报、旧显式空资源快照缺 project 字段的兼容；原测试 2/2 通过。终端既有脚本改验当前允许原生加载、纯答一请求无原生工作工具、本地命令零新增调用，未绑定生成拒绝后仍能重载继续，原期限完整通过。首轮全量同时运行重复 Docker 入口造成两项 GUI did-not-settle，原失败保留；其他套件结束后原期限隔离复验 2/2，不加时、不跳过 Docker。内核 48/48、工作入口 37/37 已通过；最终顺序全量复验另列。

源码来源检查点 `3110b18` 与修复 `3db6d10` 经独立复审通过。现有包管理套件 21/21；新增项目 delta 测试验证个人安装根有／无冗余项目目录时仍保留技能并禁用指定扩展。项目 Git 槽发布后 SIGKILL 的 v2 事务测试覆盖错误 home 拒绝恢复、外部编辑保留及明确恢复；原 v1 测试单独保留，不将它称为 v2 证明。Git 使用 localhost Git HTTP 固定 ref，未验证公网私有认证。local 卸载保留原文件，伪造／复制项目 .pi 不获得 home 授权，项目提交故障仍可打开本地历史／Team 壳但阻止生成。

普通 CLI 工作入口已实际执行 session_start 注册、tool_call 后续定义替换、无文件工具返回，以及独立启动文件和工具文件的明确审阅、导入与正式接纳。宿主 absolute native cwd 文件路径映射仍走公共文件工具；宿主修改后原生副本重取一致当前输入。该测试使用安装的本地扩展与 localhost 确定性模型，不依赖测试专用 nativePluginTools 开关，工具调用不伪装成模型助手。

基础 GUI 控制器的实际 select/input/confirm/notify、错误会话回复拒绝、关闭取消、原生 custom 明确拒绝、本地命令禁止未绑定生成、入口及相对 helper.js 重载、顶层 await 与 SDK SessionManager 共享身份已通过零模型测试。真实 Chromium 点击覆盖提示、字面脚本文字安全显示、slash 命令、原生组件错误和重载后旧命令消失；400 是该明确拒绝的预期 HTTP 结果，非前端脚本错误。32 项现有插件／控制器回归在最终 vendor 依赖上通过。实际 GUI 正常 ONE 工作通过公开安装的 pi-subagents 助手生成文件、创建者审阅与正式接纳；父会话使用受管后端，未加载原生终端管理器。

Pi `1.4.0-cothink.2` 与 Jiti `2.7.0-cothink.1` 按固定源码构建并在本地依赖中核对安装／tgz loader SHA 一致。最初 tryNative:false 无效；仅 entry evalModule 的探针仍会缓存相对 JavaScript，保留失败，最终改为精确的 uncached async ESM 条件补丁与共享 virtual modules。独立前缀候选与上述本地回归已验证；第三方任意插件、收费模型、Windows／物理终端仍未验证。任意脱离 Promise 的后台 JavaScript／外部模型环路不在通用追踪保证内，已知 pi-subagents 原生 workflow/background/remote 等未适配路由继续阻断。

# 未发布：Pi 插件工作接入第二阶段（2026-10-31）

适配 `pi-subagents@0.84.0 + CoThink foreground-unlimited-v1`，仅消费方改动；agent-sync 内核未变。安装候选核验固定 npm integrity、源文件和实际分拆 bundle 的补丁前后哈希，变换不在 import 时执行。公开前台单助手请求显式 `timeoutMs:0` 在创建 deadline 前归一成无时限；正常 CLI 实际零值请求已执行。省略与正数分支保留上游语义的判断来自精确源码审查，未额外执行三十分钟等待或完整短正数超时验收，不能据此称所有原生路由无限制。

真实安装 + localhost 确定性服务 + 正常 `ask`/`runTurn` 工作入口覆盖主模型助手、正式成员助手、子／孙助手及创建者当前文件输入、实际并行兄弟、过期成果保留与明确反馈、父审阅及原有正式接纳。选定技能的引用和脚本实际读取；主／成员通过现有内核 Docker bash 执行所读代码，嵌套助手使用独立副本与只读 `/resources` 执行实际脚本。取消样例等待 `docker inspect` 证实孙助手容器正在运行后取消，记录容器 exit137、两个插件 runner exit0 与停止时间，无导入或接纳。恶意源码 `.pi` 重试／压缩／扩展设置不能覆盖固定配置，HTTP503 只有一次助手请求，未知用量保持 null。命令为 `node --test test/integration/pi-subagents-work.mjs`；原始失败及修复记录保留在本地忽略证据目录。

消费方行为检查覆盖公共一致快照、独立副本、增删／二进制／执行位、范围与链接拒绝、过期输入、响应丢失按原 requestId 查询、审阅失效与原目录保留。异步原生关闭的行为检查确认清理未结束时包变更仍被占用阻断。现有内核 48 项检查通过，包括真实 Docker；这不等于插件任意 JavaScript 被操作系统沙箱约束。

独立审查后修正四项重要问题：未知导入必须先查询旧 ID，不能通过拒绝结果清除门槛；正式成员／工具取消传播到所属助手后代，保留无关助手；已登记上游 0.84.0 的同版本 install 会实际补齐候选补丁；runner 在 SDK／插件 await 前锁存启动取消。针对性实际插件检查证明旧版本迁移、启动零请求取消、完整 abandon_member 停止及无关助手继续接纳；已有失回执测试扩展了拒绝／not_found 的行为检查。第二轮复审还修正了通用／主模型放弃草稿的队列与未知导入门槛，以及 await inspect 期间创建者取消后的权限复核与有效信号传递。实际公共内核注入该取消窗口后没有导入意图／编辑；正常 runTurn 中放弃未知导入被拒绝，原 ID 查清后才能明确丢弃整份草稿。完整初轮回归数字保留如下，修正后按影响范围复验，不冒称重复了全部 GUI／内核检查。

最终本地回归：`npm test` 309 项中 306 通过、0 失败、3 项既有 Windows 平台跳过；`npm run test:gui` 85/85 通过；`npm run build:gui` 成功，保留既有 >500 kB chunk 提示；文档检查通过。真实插件整组六个场景通过，最后仅对受资源选择／输出额度及真实二进制、删除、执行位断言影响的两个既有场景复验，2/2 通过。`npm test` 已包含 `test:work` 的原工作入口文件，不重复运行同组检查。安装包独立前缀、插件专属 GUI 点击、收费模型与 Windows 实机未计为已通过。

未验证边界：收费模型质量和账单、Windows／实体终端、真实 GUI 点击验收、任意第三方扩展、原生后台／workflow／remote／resume 路由。GUI 本轮仅投影、状态文字、已有接口测试与构建；通用兼容交互后续单独验收。助手用量来自可观察请求及插件报告，目录估价与服务商账单分开；Team 调用小计与插件轮数小计分别标注，缺失费用不产生已知整任务总费用。主／成员没有任意资源挂载，需相对资源文件的脚本使用已适配助手路径。模型权限内的源码结果通过公共 edit 与既有 prepare/review/accept 接纳，不能把安装、SDK 退出或文本完成等同于正式接纳。

# 未发布：Pi 插件兼容第一阶段（2026-10-30）

固定 `pi-subagents@0.84.0`（npm，来源 `nicobailon/pi-subagents`），从真实 `cothink install npm:pi-subagents@0.84.0` 入口安装到临时数据根；Pi 加载注册工具与命令，父模型经插件创建实际前台 SDK 子会话，子会话调用原生 read，结果返回父模型。模型服务为 localhost 确定性 fixture，不是收费模型或质量验证。命令：`node --test test/integration/pi-subagents.mjs`。

独立审查发现并修复 `start_work` 同名工具可绕过原生工具门槛的问题：加载后、过滤与会话创建前检查唯一宿主归属，reload 重查；已安装扩展单独运行及与真实宿主并存时均在模型请求前拒绝，工具执行体不会运行。针对插件、runtime、讨论与恢复的 37 项检查通过，原宿主交接保持可用。

该集成测试显式设置 Pi 数据根、宿主 SDK 根、agent 定义和独立工作目录，并通过 `createRuntime({nativePluginTools:true})` 内部适配器入口启用工具。常规 CLI/GUI 工作尚未使用该入口；普通问答及未适配工作仍不开放原生工具和命令。未完成助手身份/费用整合、独立成果导入、后台与嵌套子代理、重开恢复、Windows 与 GUI 实测，不能把本阶段机制通过称为完整产品兼容。依赖脚本为受信任原生代码，候选回退仅覆盖受管文件，不是宿主副作用回滚。

# 0.8.7-modes.1 发布候选（2026-10-29）

英文模式职责与 Option+M 快捷键。独立候选核心测试 302 通过、0 失败、3 项既有 Windows 专项跳过；GUI 83/84 首轮通过，唯一浏览器失败来自新工作区尚未构建静态资源，构建后该用例复验通过。上一轮快捷键专项 12/12，包括真实 CLI/PTY 和 GUI DOM；独立代码审查无阻断项。安装包另行验证，记录保存在本地 work/release；真实模型质量、Windows 实机与实体键盘尚未验证。

# 0.8.6-fidelity.1 npm 发行候选（2026-10-28）

基于 main 的题意保真实现与本地验收；本次只更新根版本、README、CHANGELOG 与发行记录，运行代码、Pi SDK 与 agent-sync 不变。核心 302 通过（3 项既有 Windows 平台跳过）、视觉 45/45、GUI 82/82 的证据继续适用于相同运行代码。GitHub Actions 因账户付款／spending limit 问题未启动，不能视为远端通过；本次安装包另按实际入口验证。真实模型语义质量与 Windows 实机仍未验证。

---

# 未发布：委派题意与独立视觉审查（2026-10-28）

按已确认的 task-fidelity 计划修改 CoThink 消费方：宿主注入原题，成员先只读独立理解，再接收职责／建议；冲突暂停保留草稿，经同一成员收到具体更正并成功确认后恢复。最终视觉审查使用同一主模型的独立短上下文，唯读原题与当前集成版本图像事实，通过 submit_visual_review 的观察、理由和结论影响交付。工具仅读取三个模型字段，版本、图片哈希及身份不能被模型额外参数覆盖。

最终固定运行源码下的本地验收：`npm test` 305 项中 302 通过、0 失败、3 项既有 Windows 专属检查按平台跳过；`npm run test:visual` 45/45；`npm run test:gui` 82/82；`npm run build:gui` 成功，保留既有 >500 kB chunk 提示。测试使用 localhost 模型 fixture、真实 Pi SDK、实际 agent-sync API 与离线 Docker Chromium。浏览器完成制作、查看当前版本审查、读取 PNG，1280×800／1024×768／800×600 无横向溢出及控制台错误；另有 DOM 用例核对未解决冲突、已完成但不符合的审查不会显示成成功。

覆盖原题反转保真、准备阶段隔离与伪造写入拒绝、空／503 准备不重发、旧委派字段拒绝、半成品冲突暂停与同草稿恢复、实际图像请求失败的 collect 摘要、独立审查不含旧解释、match／mismatch／uncertain／缺结论／503 分支、红→蓝新版本复验、同版本补拍新视口、过期／失败判断的 GUI 展示。请求快照按来源检查英文控制文字和各独立上下文的回复语言规则，中文原题、技能正文及具体反馈保留。首次委派通常至少增加一次模型请求；冲突确认、具体返工按实际调用记账；最终独立检查替换原最终看图调用，ONE 不引入副模型。

保留的失败包括：最初 Docker 未运行；测试用例向未读取的既有文件写入被正确拒绝，夹具改为新建草稿；错误地将实际小数采样时刻用作请求整数时刻，修复为分别记录；模型额外字段可覆盖审查元数据，复现后改为显式字段白名单。首轮并行重型测试中，视觉基准因运行源码变化主动停止，GUI 两项超过既有等待窗口；原日志保留，未改超时、skip 或成功定义，固定源码后串行通过。GUI 等待失败与并发负载的关系是推断。

本地证据位于 `work/task-fidelity/`：progress.md、final-checks.json、完整失败／成功日志、requests/ 实际请求及 gui/ 截图。`packages/agent-sync`、vendor、依赖锁和旧真实实验未修改；本次未提交、推送、发布或替换全局安装。未进行收费模型对照、Windows 实机或新安装包验收。fixture 只能证明上述机制与规则传递，不能证明模型必然识别题意、遵循语言规则或提高语义／审美质量、误报率和成本收益。

---

# 英文角色控制提示词（2026-10-28）

修正成员提示词误用 next_change/接纳流程及只读任务被要求制作的职责冲突，合并同一上下文中的重复控制规则。五个角色提示词及运行时补充控制文字改为英文，用户原题、委派/反馈内容、技能正文与中文固定评审标题保留。工具权限、调度偏好、调用预算、版本与未知结果政策保持原合同。

本地验证：核心 297 项中 294 通过、3 项原有 Windows 专属跳过；视觉 37/37、展示 15/15；定向委派/反馈/权限验证 41/41。最初三个夹具通过中文“具体反馈”判断修订阶段，翻译后误判，已改为匹配实际反馈内容；benchmark 通过工具权限识别角色。失败日志保留在本地 work/prompt-language。测试确认实际上下文与工具权限、PNG回传、修订及交付机制，不能证明英文比中文更有效；未进行付费模型语言对照。

---

# 未发布：HTML/SVG 视觉工作流（2026-10-28）

本轮修改归属为 **CoThink 消费方**：单次制作入口、冻结技能消费、preview_html 公共 API 适配、固定容器 renderer、实际图片请求证据、最终集成版本收尾、GUI 截图读取与展示、新 benchmark 冻结条件。`packages/agent-sync` 和 vendor 没有修改；根依赖锁与施工前字节一致，原有未提交修改保留。无内容变化的 exec 产生新 privateVersion 是当前内核行为，不标成内核缺陷；用户批准改为保存前后版本并通过公共 inspect 的空差异证明内容未变。

验证使用 localhost Pi/provider fixture 与真实 Docker Chromium，不是付费模型质量评估。可检查证据位于本地 `work/visual-workflow/`，不进入安装包。

- 主套件 `npm test`：297 项，294 通过，0 失败，3 项现有 Windows 专属检查在 macOS 跳过。
- GUI 套件：80 项通过。真实浏览器完成无项目草稿保留、关联项目、ONE 制作、重复点击约束、最终 PNG 读取；1280×800、1024×768、800×600 无横向溢出和控制台错误。截图见 `work/visual-workflow/gui/`。
- 视觉验收：真实 PNG、多帧动画差异、桌面/手机视口、click/fill/key、外联 HTTP/WebSocket 零请求、file URL 拒绝、辅助产物隔离、取消、失控页面清理、缺浏览器、超大 PNG 拒绝、有效 PNG 公共分页读取。
- 实际 provider payload 包含 PNG；ONE 红→蓝修订与 CoThink 成员具体反馈都通过；最终集成再截图、再次修订再检查、API 拒图保留已接纳成果且不重试均通过。文字“看过图”不计作图片证据。
- 运行中改变技能源元数据不会进入新的成员上下文。CLI 管道保留多行任务原字节；真实 PTY 的 /make-html 继承 ONE，下一条仍为 ONE 纯答。
- 新 benchmark 的九个合成 fixture 工作并发通过，冻结相同原题、技能与预览能力；旧真实轮次、顺序、选票未运行或重写。新制作轮次对临时服务商错误不自动重试。

保留的失败：最初 Docker 未启动；Debian/浏览器资产下载缓慢或中断；原“privateVersion 不变”假设被真实 exec 与 true 对照否定；新成员重新加载技能描述的问题已修复；测试清理脚本未持续读取 PTY 导致退出等待的问题已修复。曾同时运行三套重型回归，出现 GUI fixture 未及时结束及九任务 fixture 的一次 connection-unknown；原日志保留，未调宽时限或修改成功定义，随后各套独立运行通过。并发负载关联只是推断，未声称已独立定位该次连接失败的根因。

镜像、脚本、浏览器资产及 Debian 实际版本记录见 `docker/visual-preview-manifest.json` 与 `docker/visual-preview-packages.lock`。当前实测 Linux ARM64；Windows Docker / Linux x64、物理 IME 与真实模型题意/审美收益未验证。Vite 仍有既有的大 chunk 提示。未发布、未推送、未替换全局安装；候选打包与隔离安装的实际结果继续写入本地进度记录。

---

# 0.8.5-prompts.1：主副模型提示词与授权交接（2026-10-26）

主模型增加实际候选的任务比较与默认相对顺序，副模型明确独立判断、实际产物和有依据的交接。成员消息使用内核当前授权携带 reason、scope/readScope/readOnly、固定 checks 与执行环境；既有入口检查覆盖独立成员交付、授权刷新及只读转写入。agent-sync 内核及依赖字节保持不变。

本版按固定私有源码生成 GitHub／npm 同一安装包。macOS 完整主套件 281 项中 278 通过、3 项 Windows 专属跳过，GUI 77 项通过。安装候选的 CLI、SDK、62 项静态资源及 1,416 个源码／SDK 路径逐字节核对通过。终端更新记录的首次网络审计观察到新版本自动查新；按现有 CI 约定关闭自动查新后复验，不修改产品逻辑或缩小断言。后续固定包散列、发布渠道和当次 CI 结果见发行页 SOURCE.json。

验证使用 localhost fixture 与本机 Docker，不调用付费模型；不能据此证明新的调度偏好或提示词已经提高真实模型质量。Windows CI 与物理 IME 验收分别对待，保留 Vite 大 chunk 与冻结依赖的既有风险。

---

# 0.8.4-updates.1：CLI／GUI 新版本提醒（2026-10-26）

从已合入主线的更新提醒实现生成本版，CLI 和 GUI 共用官方 npm latest 查新、SemVer 比较、24 小时持久节流、缓存与自动检查偏好。支持 `/updates`、无需模型配置的 `cothink check-update [--json]` 和 GUI 设置；网络失败继续使用，损坏状态保留，退出取消在途检查。只提供按原安装方式选择的指引，不下载、安装或重启，不调用模型；本地 `/changelog` 保持离线含义。

本机更新提醒验收：完整源码281项中278通过、3项Windows专属跳过；GUI77、核心/入口14通过；PTY验证提示不清草稿、面板与开关、重启节流，浏览器1280×800、1024×768、800×600无横向溢出、控制台无错误，并检查请求中Esc和刷新后草稿。旧候选安装后的CLI/GUI、62静态资产和1,416文件字节比对通过。本版另按固定源码重跑发行回归和安装检查；精确归档哈希、源码提交和当次跨平台CI结果以Release的SOURCE.json为准，不借用前版CI。

agent-sync31个文件保持不变；semver7.8.5从原Pi锁定依赖提升为CoThink直接随包依赖，其他冻结SDK不升级。查新采用5秒总期限、256KiB上限、拒绝重定向及一次GET，无模型密钥或对话材料。测试CI关闭自动公网查新，明确的正向用例仍使用本地fixture验证。

本次范围仅GitHub发行，未将0.8.4-updates.1发布到npm。新版本提醒以npm latest为准，GitHub发布本身不使查新推荐本版；按Release说明下载安装包。没有付费模型请求；fixture与CI不证明真实模型质量、Windows物理IME/键盘或未来发布源长期可用。保留Vite大chunk警告与上游冻结依赖的既有风险，不宣称零漏洞。

---

# 0.8.3-delegation.1：按能力分工与同模型限制（2026-10-26）

本版在共享工作运行时提供五个可调整的分工建议，区分主模型与合法副模型；未覆盖场景由主模型依据可见信息判断。禁止主模型自委派及已知同模型别名绕过，禁止对忙碌、未处理或未知结果的同一模型另建成员或借feedback改派复制；安全收尾后可顺序继续。保留Pi调用、范围、版本、接纳、预算、中断与未知不重发规则。

源码完整主套件270项中267通过、3项Windows专属跳过，零失败；GUI73/73、agent-sync内核48/48通过。新增检查以真实localhost传输、文件修改与接纳验证同模型拒绝、不同模型工作、别名身份、改派前校验、草稿保留、未知结果不绕过以及ONE禁委派。终端17＋40＋6项通过。候选安装后25项委派检查和36项HTTP／CLI PTY／Docker／历史集成通过；实际CLI、62项静态资源及1,415个运行/SDK路径字节核对通过。精确分发资产散列与来源以对应Release的SHA256SUMS与SOURCE.json为准。

正式agent-sync目录的31个文件与此前已发布基线保持一致；根包与lockfile只更新版本号，不升级依赖。能力建议的提示与运行时代码沿CLI/GUI同一路径。此次没有真实付费模型请求，localhost机制验证不能证明模型会做出最佳能力选择，也不能证明coding增益。自定义不透明转发的实际模型身份无法仅靠名字确认，已知别名之外的身份保证保留此边界。

下方历史版本的真实模型、平台和物理交互证据按各自版本保留，不替代本次验证。当前跨平台源码及安装CI见私有开发仓库对应版本的工作流记录；公开安装和资产入口见[GitHub Release](https://github.com/XSY-28/Cothink-release/releases/tag/v0.8.3-delegation.1)。

# 0.8.2-kimi.1：Kimi K3.1 Pro 接入（2026-10-24）

通过 Pi 公开 provider 注册接口补充官方 `kimi-k3.1-pro`，不重建 SDK 或写入用户模型/认证文件。Moonshot 国内、国际与已有官方地址的 OpenAI Chat Completions 导入配置使用同一固定声明；显式同名模型和其他协议/代理配置保留用户定义。low/high/max、保留式思考、多轮工具调用、显式输出字段与一次/三次政策由针对性真实 HTTP fixture 检查。

新增模型目录价格暂不固定，使用现有未知估价机制保持费用 null；不能声称免费或服务商实际费用。默认不加输出 cap、重试、压缩或模型超时，旧 Team/历史保持，选择新模型仍另存新 Team。

本机修复后完整主套件256项中253通过、3项Windows原生平台跳过，GUI73通过，agent-sync内核此前48通过。新模型17项针对性检查包括实际CLI选择流程、GUI模型投影与配置刷新生命周期。终端17＋40及更新摘要6场景分别检查；更新记录变长时，测试改为在原8秒时限内逐页读取到旧版本，不再假定固定四页。

官方Moonshot国内API模型列表返回200并列出Pro。真实批次固定5个生成请求：low/high/max三次ONE短答均完成；只读内存工具的一轮两次请求完成，reasoning_content原样回传。每次显式输出上限16384，仅为本次受控验收，不是产品默认值；费用仍为未知。该批次检查接通和协议，不代表模型质量、性能或国际API已实测。

随后审查发现最初provider包装会保留已撤销Key/请求头，新增失败回归并修复为原始Pi服务商定义＋实时用户配置组合。删除手工同名配置后也能回退内置Pro。最终代码把5个已录制真实响应全部离线重放，发送的messages、tools与关键参数逐项匹配；同时核对新旧模型复用同一现有凭据，没有增加收费请求。独立审查另外复现了已导入身份变更/删除后Pro残留，以及手工复用其他内置服务商ID时旧目录消失的问题；失败回归保留，刷新时重新组合当前本地配置，并仅自动增强实际自定义身份，17项专项通过。两个安装CI工作流另用实际安装包运行同一专项。最终安装与远端CI结果以本版本发行记录绑定。

---

# 0.8.1-pi.1：Pi 1.4 本地更新（2026-10-24）

CLI 与 GUI 的唯一 Pi 底座从 1.0.0 升级为固定 1.4.0，保留终端宿主、输入空白、密钥隐藏、无默认超时补丁。Anthropic SDK 随上游升级为 0.129.0，OpenAI SDK 保持 7.19.0。上游源码、模型目录、补丁和四个归档的哈希记录于 `vendor/pi-patches`；重复重建得到相同归档哈希，旧归档只保留于本地回退证据。

Pi 1.4 的原生终端新增后台目录刷新，原 `allowModelNetwork: false` 只限制初始化。实际 CLI 联网审计先捕获该变化；CoThink 在统一 ModelRuntime 入口固定所有目录 refresh 为本地读取，新增真实 runtime 测试有 RED/GREEN。原生启动、reload、服务商刷新均不越过该政策；显式模型生成与认证沿用现有路径。

macOS ARM64／Node 24.19.0、干净锁文件安装：主套件239项中236通过、0失败、3项Windows原生平台跳过；GUI73/73、agent-sync内核48/48、终端17＋40＋6通过。所有模型检查为localhost fixture；隔离执行使用实际固定Docker镜像。首次Docker未运行及后续退出的失败、目录刷新RED和打包停滞记录保留；没有改检查时限或跳过Docker来制造通过。

候选离线安装到中文／空格prefix，实际CLI／GUI、62个静态资源和1,415个源码／SDK文件比较通过；安装后HTTP／PTY／Docker／历史／截断／未知响应19/19、更新提示六场景零联网通过。安装验证随上游从esbuild改为用实际jiti执行TypeScript enum，补丁SDK与错误版本拒绝仍检查。两次旧新切换及配置变化拒绝覆盖的回退演练通过。用户数据副本中的2个Team、2个会话、4轮任务可读，历史错误0；原147文件校验保持。上述为最初本机更新证据，具体包哈希和回退入口保存在本地交付记录。后续用户另行授权 GitHub 与 npm 发布；发布检查只调整安装文档，运行代码与上述本机版本逐字节核对，远端 CI 与 registry 结果以对应发行记录为准。

边界：未调用付费模型，未验证本轮Windows实机／远端CI、物理IME或人工跨应用复制。生产npm audit保留上游undici 8.10.2的一项high及Pi归因的moderate，未改写上游精确依赖；不能称为零漏洞。Vite约707kB chunk警告及node-domexception弃用提示仍在。

---

# 0.8.0-unified.1：CLI／GUI 统一候选（2026-10-23）

CLI 与 GUI 在私有主线维护唯一核心、一个根版本与同一安装包。合入固定 CLI 发行提交的 length 诊断及 Windows 原子保存修复，保留 GUI 的 secret 脱敏、最新 writer generation／released 与历史分支行为。原版本证据按版本保留，不替代本候选验收；本候选未发布 npm、未替换全局安装。

本机 macOS ARM64、Node 24.19.0：干净锁文件安装后，完整主套件 238 项中 235 通过、0 失败、3 项原生 Windows 检查按平台跳过；agent-sync 内核 48/48、GUI 73/73、终端 17＋40＋6 通过，构建通过。CI 候选驱动 11/11，通过根版本和实际打包结果选择精确归档，不再以安装包自身版本作期望值。原生 Windows 与最低 Node 22.19.0 由私有 CI 另验，不能用本机跳过代替。

实际安装候选在含中文和空格的干净 prefix 离线安装。CLI／GUI 实际入口、认证、62 个静态资源、1,378 个分发及 SDK 自身文件比较通过；全部 15,157 个安装普通文件与归档逐字节相同。故意使用错误期望版本时，校验明确拒绝。安装后的真实 HTTP／CLI PTY／Docker／历史／partial 组合 19/19 通过，覆盖三次问答与 ONE、写锁、实际 fork／tree、损坏记录隔离、取消、固定版本差异及二进制／删除／执行位补丁重建，原测试项目不自动写回。

length HTTP 回归覆盖初稿／评审／修订、默认及显式额度、完整已收文本、实际阶段／模型、未知用量和费用、重开及重复确认不重发。共享错误指引同时指向模型设置与 CLI 参数，没有新增模型重试。实际安装候选浏览器完成三次讨论后 ONE 截断，部分原文和额度设置可见，刷新保持状态；总计四次 localhost 请求，console 无 warning/error。

生产依赖、bundledDependencies 与四个锁定 SDK 归档保持字节。生产 audit 仍有冻结 SDK 的一项 high，Vite 仍有约 707 kB chunk 警告；没有为本轮合并升级 SDK 或隐藏警告。测试仅用 localhost 固定回复和临时项目，不证明真实模型质量、物理 IME、人工跨应用剪贴板或 Windows Docker。原目录及未提交资产保留；施工期间出现的并行评测工作另存快照，未混入本轮固定输入。

来源、候选哈希、原始失败、独立审查和实际远端 CI 绑定见[统一验收记录](https://github.com/XSY-28/cothink-gui/blob/main/docs/SOURCE_UNIFICATION_ACCEPTANCE.md)。此处本地结果不提前宣称远端通过。

# 0.8.0-gui.1：私有 GUI 候选（2026-10-23）

本版增加本地浏览器入口，复用唯一 Pi 调用路径与 agent-sync。普通未关联项目对话使用中性目录；GUI 与 CLI 使用相同会话、Team、模式和写锁。项目成果保存在独立目录，不自动写回原仓库。版本仍是私有候选，未发布 npm、未替换全局安装。

本机 macOS ARM64 此前完整源码回归：`npm test` 217 项中 216 通过、1 项 Windows 原生检查跳过；`npm run test:agent-sync-core` 48/48；`npm run test:gui` 60/60；`npm run test:pi-terminal` 的 17、40、6 项通过；`npm run build:gui` 成功。重型 Docker 检查顺序运行。以上模型机制均使用 localhost 固定回复，无付费模型调用。

新增真实 HTTP 集成覆盖空配置／Key／命名 Team → 主答／第一评审／修订三次 → ONE 一次 → 释放 GUI writer → 实际 CLI PTY 同会话恢复 → 重开 GUI。CLI 持有 writer 时 GUI 只读、拒绝提交；上下文、Team、ONE、明确 null 项目和无 start_work 权限保持。macOS `/var` 与 `/private/var` 的中性目录差异曾导致继续会话查找失败，已保留 PTY 失败证据并通过规范真实路径修复。

项目验证通过实际 server 与 Pi fixture 调用 agent-sync，包含 read/edit、独立成员、Docker 检查、接纳、任务固定 diff 和分页日志。下载补丁通过 Git `apply --index --binary` 重建与目标版本完全相同的树，包含二进制、删除、执行位；后续任务推进正式版本后旧任务 diff 不变，原仓库文件与 status 不变。空检查策略为 unverified，非空检查缺执行配置保持 partial 并显示已保存的具体错误；缺 Docker 在限制 PATH 的独立子进程验证，不停止用户 Docker，也不回退宿主 Shell。

既有 GUI 检查覆盖重复 submissionId、刷新／SSE 断连重连、取消评审／成员、宿主关闭、损坏／旧历史、设置持久化失败、冻结模式、模型身份、secret 脱敏、Host／Origin／令牌／CSP／路径隔离。组件验证包括成员模型不能同时被列作未参与评审、中文准备阶段、IME composition 不误发、焦点返回与安全 Markdown。组件和 PTY 不能替代物理中文输入法、浏览器现场或剪贴板验收。

安装包使用 `npm run pack:npm` 先重新构建 GUI，去掉消费者 overrides，保留锁定 SDK 的原字节。候选在含中文和空格的独立 prefix 离线安装，以实际安装后的 CLI、模块及 62 项静态资源验证；安装后的 HTTP／PTY／项目集成另跑，源码 fixture 仅提供 localhost 服务商与临时 Git 测试数据。最终包哈希、逐字节比对、安装路径和原始命令保存在本地阶段报告，不能用版本字符串单独认定同一产物。

实际安装候选的浏览器验收已覆盖空配置设置、三次讨论、ONE 追问、真实 Docker 项目成果、从其他历史取消评审／成员、草稿保留、改名搜索、深浅主题和 1280×800／1024×768／800×600 视口。焦点与滚动恢复通过，页面无横向溢出，检查时 console 没有 warning/error。整分支审查发现的 fork／分支任务归属和损坏历史隔离问题另有真实 SDK／HTTP 回归：继承祖先、排除兄弟分支，GET-only 确认恢复保持会话内去重；损坏文件保留且只读，不阻断健康历史和设置。历史修复候选安装后 11/11 集成（6 项历史、5 项原 HTTP／CLI PTY／Docker）通过。最后追加真实同进程宿主重开后父／fork 历史可写的回归：只读占用判断复用现有最新 writer generation／released 语义；定向 9/9 和共享存储／Pi／包／Team／恢复 40/40 通过，交付包另行重建并复验。

本机锁屏阻止 Finder 窗口观察，原生打开成果目录的窗口呈现、物理中文输入法及跨应用剪贴板没有验收；Windows 实体机／Docker、付费模型答案质量与普遍性能收益仍未验证。私有交付 CI 的范围和可检查入口见 [GUI 验收记录](https://github.com/XSY-28/cothink-gui/blob/codex/lightweight-gui/docs/gui/ACCEPTANCE.md)，旧发行 CI 不代替本候选结果。

保留的依赖／构建问题：冻结 Pi SDK `1.0.0-cothink.9` → minimatch `10.2.6` → brace-expansion `5.0.9` 的 npm audit high 告警未通过重写 SDK 消除；本轮依赖字节保持不变，新浏览器 KaTeX 固定为 `0.19.0`。Vite 保留大于 500 kB 的 chunk 告警（约 707 kB，gzip 约 216 kB），构建成功不等于零警告。浏览器代码／本地字体完整声明见 `gui/THIRD_PARTY_NOTICES.txt`。

以下保留此前版本的历史发行证据。

# 0.7.1-windows.1：Windows 请求记录原子替换（2026-10-23）

一例 Windows 长回答失败记录显示：初稿 `completed/stop`，评审 `failed/error`，错误为 `requests` 目录中 `.tmp` 替换 `.json` 的 `rename EPERM`。这定位到了本地保存环节，不属于服务端 `length` 截断；外部占用者或持久权限的具体原因尚未确认。此前长回复诊断版本只改善错误信息，没有修复这条替换路径。

本版仅对 Windows 的 `EPERM`、`EACCES`、`EBUSY` 替换错误最多尝试九次，退避等待合计最多 1060ms。始终使用已写入并 fsync 的同一临时文件，替换前重新检查写入授权，不删除目标文件；持续拒绝或其他错误仍停止并保留旧内容。保持现有同步保存顺序，没有新增模型请求、自动续写或模型重试，也不改变 agent-sync 独立内核。

新增检查覆盖临时三类错误、持续拒绝、非 Windows/磁盘错误、授权失效、评审保存故障后三次模型调用与完整文本保持。真实 Windows 测试用独立进程持有未共享删除权限的文件句柄，分别检查短暂占用后的原子发布和持续占用下的失败保护。平台结果与固定候选信息见[该版本 Release](https://github.com/XSY-28/Cothink-release/releases/tag/v0.7.1-windows.1)。

macOS 完整套件236项中233通过、0失败、3项Windows原生检查跳过；终端检查17 + 40 + 6项通过。[Windows 修复 CI](https://github.com/XSY-28/Cothink-release/actions/runs/39937145147) 在 x64/ARM64 上分别通过55项源码和7项安装入口检查，x64 ConPTY 通过；真实短锁结束后恢复保存，持续占用仍失败并保留旧记录。[公开 ZIP 下载安装](https://github.com/XSY-28/Cothink-release/actions/runs/39939372142) 两个架构通过。费用为零，本轮仅使用localhost回复、文件锁与本机Docker；未进行收费模型调用或物理键盘/IME验收。

[npm 候选验证](https://github.com/XSY-28/Cothink-release/actions/runs/39940950467) 已通过：Windows x64、Windows ARM64、macOS ARM64 用同一个包，在空配置和空缓存中完成默认生命周期的全局安装，并验证实际命令、SDK、esbuild 和 localhost 三次讨论；Windows 另测原生剪贴板，x64 另测本地 prefix 和 ConPTY。候选 SHA-256 为 `dfa1a58f4091179e9785180728ade72bfbf7ff34e6b35a8224f9ba4ab6fd1f48`；34 个运行、提示与内核文件以及4个锁定SDK归档与发行源码逐字节一致。npm 的 Linux CI 归档与 GitHub 的 macOS 归档压缩字节不同，运行代码相同；既有 Release 资产保持原散列。

npm 后台状态已确认为 `published`，公开版本和 `latest` 均为 `0.7.1-windows.1`；SHA-512 integrity、SHA-1 shasum 及匿名下载包的 SHA-256 与上述固定候选一致。本机命令已为同版，其34个运行文件与4个SDK归档也与 npm 包一致，原配置和历史保留。

[公开 registry 安装复验](https://github.com/XSY-28/Cothink-release/actions/runs/39943725053) 的 Windows x64、Windows ARM64、macOS ARM64 全部通过：不登录 npm，在空配置、空缓存中直接安装不带版本号的 `cothink-v2`，确认默认 `latest`、实际命令、SDK、原生依赖和上述运行行为。Windows 原生剪贴板及 x64 本地 prefix / ConPTY 同时通过；没有收费模型调用。

# 0.7.1-diagnostics.1：长回答截断诊断（2026-10-23）

本次增加服务返回 `length` 时的阶段、模型、明确输出额度或服务默认额度提示，以及显式额度和历史查看方法。完成判断保持原样：未完整收到的回答仍为 `partial`，不自动续写或重试。一例长回答截断反馈仅提供 `partial` 状态，缺少原始错误记录；该个案尚未定因，本次仅修复已确认的诊断信息缺口。

基于已发布的 `0.7.0-auth.2` 移植，保留内联认证、启动标识及长列表功能。macOS 源码完整回归 **223 项中 222 通过、0 失败、1 项 Windows 原生检查跳过**；终端检查 **17 + 40 + 6** 项通过。定向 **19/19** 通过，覆盖长回复分段接收、初稿与评审内容完整传递、JSON 导出和历史读取，以及初稿/评审/修订分别截断后停止、保留内容且不自动重试；显式额度在三次请求中一致传递。

本地模拟另验证了每阶段约1.49 MB文本、总约26 MB JSON完整导出；这些实验没有复现按本地JSON长度裁剪，不能替代反馈现场或真实模型复现。服务默认额度是能产生相同表象的原因候选。

此版通过 GitHub 预览 Release 分发，不更新 npm `latest`。安装候选及本机更新使用临时数据验证，并保留旧安装；本次没有付费生成、Windows 实机或 CI 验收。

# 0.7.0-auth.2：添加模型时的认证内联（2026-10-22）

`codex/inline-model-auth` 已合入 `main`，版本 `0.7.0-auth.2`。公开 registry 的 `latest` 已指向该版本，tarball SHA-256 为 `3abdb8db480ff54df59e4bc43bda4d18a3c1f2f78700803bef4cbe30ea65d508`，与本地验证包一致；从 registry 重新安装后 5 组认证 PTY 通过，安装文件的 33 个运行/提示/内核路径与本机发布目录逐字节一致。

`0.7.0-auth.1` 在当时发布验收中处于无法列出或批准的暂存状态，未能公开安装，因此改用 `0.7.0-auth.2` 发布；版本号差异不代表代码差异。选择模型时说明复用哪个服务商的 API key、OAuth 或环境认证；缺少 API key 时在阵容编辑流程内隐藏输入，由 Pi SDK 保存，无需先退出到 `/login`；仅支持 OAuth 或环境认证的服务商按其支持方式处理。取消或空白输入不写密钥，原 Team 保留；自定义服务商须使用新配置 ID，不得覆盖已有服务商或孤立认证。

macOS 源码验证：完整套件 217 项中 216 通过、0 失败、1 项 Windows 原生检查跳过；`npm run test:terminal` 的 17、40、6 项通过。定向 65 项包含 25 项认证单元（复用来源、OAuth/环境认证、空值与取消/中断、自定义 ID 覆盖保护、写前重读、同步失败脱敏、掩码输入清理）及 5 组真实 CLI/PTY（已有认证复用、自定义服务商保存/取消/空白、既有未认证服务商内联保存）。全部管理操作零模型请求；PTY 检查确认密钥不回显，取消不修改 config、auth 与 models。

本机 PATH 没有 `rg`，完整套件运行时临时把 Cursor 自带 ripgrep 加入 PATH；失败样本 `spawn rg ENOENT` 与最终通过日志均保留。该依赖属于既有 grep 工具，与本次改动无关，未安装软件或修改系统配置。

安装入口：按锁文件重建依赖后 `pack:npm`，临时前缀离线安装；33 个运行、提示与内核文件与源码逐字节一致；安装后的 5 组认证 PTY、18 组 Team 生命周期、14 组长列表检查及 Node 包装 5/5 通过。测试使用临时数据目录与 localhost 固定回复，未读写用户配置或历史。

未验证：真实服务商 API key 的远端有效性（认证配置存在不等于可调用）、物理 Terminal/IME、Windows 实机与 CI。未发布 npm、未推送 GitHub、未修改全局 `cothink`。

# 源码主线：启动标识与 Team 选择列表修复（2026-10-22）

启动标识与菜单修复已合入源码主线。组合验证中，完整主套件 186 项通过、1 项 Windows 原生检查在 macOS 跳过；终端 17 + 40 + 6 项通过。另有 17 项同进程检查覆盖启动标识右侧对齐、菜单取消后恢复、缩放重绘及下述长列表操作。标识在至少 80×24 时显示，较小窗口使用紧凑标题。

组合回归曾在任务已保存完成、最终终端帧尚未读完时失败。测试改为在原 18 秒总时限内等待包含最终稿的同步帧结束，不增加重试或放宽内容断言；每次仅读 1024 字节的问答、工作两个探针也通过，并确认最终稿出现在可见画面中。该修正仅涉及测试读取时序，产品调用和保存逻辑未改。

CoThink 自有模型、服务商、Team、成员列表及删除确认改为按终端高度显示。原通用选择器的 150 项会渲染 158 行，选中项可移出 24 行窗口，滚轮事件也未处理；新列表保持选中项和控制提示可见。另修复任务运行中 `/team` 先开菜单后检查忙碌的问题。

macOS 源码验证：`npm test` 187 项中 186 通过、1 项 Windows 原生检查跳过；`npm run test:terminal` 的 17、40、6 项全部通过。新增 8 项组件检查及 14 组实际 CLI/PTY 操作，使用 180 个模型、70 个 Team、60 位副模型，覆盖长列表首尾、翻页、SGR 滚轮、80×24 到 40×12 缩放、准确选择另存、取消保持配置和认证、长标题及确认。管理操作没有创建模型请求，完整回归仅用 localhost 固定回复和本机 Docker，无付费调用。

临时目录按锁文件重建依赖后打包，再用独立 prefix 离线安装：22 个运行模块与源码逐字节一致；安装入口的长列表 14 组、Team 生命周期 18 组、命令 40 组检查通过。测试配置与用户数据分离，未替换全局命令。原本地依赖目录打包遍历未结束，保留日志并终止该次构建；后续干净依赖构建成功。

以上是本地源码与 PTY 证据；这组改动尚未进行 Windows 原生控制台、修复后物理 Terminal/触控板验收或 CI，也未发布 npm。下面的已发布版本记录保留为历史证据。

# npm 0.6.0-windows.2 发行验证

发行打包只删除消费者不需要的开发 overrides，保留已锁定 SDK 字节。[候选 CI](https://github.com/XSY-28/Cothink-release/actions/runs/39573483903) 已通过：同一个 npm 包在 Windows x64、Windows ARM64 和 macOS ARM64 上正常全局安装，使用空配置、空缓存和默认生命周期脚本。验证实际命令入口、patched SDK、esbuild 平台二进制与 localhost 三次讨论；Windows 另测原生剪贴板，x64 另测 ConPTY 及本地 prefix 安装。

该候选的 SHA-256 为 `05a6f4af63b4872fdd5237073957b8a366504a8b29ab5a48e0ae4b74bb736028`。npm 后台校验已完成；公开 registry 的版本与 `latest` 均为 `0.6.0-windows.2`，SHA-512 integrity 和 SHA-1 shasum 与已验候选一致。[公开 registry 安装复验](https://github.com/XSY-28/Cothink-release/actions/runs/39586860186) 的 Windows x64、Windows ARM64、macOS ARM64 三个任务全部通过：直接安装不带版本号的 `cothink-v2`，验证默认 `latest`、npm 命令、SDK、原生依赖与上述运行行为。没有登录 npm 或使用私有 registry 凭据。

[首次 registry 复验](https://github.com/XSY-28/Cothink-release/actions/runs/39586403627) 中 ARM64/macOS 通过，x64 安装与功能检查通过后，ConPTY 测试在轮询原子更新的任务文件时遇到临时 `PermissionError`。测试现仅在原 40 秒时限内等待文件可读，持续拒绝仍超时失败、损坏 JSON 仍报错；两条 completed 任务、原输入、详情、模式与退出断言均保留。随后复验通过，npm 包与候选内容未改。

# Windows 0.6.0-windows.1 发行验证

目标环境为 Windows Terminal + PowerShell，Node.js 最低版本 22.19.0。Windows ZIP 使用 runner 上构建的锁定依赖，安装器直接解压运行包，不经过 npm 二次解析；支持中文和空格目录，并保留调用者的项目目录。

## 验证范围

- Windows x64 / ARM64：源码专项 38 项、真实下载包安装与版本入口、Windows 原生剪贴板中文/多行往返、安装后的参数/管道/JSON/history/show 和失败退出、localhost 三次讨论。
- Windows x64：ConPTY 下管道输入重开控制台及 raw mode，中文多行粘贴、Ctrl+J、详情/Esc、ONE 模式与退出。测试宿主用屏幕模拟器回应终端位置查询，零付费模型调用。
- macOS 干净发行源码：完整 177 通过、1 Windows 专属跳过；此前终端 PTY 17+40+6 通过。最后的 Windows 设备路径修复单独通过专项和 Windows CI，不借用旧 macOS 记录宣称 Windows 通过。

本轮构建与安装证据：[Windows release CI](https://github.com/XSY-28/Cothink-release/actions/runs/39568034284)。[公开下载复验](https://github.com/XSY-28/Cothink-release/actions/runs/39569517392) 已完成：x64 与 ARM64 均不带 GitHub 凭据从 Release 下载，SHA-256 匹配后解压安装，版本、原生剪贴板往返、安装入口 2/2 与三次 localhost 讨论均通过。没有 npm 依赖安装或付费模型调用。

## 已发现并修复

- Windows 短控制台设备名在 Node 22.19 被规范化成带尾斜杠的路径；真实探针确认完整 ConDrv 设备路径可初始化，输入和输出都使用读写权限。模拟测试不能替代这一验证。
- Windows 不能沿用 POSIX 目录 fsync；保留文件 fsync 与原子 rename，目录项断电耐久性由 Windows 提供。
- NTFS stat 不推断 Git 执行位，已有版本的 mode 保留，新文件默认 100644。Windows 文件系统上的 chmod 不作为 Git mode 修改接纳。
- 取消包安装使用进程树终止；终止失败独立记录 UNKNOWN，不依赖可能永不到达的 close 事件。
- npm 10 空缓存安装曾报 `Unable to resolve reference $openai`，下载包改为直接展开已完整打包的依赖。tar.exe 的绝对中文路径失败通过进入目录后使用相对路径修复。
- ConPTY 初始测试缺少位置查询响应；快速探针的进程清理竞态另行修复。失败与取消的 Actions 记录保留，不算通过，也没有改变调用次数或产品时限。

## 尚未验证

物理中文输入法、具体终端的实体键盘/鼠标体验、人工跨应用粘贴、Windows Docker Desktop Linux 容器与真实服务商生成仍须分别验收。Shell 保持 Linux 容器隔离，不回退到宿主 PowerShell。Windows ACL 与 POSIX 0600/0700 不是同一权限机制。npm 发布状态与安装验证见本文开头。

---

# 当前对话模式

独立 `/one` 进入持续单模型模式，`/cothink` 回到讨论；`/one <任务>` 仅本条覆盖。输入框下方常驻模式，预算按实际任务变化，任务提交后冻结，运行中切换只影响下一条。保留同一上下文和 Team，模式随会话/分支恢复，新对话默认讨论。

开发源码完整166/166、终端17+40+6通过；独立安装入口9/9，21运行模块与源码相同。实际安装命令的8组模式CLI/PTY检查包括零调用幂等切换、连续单模型、临时覆盖、多行材料、reload/resume/clone/fork/tree、新对话重置、旧会话默认、运行中冻结和写入失败阻断/重开恢复。40×12 检查解释完整同步重绘后的可见屏幕，输入草稿后仍有模式提示；不是搜索旧输出中的标签。

上述为模式功能当时的验证记录。模式功能没有新增收费模型验收；localhost 和 PTY 不代替真实模型质量、物理 Terminal/IME 或 CI 结论。原始失败与修正保留于独立开发证据中，个人路径、配置与恢复备份不进入仓库。

## npm 分发

首次 npm 公开版本为 0.5.0-packages.1 包管理版；当前版本状态见本文开头。分发配置取消 private 标记，包内容仍由明确files清单及bundledDependencies限定，不包含测试数据、凭据或私有开发记录。

发布验收分别检查固定tarball的内容/完整性、没有忽略生命周期脚本的普通全局安装、实际命令入口，以及发布后无登录环境从registry安装。npm的latest标签用于默认安装；预览状态和macOS支持范围保持。新增分发入口不构成对其他系统、任意Pi插件或真实模型质量的验证。

## 可复现的本地检查

在 Apple silicon macOS、Node.js ≥22.19 上从干净依赖安装运行：

```sh
npm ci --ignore-scripts
npm test
npm run test:pi-terminal
npm run test:agent-sync-core
```

主套件包含 166 项；PTY 套件分为终端 17 项、命令 40 项、更新记录 6 项，另有模式生命周期8组嵌入主套件；独立内核套件包含 48 项。完整套件使用真实 Pi SDK、localhost 固定回复和本机 Docker 容器，不调用付费模型。完整结果须以实际命令输出为准。发行包另经临时前缀离线安装，核对模块、提示词、依赖哈希与命令入口；测试夹具不随运行包分发。

## 包管理本地证据

新增19项包管理用例，使用真正的Pi公共接口、localhost npm registry/tarball、真实npm和localhost模型服务。管理不调用模型；无配置、未命名v2、v3、不可用模型引用和没有Team快照的旧会话均可管理，模型配置/认证/既有会话字节不变。安装脚本有根包及传递依赖的可执行正对照，管理安装时marker均未出现；未知JS的import marker不出现。

清单校验精确来源、安装归属、过滤、缺失/版本不符和包外路径。安装/卸载验证候选发布、独立配置/目录改写冲突、活跃窗口和跨进程互斥、挂起下载取消、发布写盘失败及两次目录rename之间的真实SIGKILL；未完成提交必须通过下一次显式操作核验恢复。缺失安装目录的登记可卸载，不会自动补装。

实际CLI/PTY跑通install→list→使用模板/技能→退出→remove→list。带包的Team矩阵覆盖原18组生命周期和故障场景；包使用流程4次localhost模型请求，Team矩阵6次，收费0。普通问答3次、/one一次，初稿/独立评审/修订和工作成员收到冻结材料；候选.pi不获得加载机会。坏包阻断新生成，历史与Team本地入口仍可用。

开发源码完整163/163、最终源码产物的安装入口包管理19/19、终端17+40+6通过。21个生产模块与已验安装字节相同；本仓库同步候选从干净依赖再运行完整回归163/163（0失败/跳过）、终端17+40+6检查，均通过。fixture通过不等于真实第三方兼容或物理Terminal/IME验收。

曾有一条新增禁止包身份测试因复数名称漏拦截和registry未隔离，在临时测试目录下载pi-subagents@0.79.1；没有执行安装脚本或插件JS，目录已清理。现已同时禁止单复数身份，该组输入固定localhost并断言零registry请求；原失败和更正保留在私有开发证据中，不以修复后的通过隐藏事故。

## Team 与首次提示修复历史证据（0.4.0）

team用例覆盖创建/命名、阵容变化另存、当前/最后一个删除保护、2→1、认证复用、新对话继承、旧会话绑定、跨窗口删除、clone/fork/tree/import和持久化故障。完整阵容与实际调用者分别记录，名字不进入模型上下文。新增实际CLI/PTY流程18组，使用localhost固定回复，真实模型请求为0。

0.4.0-team.1 的实际Terminal截图暴露首次输入提示被擦除：先直接输出label，再调用空prompt，readline清屏后文字消失。0.4.0-team.2将文本/编号label交给readline管理；secret仍隐藏。新增回归先观察两项文字/选择可见性失败，再验证修复；已安装旧入口清屏后空白、新入口保留提示的对照成立。该证据检查重绘后的当前行，不等同修复后物理Terminal/IME复测。

0.4.0-team.2当时已有144项本地回归和固定安装入口20项检查；当时干净仓库完整回归144/144，0失败/跳过；终端17项、命令40项、公告6项也通过。配置升级和新→旧→新回退使用临时数据，真实配置副本保持原阵容/参数，实际安装不要求用户重复输入Key。原始个人配置、请求、完整日志及恢复备份不进入此仓库。

## 既有真实运行与现场证据

Pi 迁移阶段已做 Kimi K3 / DeepSeek Flash 真实问答验证；失败与费用未知项保留。agent-sync 接入的 0.3.0-agent-sync.1 候选另完成两个人工工作项目：协作文本修改 36 次请求，二进制与容器后台服务 10 次请求，28 项独立复核通过。实际生成入口是安装包公开 runTurn 引擎（与 CLI 共用），并非交互二进制发起付费任务；history/show 通过实际安装命令只读验证。36 次请求项目保留一次检查失败及同草稿带反馈修复，不重跑已完成任务。此证据支持这两条路径可用，不证明普遍质量、规模性能或成本优势。

采集器曾发生回调未接入、完成后树查询参数遗漏，问题及原失败均保留于私有历史。二进制案例的多行 `/one` 被按材料保真规则处理，虽然实际无成员，不能证明真实调用中宿主强制了 `/one`；强制规则由确定性测试支持。完整批次账单未知，部分已知费用不代表总成本。

原生 Terminal 的中文 IME、多行输入、详情返回草稿、缩放和跨应用复制有用户现场确认，包括修复 Escape+Return 后 Shift+Return 换行及 Return 发送。该确认来自先前 Pi 迁移版本，本次发布整理未重新进行物理终端验收；PTY 自动化与用户现场结果分别计证。

## 兼容与未验证边界

当前支持原生技能、模板和已审查纯 UI 资源；技能加载/展开/刷新与预载机制有检查。普通问答是否正确理解和运用预载技能，仍需独立内容验收。旧网页插件、MCP adapter、plannotator 的加载/注册记录不代表当前兼容：新宿主对未适配扩展在加载前拒绝。

上述历史记录当时未做陌生用户、另一台机器、其他平台或 CI 验收；本轮 Windows 与 npm CI 结果见本文开头。没有本次新付费调用。未以真实丢响应重复执行来验证未知远端请求恢复；已有确定性故障测试不等于服务商现场故障。Docker 保证限于可信本地宿主和已验负向样本，不声称覆盖任意容器逃逸。

原始请求、个人配置、失败日志和完整开发历史留在私有归档，未随源码发布。此处公开摘要用于说明证据边界，不能代替独立复测。许可证和文档整理本身不增加产品能力。

## 2026-10-26 更新提醒候选（未发布）

分支 `codex/update-notification` 基于产品主线；未改变包版本、发布或替换全局安装。CLI 和 GUI 共用官方 npm latest 查新、SemVer、缓存、24 小时节流与自动检查偏好；仅提供更新指引。

本地源码回归 `COTHINK_NO_UPDATE_CHECK=1 npm test`：278 通过、0 失败、3 项既有 Windows 专项按平台跳过；这些跳过不构成本次 Windows 证据。`npm run test:gui`：77 通过。`npm run test:terminal`：PTY、斜杠命令与离线本地更新摘要通过；新增路径验证提醒不清草稿、`/updates` 零模型调用、自动检查关闭后重启不再请求。`node --test test/pi-updates.test.js test/pi-entrypoints.test.js`：14 通过，覆盖失败、挂起响应体、总期限、非法元数据、缓存保护及无配置 JSON 入口。

实际本机浏览器点选确认提示、安装方式、精确 npm 命令、自动检查偏好、失败与带时间的旧缓存、刷新后草稿及检查期间 Esc 返回；1280×800、1024×768、800×600 无页面横向溢出，控制台未见错误。`npm run build:gui` 成功，保留既有 >500 kB chunk 体积警告。

候选以 `npm run pack:npm` 打包，在临时 prefix 用 `--offline --ignore-scripts` 安装：共享模块、直接随包 semver 7.8.5、安装后的 CLI/GUI fixture、离线空 home 启动和源码/静态资产相等检查通过。agent-sync 31 个文件哈希不变；锁文件仅新增根依赖并将同版本 semver 提升为直接依赖。无付费模型请求；localhost 模型 fixture 测试不代表真实模型质量。

显式官方只读元数据检查取得 HTTP 200、3774 字节、合法包名及版本；这只证明当时可访问。早期 PTY 预加载 fetch 被 Pi 初始化替换，可能额外访问官方查新源，是否到达未记录；修复后 fixture 拦截生效。该测试失败、菜单通知等待条件修正、浏览器焦点修复与首次 bundle 别名问题均保留于本地验收日志。

本候选未运行 Windows CI/实机、真实用户升级或回退、未来 npm/GitHub 资产可用性验证。未推送或发布；功能通过本地验收不表示现有用户已经收到更新。
