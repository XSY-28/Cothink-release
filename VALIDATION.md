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
