# CoThink

CoThink 是一个多模型协作工具，旨在让不同模型组成团队，通过讨论、相互检查和分工协作，获得更好的回答与任务成果。

GitHub 预览版 CoThink `0.8.9-native.1` 基于固定 Pi 1.4.0 开发，可复用 Pi 社区的技能（Skills）、提示模板、主题及下述已支持的插件入口。本版通过 [GitHub Releases](https://github.com/XSY-28/Cothink-release/releases/tag/v0.8.9-native.1) 提供安装包，尚未发布到 npm；具体范围见下方的[包管理说明](#安装和查看-pi-资源包)。

项目仍在早期预览阶段，支持 macOS 与 Windows（x64 / ARM64），可通过 npm 安装；Windows 也提供 ZIP 下载包。项目仍有一些 bug 和不完善之处。欢迎通过 [Issues](https://github.com/XSY-28/Cothink-release/issues) 反馈问题、分享使用体验或提出改进建议。

## 本版新增（0.8.9-native.1）

- 接入 Pi 插件的工具、命令、事件与技能，安装后可在已支持的 CLI 路径中实际使用。
- 包管理支持 npm、Pi 支持的 Git 来源、本地文件／目录，以及个人／项目作用域；多个 Team 共享所选资源。
- 支持插件动态注册和空闲时重载；加载错误、名称冲突及未适配接口明确报告。
- 插件产生的文件在独立副本中处理，经审阅、版本校验和 agent-sync 检查后接纳，原目录不自动覆盖。

普通纯问答仍为 ONE 一次、CoThink 三次。本轮主要验收 CLI；具体支持范围和未验证项见 [VALIDATION.md](VALIDATION.md)，不代表所有 Pi 插件均已兼容。

## 本地浏览器界面

本版本可在浏览器中完成连续问答、ONE／CoThink 切换、具名 Team 与认证设置、历史查看，以及关联 Git 项目的代码工作。中央显示完整交付，右侧保留实际初稿、评审、修订或成员记录。浏览器只是本机核心的界面，模型请求仍使用你配置的服务商。

CLI／GUI 共用一份源码，开发主线保存在私有仓库。普通用户通过 npm 安装后运行 `cothink gui`，无需源码仓库权限。已有仓库权限的维护者也可从源码启动：

```sh
git clone https://github.com/XSY-28/cothink-gui.git
cd cothink-gui
npm ci --ignore-scripts
npm run build:gui
npm run gui -- --no-open
```

打开命令输出的本机启动链接。链接中的 fragment 是本次宿主的临时凭据，请勿分享；页面读取后会清除地址中的凭据。默认仅监听 `127.0.0.1` 的随机端口。省略 `--no-open` 可自动打开浏览器，`--port 4317` 可指定端口。

从源码生成的安装包也可安装到独立目录，不替换原有全局命令：

```sh
npm run pack:npm -- dist
npm install --prefix ./gui-preview --ignore-scripts ./dist/cothink-v2-0.8.9-native.1.tgz
node ./gui-preview/node_modules/cothink-v2/bin/cothink.js gui --no-open
```

`pack:npm` 每次先重新构建 GUI，包内包含静态页面、公式字体、界面源文件与第三方声明。源码构建需要开发依赖，安装后的 GUI 不需要 Vite 或网络 CDN。npm 与 GitHub 发行页使用固定安装包分发，普通用户无需本机构建。

源码主线还包含题意保真修复：成员先独立阅读原题，再接收分工与建议；题意冲突会暂停并保留草稿。HTML/SVG 最终截图由同一主模型在独立上下文中审查，界面分别显示版本接纳、图像请求和符合／不符合／不确定判断。首次委派通常至少增加一次准备调用；普通问答仍为 ONE 一次、CoThink 三次。源码安装以提交与安装包摘要标识，不表示 npm 已发布新版本。

首次可直接在设置中保存 API key、自定义服务商与命名 Team；保存不产生试探模型请求。已有 OAuth 可复用，新的 OAuth 登录请在 CLI 使用 `/login`，GUI 不提供完整 OAuth 授权流程。GUI 和 CLI 共用 `COTHINK_HOME`，同一会话不能同时写入。CLI 用 `-r` 选择 GUI 的历史会话；未关联项目的对话持续保持问答权限。

普通对话不隐式授权启动目录。关联项目后可通过现有 Pi 与 agent-sync 读取、修改、检查和接纳；原目录不会自动写回。非空检查和 Shell 必须配置固定镜像摘要的 Docker 环境，不回退宿主 Shell。设置中的 work 为共享配置，对后续任务生效；空检查策略显示“未验证”。界面可查看任务固定起止版本的差异、检查日志，下载包含二进制／删除／执行位的补丁并打开独立成果目录。

关闭页面不会取消任务；刷新仅重新观察已有任务。停止按钮取消整条任务，保留已保存内容。宿主退出会执行取消；崩溃或未知结果不会自动续跑、重发。历史 Team、参与者和费用来自已有记录，缺失内容保持未知。

本地模型机制检查使用 localhost fixture 和实际 Docker，不能据此判断真实模型答案质量或物理中文输入法、人工剪贴板体验；跨平台 CI 与实机证据分别记录。具体证据及限制见 [VALIDATION.md](VALIDATION.md)。

## 安装与启动

GitHub 预览版为 [`0.8.9-native.1`](https://github.com/XSY-28/Cothink-release/releases/tag/v0.8.9-native.1)，尚未发布到 npm。下载该发行页的 `.tgz` 和 `SHA256SUMS`，核对摘要后安装（不要下载 GitHub 自动生成的 Source code 压缩包来代替安装包）：

```sh
curl -fL -o cothink-v2-0.8.9-native.1.tgz https://github.com/XSY-28/Cothink-release/releases/download/v0.8.9-native.1/cothink-v2-0.8.9-native.1.tgz
npm install -g ./cothink-v2-0.8.9-native.1.tgz
cothink --version
```

Windows PowerShell 使用 `npm.cmd` 和 `cothink.cmd`；本轮未提供新的 Windows ZIP，旧 ZIP 保留在历史发行页。原配置、Team、认证和历史继续保留；退出旧进程后重新启动。下方 `npm ...@latest` 安装的是 npm 渠道版本，不等于本 GitHub 预览版。

需要 Node.js ≥22.19、npm 和 Git；项目代码搜索还需要 ripgrep（`rg`）。

该安装包同时包含 CLI 与本地浏览器 GUI。安装后运行 `cothink` 进入终端，运行 `cothink gui` 打开浏览器界面。Windows Terminal + PowerShell 的命令见下方[安装说明](#windows-通过-npm-安装)。

安装 npm 渠道版本：

```sh
npm install -g cothink-v2
```

安装后运行 `cothink`。首次启动会引导你选择主副模型、为 Team 命名并配置认证；已有认证会继续复用。也可以运行 `cothink init` 单独完成设置，或用 `cothink --version` 检查版本。

更新 npm 渠道版本使用同一条命令：

```sh
npm install -g cothink-v2@latest
```

如果全局安装提示权限不足，可安装到自己的目录，并将其加入 PATH：

```sh
npm install -g --prefix "$HOME/.local" cothink-v2
export PATH="$HOME/.local/bin:$PATH"
```

将上面的 `export` 加入 `~/.zshrc`，新终端也会使用该路径。更新前建议保留 `~/.cothink` 的备份；已经打开的旧进程需要退出重开。

### 维护与公开发行入口

此前版本 `0.7.0-auth.2` 包括添加模型时的内联认证（明确复用哪个服务商的认证，缺少 API key 时当场隐藏输入）、终端启动标识，以及 Team/模型长列表的滚动与缩放修复。GitHub 上的 `0.6.0-windows.1` ZIP 继续保留。

唯一开发主线位于私有仓库 [XSY-28/cothink-gui](https://github.com/XSY-28/cothink-gui)，CLI 与 GUI 共用同一核心和根包版本。公开仓库 [XSY-28/Cothink-release](https://github.com/XSY-28/Cothink-release) 只承接按固定版本生成的发行内容，不另行手工维护核心源码。原 CLI 工作目录保留为历史和未提交成果，不作为继续开发入口。

`0.8.1-pi.1` 保留长回复诊断和 Windows 请求记录原子保存修复，并更新到 Pi 1.4.0。公开仓库保留历史发行源码；安装当前版本请使用 npm 或 [GitHub Releases](https://github.com/XSY-28/Cothink-release/releases)，不要把历史源码快照当作当前开发主线。历史验收按版本保存在 VALIDATION.md。

首次设置选择一个主模型、至少一个有序副模型，并为 team 命名。通过 `/team` 复用、创建、调整和删除组合，已有服务商认证继续复用。API Key 隐藏输入，由 Pi 保存到 CoThink 数据根的 `pi/auth.json`；角色配置只保存模型引用。内置服务商不需要手填地址和协议。配置过程不发送生成请求；OAuth 登录可能需要浏览器操作。

旧版只配置主模型的配置仍可在一次性入口通过 `/one` 使用；建立具名 team 时需要至少一个副模型。普通讨论缺少评审时会在首次请求前拒绝。

## 动态 HTML／SVG 盲选测试

源码仓库附带 `scripts/visual-bench.mjs`：同题使用同一条简短提示词，三题九个任务独立并发，离线执行，最后在浏览器匿名选择动态作品。重复轮次、预算、隔离与使用命令见 [测试脚本说明](docs/VISUAL_BENCH.md)。该工具按需调用真实模型；准备和查看不产生模型请求。

## 项目工作如何分工

主副模型须忠实保留原题的主体、动作、对象和关系方向；委派解释与原题冲突时以原题为准，验收先检查题意，再处理视觉和实现细节。未指定思考档位时，支持思考的模型默认使用 `high`，显式选择优先。

主模型在实现前比较自己与当前合法副模型，说明执行者选择及理由。前端默认 Opus 5.5 优先于 Kimi K3.1 Pro，两者都比 DeepSeek 更优先；其他领域参考 GPT-6 Astra、GPT-6.1 Sol、DeepSeek 与 Kimi 的具体任务偏好。默认顺序指向副模型时实际委派；选择自己或偏离默认需说明具体依据。这些是可修订的调度偏好，尚未验证为通用能力排名，也不会自动添加未配置的模型。副模型独立核实方案，按每次请求附带的当前实际权限、固定检查与执行环境完成工作，交接文件、接口、实际检查和未完成项。

工作运行时禁止委派给主模型本身及已知同模型别名；同一模型尚有未处理或结果未知的成员工作时，不能另建分身或通过改派绕过。可收集成果、给出具体反馈，在安全收尾后继续顺序工作。`/one` 由主模型担任唯一 Team 负责人，不调用正式评审或副模型。

成员实际执行、主模型收集整合、检查与接纳都沿用同一 Pi 和 agent-sync 路径。配置了副模型不代表本次已经调用它；请以实际成员记录与成果为准。当前验证证明运行机制，不证明这些分工建议已经带来稳定的 coding 提升。

## 使用 Kimi K3.1 Pro

在终端 `/models` 或 GUI 的模型设置中，选择 Moonshot AI CN（国内）或 Moonshot AI（国际），再选择 `Kimi K3.1 Pro`（ID `kimi-k3.1-pro`）。已有官方 Moonshot API 地址的导入配置也会显示该模型，并复用同一服务商的认证；选择新模型后按原规则另存为新 Team，旧组合不改写。

模型支持 `low`、`high`、`max` 三档，分别对应界面的低、中、高。它始终思考；CoThink 会保留并回传完整 `reasoning_content`，包括多轮工具调用。没有显式设置时仍不发送本地输出 cap；模型服务本身的默认输出限制继续存在。输入上下文与最大输出能力按官方声明登记为 1,048,576 tokens，不表示可以同时占满输入和输出。

本轮接入官方开放平台的标准 Pro，API 根地址为 `https://api.moonshot.cn/v1` 或 `https://api.moonshot.ai/v1`。代理地址、手工定义的同名模型与不同协议配置保留自己的声明，不自动改写。官方 API 账号需满足充值解锁条件，网页会员或赠送代金券不代表此模型的 API 权限。参见 [官方接口与限制](https://platform.kimi.com/docs/guide/kimi-k3-1-pro-quickstart)。

新模型的目录价格尚未可靠固定时，任务费用显示未知，不能按免费或实际账单理解；token 用量与已收到内容照常保存。测试范围及真实调用证据见 VALIDATION.md。

## Windows 通过 npm 安装

安装 Node.js ≥22.19 与 Git for Windows。在 Windows Terminal 的 PowerShell 中运行：

```powershell
npm.cmd install -g cothink-v2
cothink.cmd
```

使用 `.cmd` 入口可以避免 PowerShell 对 `.ps1` 脚本的执行策略限制，无需修改系统执行策略。首次启动会引导设置 Team 和认证；也可先运行 `cothink.cmd init`。更新使用 `npm.cmd install -g cothink-v2@latest`，升级后退出旧窗口并重开。

npm 下载同一个跨平台包，按当前系统准备本地依赖。全局命令应来自当前 npm prefix；可用 `Get-Command cothink.cmd` 检查。数据仍在 `$HOME\.cothink`，安装和升级不删除配置、认证或历史。需要离线包时仍可使用下方 ZIP。

## Windows 下载与启动

到 [v0.7.1-windows.1 发行页面](https://github.com/XSY-28/Cothink-release/releases/tag/v0.7.1-windows.1) 下载与你的系统匹配的 `windows-x64.zip` 或 `windows-arm64.zip`（完整文件名包含版本），并用同页 SHA256SUMS 核对。不要选 GitHub 自动生成的 Source code 压缩包，它不包含离线依赖和启动脚本。

先安装 Node.js ≥22.19 和 Git for Windows。将 ZIP 完整解压，在 Windows Terminal 的 PowerShell 中进入该文件夹：

```powershell
.\install.cmd
.\cothink.cmd init
.\cothink.cmd
```

安装通过 Windows tar.exe 展开随包锁定依赖，不调用 npm、不执行安装生命周期脚本、不联网，也不改 PowerShell 执行策略。所有程序文件在解压目录中，支持中文与空格路径。已有配置和历史继续使用 `$HOME\.cothink`；可用 `$env:COTHINK_HOME = 'D:\CoThink 数据'` 指定其他目录。升级时解压新版本，先退出旧程序，再运行新目录的安装与启动脚本，不删除数据目录。

从实际项目目录启动时，用 `& 'D:\CoThink\cothink.cmd'`，当前项目目录保持不变。Enter 发送，Ctrl+J 换行，Ctrl+Shift+V 粘贴；Shift+Enter 由 Pi 原生 Windows 键盘识别，终端无法区分时请用 Ctrl+J。应用内选区松开后顺序写入 Windows 原生剪贴板，写入完成后才提示成功。

Windows PowerShell 5.1 的中文管道请明确 UTF-8：

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Get-Content -Raw -Encoding UTF8 .\question.txt | & 'D:\CoThink\cothink.cmd'
```

GitHub Actions 验证范围及实际结果见 [VALIDATION.md](VALIDATION.md)。Windows 原生组件与自动化控制台检查不代替中文输入法、实体键盘和各款终端的现场体验。Windows 用户目录的权限依靠 ACL；POSIX 0600/0700 不等同于 Windows ACL。Git 执行位由已有版本保留，新 Windows 文件默认非可执行；Windows 文件系统上的 chmod 不作为执行位变更接纳。Shell 仍在 Linux Docker 中运行，宿主 PowerShell 不获模型执行权限；Windows Docker 环境尚未现场验收。

## 提问、取消与历史

```sh
cothink ask "问题"
cothink ask --one "只用主模型回答"
cothink ask --json "问题"
cat question.txt | cothink > answer.md
cothink history
cothink show <任务ID> --all
```

交互、参数、管道、print 和 JSON 共用完成判断。默认显示完整最终稿；`--all`、`/chat` 与 Ctrl+O 展开初稿、评审、成员、工具原文和状态。明确标题下的评审处理说明默认收起，原始记录和后续模型上下文保留全文；标题无法识别时保留全文。partial、failed、cancelled、unknown 不成功退出，也不展示为最终交付。

长回答显示 `partial` 时，先查看错误中的阶段、模型和停止原因。服务返回 `length` 表示达到输出额度或上下文限制；未指定本地额度时，服务商的默认额度仍可能生效。`--json` 只导出已收到的完整记录，不改变模型额度。需要更长输出时，请检查模型设置中的输出额度；CLI 可按服务商支持范围显式设置，例如 `cothink ask --json --max-output-tokens 32768 "问题"`；该值须符合各参与模型的输出及上下文限制。已接收内容可通过 `cothink show <任务ID> --all` 查看，程序不会自动续写或重试。

若错误为请求记录 `.tmp` 替换 `.json` 时的 `EPERM`，说明保存操作被 Windows 拒绝，并非服务端返回 `length`。本版对临时占用做有限等待后重试同一文件替换；持续权限问题仍会报错，旧记录保留。请保留错误信息排查占用者或目录权限，不必先修改输出 token 额度。

| 命令或按键 | 行为 |
| --- | --- |
| Option+M（Alt+M） | 在输入区切换 ONE / CoThink，保留草稿；运行中只影响下一条 |
| `/one` | 当前对话持续切换为 ONE 单模型模式 |
| `/cothink` | 当前对话切回 CoThink 讨论模式 |
| `/one <任务>` | 仅本条使用主模型，下一条沿用当前对话模式 |
| `/team` | 选择、新建、调整或删除具名模型组合 |
| `/models` | 编辑当前阵容，增加、移除、换主或重排后另起名字保存；原组合保留 |
| `/login`、`/logout` | Pi 认证，使用 CoThink 独立数据根 |
| `/thinking` | 当前模型实际支持的思考档位 |
| `/chat`、Ctrl+O | 零生成调用查看详情；Esc 返回原草稿 |
| `/changelog` | 离线查看 CoThink 完整更新记录；升级后首次启动显示摘要，同一版本不重复 |
| Esc、Ctrl+C | 取消当前整条任务，包括成员和受管工具进程 |
| `/new`、`/resume`、`/fork`、`/tree`、`/reload` | Pi 会话操作；运行中拒绝切换，不自动重发未知请求 |
| Enter | 发送完整输入 |
| Shift+Return、Ctrl+J | 换行；支持扩展编码及 macOS Terminal 的 Escape+Return 编码 |

macOS Terminal 使用此快捷键时，需在“设置 → 描述文件 → 键盘”开启“将 Option 键用作 Meta 键”；GUI 直接识别 Option+M。未开启时终端可能输入 `µ`，程序不会把这个普通字符或粘贴内容当作切换命令。

输入框下方持续显示 `ONE · 单模型` 或 `COTHINK · 讨论`；预算按实际任务更新，临时 `/one <任务>` 完成后回到当前对话模式。模式切换不改变上下文和 Team。恢复、clone、fork、tree 和 reload 按所选历史保留模式，新对话及未记录模式的旧对话默认 CoThink。空会话的选择在首次发送消息后随对话落盘。运行中切换只影响下一条，当前任务的模式与预算已固定。

单模型纯答一次，讨论纯答三次；工作都可能多次调用，ONE 由主模型担任唯一 Team 负责人，不调用正式评审或副模型；CoThink 工作可按需委派正式成员。

新对话 `/new` 继承当前 team；全新进程采用最近一次选择或提交任务时使用的已保存 team。恢复、分支和导入使用各自会话的阵容快照。同一个 team 不共享聊天历史。`/thinking` 调整会话参数，无需给阵容重新命名。

修改阵容后在编辑器选择「保存为新 team」，输入新名字；取消保留原组合。原生模型切换快捷键也使用这个流程。删除前确认名称与阵容，不能删除当前对话选择的 team，且至少保留一个（允许2→1、禁止1→0）。删除不删除模型、认证或历史；旧对话保留独立快照，已删除的组合不会自动回到列表。

Team、模型和服务商菜单的长列表随选中项滚动。用 ↑/↓ 或鼠标滚轮移动，PageUp/PageDown 翻页，Home/End 跳到首尾，Enter 确认，Esc 取消；窗口缩放保留选中项。名称过长时仅缩略显示，选择仍对应完整模型或 team。

终端启动页使用细线 C 和冷蓝方点标识，上横与方点右边缘对齐。至少 80×24 时显示完整标识，较小窗口使用紧凑标题；设置 `NO_COLOR` 时保持单色。

已有 Pi v2 配置首次进入交互界面时，会要求为原阵容命名，升级前备份原字节，保留模型顺序、参数及全局工作/技能配置；取消不会发送问题。无终端的旧 `ask`/管道可暂时沿用原阵容，稍后通过 `cothink init` 升级。旧会话未记录完整 team 时仍可浏览，继续前需明确选择一个 team。

切换主模型时，原主模型会回到副模型列表：选择已有副模型则交换两者的位置；选择名单外的新模型则把原主模型放到副模型第一位。模型已有设置和其他副模型的相对顺序保留；删除模型使用「删除副模型」。

追加模型时，阵容编辑页会说明复用哪个服务商的 API key、OAuth 登录或环境认证。要使用尚未认证的服务商，在模型列表末尾选择「配置服务商或模型」，即可在当前流程输入 API key，输入和提交后的画面都隐藏密钥，无需另去 `/login`。若服务商仅支持 OAuth 或环境认证，则使用其支持的方式。

按 Esc 取消认证会回到原阵容编辑，空白 key 不保存。确认保存的认证按服务商共享；取消后续 Team 编辑不会删除已保存的认证。自定义服务商须使用新的配置 ID，避免改变现有服务商和 Team。认证配置存在不等于 key 的远端权限已验证；添加过程不自动调用模型。

`-c` 继续当前目录最近会话，`-r` 打开选择器。运行时新输入保留为草稿，不自动排队。多行粘贴中的命令文字保留为材料；小于 40×12 时暂停发送。选中文字使用 macOS／Windows 原生剪贴板顺序复制，写入完成后才确认。

直接 `!` Shell 与手动压缩入口仍关闭。工作中的 Shell 使用受管 Pi 工具。

## 安装和查看 Pi 资源包

```sh
cothink install npm:包名
cothink install npm:@scope/包名@1.2.3
cothink install git:https://github.com/owner/repo@ref
cothink install ./my-plugin
cothink install npm:包名 --local
cothink list --json
cothink remove npm:包名
```

从源码运行时，将上面的 `cothink` 替换为 `node bin/cothink.js`。

个人 npm/Git 包保存在当前 `COTHINK_HOME/pi/npm` 或 `pi/git`，同一数据目录的所有 Team 共享。`--local` 使用原项目 `.pi/npm` 或 `.pi/git`；`remove --local` 只移除项目登记。URL 指锁定 Pi 支持的 Git URL，不包括任意归档下载；内嵌凭据请改用 Git credential helper。本地文件或目录沿用原生链接语义，卸载只取消登记，不删除原文件。项目包的明确安装授权保存在 CoThink 数据根，绑定原项目规范路径与登记摘要；复制或生成 `.pi` 不会自动获得授权。管理命令不需要模型配置、API Key 或已命名 Team，不发送生成请求。

安装会联网下载文件，并按 npm 原生方式执行根包和依赖的生命周期脚本；安装本身不 import 扩展来检查兼容性。脚本属于用户主动选择运行的代码，受管候选回退不能撤销任意宿主副作用。实际精确版本及 npm lockfile 会保留；再次安装同一精确版本会先核验现有文件，无版本或 tag 的显式安装可选择新版本，没有后台更新。安装/卸载前须退出使用同一数据目录的全部 CoThink 窗口，包括空闲会话；`list` 可在会话打开时执行且不联网、不补装。

可用的 skill 正文、Markdown 提示模板和 JSON 主题会在下次启动时载入。普通问答仍由一位评审完成三次调用，`/one` 一次；显式 `/skill:名称` 与模板使用现有入口。手工 `piResources` 保留，同名不同来源或覆盖 `/team`、`/models` 等本地命令的资源会在发布前报错。包资源不能引用包外路径或符号链接。

显式安装的 JavaScript 扩展按 Pi 原生接口加载，不要求固定 UI 哈希白名单。安装与加载不代表工具已接入项目成果管理。普通问答不开放原生工作工具；本地插件命令在任务外执行，若尝试启动未绑定模型工作会明确拒绝。已适配原生工具复用 Pi 动态注册表，在独立副本中执行；有文件变化时须明确审阅后导入。插件代码受用户安装选择信任，不能声称受 agent-sync 全面沙箱保护。

失败和取消会保留候选及私有日志路径；不会自动重发安装。若提交中断，程序停止加载包；退出会话后下一次明确的 `install`/`remove` 会先核验备份并恢复上一稳定状态。证据不完整或目录被另行修改时会保留现场并报恢复错误。历史查询仍使用已保存的请求和技能正文，删除包不删除历史。

## 执行项目工作

在有 HEAD 提交的 Git 项目中启动并描述实际修改。主模型在首次请求中选择进入工作，无额外分类请求。`/one <任务>` 沿用同一版本流程，由主模型担任唯一 Team 负责人。

每位执行者使用 agent-sync 的独立源码投影。写范围冲突在执行前等待，读快照不占写锁；已知范围可以直接声明，未知时先观察。领导可亲自工作，collect先返回可处理成果；成员不创建正式 Team 委派。原目录未提交内容不自动进入起点，原用户目录不覆盖。非Git或无HEAD目录明确拒绝。

文件工具读取权威tree，写入有旧内容前提并整批原子提交；候选固定后仍可修订。领导审阅已展示内容后可直接accept_change，宿主负责候选ID。反馈保留原草稿/会话；具体依据或范围变化通过refresh_change保留成果并反馈差异，不靠重造patch解决。

默认采用项目声明的 npm test；可配置容器内固定检查命令和执行环境：

```json
"work": {
  "checks": [{ "command": "node", "args": ["--test"] }],
  "execution": {
    "engine": "docker",
    "image": "node@sha256:0e5f906573693feaa1e21057ebdcfdb5bd5021f050b2dc7c9deceb629c7da2a8",
    "network": "none",
    "limits": { "memoryBytes": 4294967296, "cpus": 2, "pids": 256 },
    "artifactPaths": ["node_modules"]
  }
}
```

纯文件操作不要求Docker。Shell和非空正式检查需要可用的本机Docker引擎、固定镜像及其工具/依赖；首次Shell才创建容器，同一修改复用。网络默认关闭，项目依赖需宿主预置到固定镜像，不能借用成员放入的node_modules作可信检查。宿主绝对命令、秘密env、任意挂载和宿主Shell回退不支持。未配置/不可用会报告具体环境缺口，不影响问答或只读历史。

Shell是Linux隔离环境，工具交接暂停全部进程，后台服务可跨命令使用；不承诺macOS专属编译/GUI/宿主权限。非法或越界源变化整体拒绝并保留现场，明确resetExecution才封存后恢复。长日志使用read的 output:<outputRef> 入口，offset/limit仍按行；日志路径不能写入或作为源码搜索。

最新组合满足固定检查后，唯一正式ref才条件更新；空策略明确unverified。响应未知只能查询原请求，不能换ID重发。最终给出实际版本、检查和只读成果目录；写回原分支仍需明确Git操作。

元数据默认位于 COTHINK_HOME/agent-sync，旧 projects 留作历史解释。新写路径不会自动接管已有项目；先处理所有旧open/prepared/unknown记录，再明确迁移：

```sh
cothink migrate-work /absolute/project --json
# 没有任何新接纳时，才允许显式回退元数据；不会reset历史
cothink migrate-work /absolute/project --rollback --json
```

迁移保存原元数据、回执、修改和引用快照，停用旧写入口，再登记原正式ref。数据损坏、缺ref、旧请求未决或活跃writer都会停止。旧安装对迁移项目的写入被阻止，旧只读事实仍可查。已有新接纳后必须沿新历史修复，不能简单换回旧程序继续写。

原生 skills、模板和显式选择的扩展保留。扩展来源哈希用于追溯，不作为逐包放行白名单。普通原生工具经工作适配器使用独立副本，本地命令零模型调用；选中资源不授予额外写权限，候选中的 .pi 也不自动加载。兼容边界和源码/localhost/安装/PTY/真实模型证据见 VALIDATION.md。

## 数据与旧配置

数据根默认 `~/.cothink`，可用 `COTHINK_HOME` 指定。新数据分别存于 `pi/`、`tasks/`、`requests/`、`projects/`。旧 `runs/` 与会话记录继续只读可查，不自动恢复执行。

旧格式配置须显式导入：

```sh
cothink init --import-legacy
```

导入先备份原字节，再保存 Pi 认证和模型引用。回退时恢复保留的旧程序和对应旧配置，保留新旧历史；若配置在切换后又被修改，先核对差异，不强制覆盖。不要把认证文件或私有备份提交到仓库。

## 选择 Pi 资源

不自动继承 `~/.pi` 的全部设置。可在现有配置添加明确的本地资源路径：

```json
"piResources": {
  "skills": ["/absolute/path/to/skill"],
  "extensions": ["/absolute/path/to/extension.ts"]
}
```

`skills` 是普通自然语言问答的预载来源，默认不启用任何技能。配置路径后，每条任务会将其中允许自动调用的技能主文件正文加入实际模型上下文，主模型按当前目标与描述判断是否适用，无需 `/skill:`。普通纯答仍是三次，`/one` 仍是一次；技能不会扩大工具权限或构成执行授权。

每条任务冻结同一份内容供初稿、评审、修订使用；下一条才读取文件更新。只加载主文件，不递归读取引用或执行脚本；正文增加输入用量，不截断或自动重试。文件缺失、无效元数据、空目录及不同文件同名会在生成前报错，真实文件重复路径去重。`disable-model-invocation: true` 不自动预载。

`/skill:name`（包括 `/one /skill:name`）优先使用 Pi 原生显式展开，本条不再叠加自动预载列表，禁用自动调用的技能仍可显式使用。`/chat`、Ctrl+O、`show ID --all` 可查看已预载的名称、来源和哈希；这只表示已提供材料，不代表模型已使用。`show ID --json` 的原请求保留正文，旧任务不受技能文件之后的修改影响。恢复和查看本身不生成。

另有 `prompts`、`themes` 路径数组。主会话加载选定资源；普通工作动态发现已安装工具，无需手工枚举工具名。旧 `piResources.tools` 不会绕过工作授权，建议移除该字段。准备、冲突确认和普通纯答不开放原生工具；宿主 read/write/start_work 等名称不得被扩展覆盖。注册替换遵循锁定 Pi 的调用快照：在 tool_call 中替换同名定义，后续调用使用新定义，已进入的调用仍使用其原定义。

原生工具及工作生命周期的 `ctx.cwd` 是独立副本；文件变化保留为 nativePluginResultId，由创建者明确审阅、导入或拒绝，沿用公共 edit、审阅与接纳。宿主写入后，干净副本从当前正式私有版本刷新；有未处理差异或旧输入时明确阻断。普通异步工具的 Promise 返回仅证明该次受观察调用结束，不证明任意脱离的后台 JavaScript 或进程已停止；这类路径不在通用兼容承诺内。

CLI 本地插件命令使用 Pi 原入口；GUI 输入框中的已注册命令或“插件命令”按钮走相同零生成分派。“重载插件”或终端 `/reload` 在空闲时重新加载本地入口与相对 JavaScript 模块；失败阻止新生成并保留历史。Pi/Jiti 的窄兼容补丁保留模块来源、顶层 await 与 SDK 共享身份，见 THIRD_PARTY_NOTICES.md。

GUI 映射通知、状态、select/input/confirm（取消与插件显式提示超时）；会话／任务关闭会结束待答提示。文字小组件可显示；原生被动装饰仅显示未渲染警告，不运行组件工厂。主动 custom/editor、终端输入及自定义编辑器等接口明确报 EXTENSION_UI_UNSUPPORTED，使用交互终端入口。非交互 ask 维持 Pi 的 hasUI=false，不宣称显示了对话框。历史加载/注册结果不构成任意插件兼容承诺。

模型文件工具限于各自副本与选定技能资源。工作中的脚本执行沿用已配置的固定断网 Docker 环境，不回退宿主 Shell。技能主文件及明确引用的资源复制到任务材料，不递归复制其任意上级目录；缺失资源明确报告。实际工具调用、插件报告用量和未知费用分别保存。第三方任意 JavaScript 副作用不在本地验证保证范围内。

## 调用与验证规则

- 默认不设本地模型超时或可省略的输出额度；`--timeout MS`、`--max-output-tokens N` 可显式设置，运行前展示实际政策。协议必填额度须配置，按模型配置的显式额度也会传到实际请求。
- 自动重试、压缩、预热关闭。未知请求不重发；纠错须有具体反馈。接纳结果未知时查询既有 requestId，不用新 ID 重做。
- 请求意图和工具意图先保存；保存失败则停止副作用。用量缺失保持未知，目录费用估算与账单区分，未知费用为 null。
- 源码与安装包的 localhost fixture、PTY、真实模型和用户现场检查属于不同证据层；具体版本及限制见 [VALIDATION.md](VALIDATION.md)。各版本 CI、安装与物理平台证据分别记录，不能相互替代。

源码验证与固定依赖重建：

```sh
npm test
npm run test:pi-terminal
npm run build:pi
```

Pi 来源、固定补丁和产物哈希在 `vendor/pi-patches/`，许可说明在 `THIRD_PARTY_NOTICES.md`。重建使用固定源码与已发布目录数据，不刷新为最新模型目录。源码中的 `archive/agent-sync-git-20261019/` 只保留迁移测试所需的旧实现夹具，发行包与当前执行入口均不导入它。

## 许可证

CoThink 原创代码与仓库内 agent-sync 内核采用 [MIT](LICENSE)。第三方依赖保留各自许可证，固定 Pi 补丁、来源和许可说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。


### 新版本提醒

交互 CLI 和 GUI 就绪后默认在后台检查 `https://registry.npmjs.org/cothink-v2/latest`，每个数据目录 24 小时内自动尝试一次（失败也计入间隔）。请求不携带模型密钥、npm token、对话或项目内容，检查不调用模型；非交互 ask、管道、history、show 和帮助不会自动查新。查新以 npm latest 为准，可能包含发布者明确推荐的预发布版本。

- CLI：`/updates` 查看版本、最近检查时间、官方说明和更新指引，手动检查或切换自动检查。
- 无模型配置时：`cothink check-update`；脚本使用 `cothink check-update --json`，成功检查返回 0，检查不可用返回 1。
- GUI：顶部“有新版本”提示打开设置的“可用更新”；也可直接从设置检查。提示不抢焦点、不清草稿；“本地更新记录”仍只说明已安装版本。
- 停用自动检查：在面板关闭开关，或设置 `COTHINK_NO_UPDATE_CHECK=1`。显式 `PI_OFFLINE=1` 禁止包括手动在内的全部查新。开关保存在 `COTHINK_HOME/update-state.json`，与 Team、认证和本地摘要已读状态分开。

一次查新只发送一个 GET，不重试；总期限 5 秒（含响应体）、最大 256 KiB、拒绝重定向。网络失败时继续使用，手动界面显示失败与带时间的旧缓存。状态损坏或不可写时保留原件，本次进程停用自动检查；手动结果只在内存可用，保存失败不会显示“已保存”。已打开的界面在下一次任务提交或 GUI 获得焦点时再检查是否到期，不运行常驻定时服务；多个进程恰好同时首次启动可能各发一次请求。

按原安装方式选择指引：npm 全局安装显示经过验证的精确版本命令（Windows 为 `npm.cmd`）；自定义 prefix 沿用原 prefix。Windows ZIP 从[官方 Releases](https://github.com/XSY-28/Cothink-release/releases)选适配架构，退出旧进程，在新目录安装启动，保留数据目录；源码或托管目录按原方式更新。所有命令仅供阅读/复制，CoThink 不执行下载、安装、目录替换或重启。npm 推荐版本可发现不代表所有平台资产均已核实可用。旧版用户需先手动安装一次含此功能的版本，以后才有提醒。

## HTML/SVG 制作与视觉检查（本地开发，尚未发布）

已有 Git 项目中可用 `cothink make-html --one "制作任务"`；省略 `--one` 使用 CoThink。持续终端用 `/make-html <任务>`，继承当前 ONE/CoThink；GUI 使用发送旁的“制作HTML/SVG”。这是单条制作要求，不是第三种对话模式。输入中的引用、代码块不作为制作动作；CLI 管道保留多行原文。没有关联项目时先选择项目，草稿保留，不自动初始化 Git。

提交前需要：支持图片的主模型、显式配置的适用技能、Docker 和已核验的预览镜像。技能通过 `piResources.skills` 指定 SKILL.md 主文件或已有受管包，任务冻结名称、正文和 SHA-256；不会扫描个人目录补齐。CoThink 的实际制作成员也必须支持图片。示意配置需合并进现有配置，不替换 Team/认证：

```json
{
  "piResources": {"skills": ["/绝对路径/frontend-design/SKILL.md"]},
  "work": {
    "checks": [],
    "execution": {
      "engine": "docker",
      "image": "从 docker/visual-preview-manifest.json 读取实际 image 字段",
      "network": "none",
      "limits": {"memoryBytes": 2147483648, "cpus": 2, "pids": 256},
      "artifactPaths": []
    }
  }
}
```

问答仍为 ONE 一次、CoThink 三次；制作直接进入工作，调用次数不设上限，不额外调用分类模型。输出额度按已有模型配置，不新增默认模型超时。`preview_html` 在断网容器内服务 HTML/SVG 及本地资源，可指定视口、最多三帧和六步 click/fill/key；没有任意 evaluate 接口。预览操作的 30 秒技术上限用于清理失控页面，不是模型请求超时。实际采样时间是墙钟时间，不是精确动画仿真。

截图作为 PNG 进入同一 Pi 请求路径。最终接纳后，宿主为确定的集成版本再截图并送回主模型；有修订则检查新版本。图片未发送、截图失败、页面错误或未知请求不能冒称视觉检查完成；已接纳内容不会回滚。截图保存在数据根 `artifacts/<taskId>/<requestId>/`，GUI“检查”页按任务鉴权读取，CLI 输出本地证据链接。候选/历史截图与最终版本检查分开显示。

这些都是 **CoThink 调用方能力**。agent-sync 内核、依赖、权限与恢复合同未修改：其无内容变化的 exec 仍可能产生新 privateVersion。调用方保存执行前后版本，并通过公共 inspect 的空差异证明内容未变；最终检查 change 随后结束，不把操作记账提交作为产品修改接纳。

### 预览镜像的来源与重建

当前实测平台为 Linux ARM64（macOS Docker Desktop），锁定 Node 基础镜像、Playwright 1.64.1、Chromium Headless Shell 156.0.8078.4 / revision 1248。镜像 digest、脚本 SHA-256 和浏览器资产 SHA-256 见 `docker/visual-preview-manifest.json`；实际 Debian 包版本清单见 `docker/visual-preview-packages.lock`。镜像不在模型任务运行中下载，也不包含在 npm 包里。Windows Docker / Linux x64 尚未实测，不承诺已有对应镜像。

从锁定依赖的源码准备以下构建上下文：`playwright-core/` 来自 `node_modules/playwright-core/`，`visual-preview.mjs` 来自 `scripts/visual-preview.mjs`，`chromium_headless_shell-1248/` 包含解压后的 `chrome-headless-shell-linux-arm64/`。浏览器资产为 [官方 Linux ARM64 Headless Shell](https://cdn.playwright.dev/builds/cft/156.0.8078.4/linux-arm64/chrome-headless-shell-linux-arm64.zip)，SHA-256 必须是 `81ab9d4d3c301dc5fdfb6c541b9e6632b16fc819a6a854460f40a76fe2b2c476`。不要使用宿主 macOS 浏览器目录。

使用 `docker build -f docker/visual-preview.Dockerfile -t cothink-visual-preview:local <上述上下文目录>` 构建。Dockerfile 在构建阶段安装 Debian 签名包与字体；清单记录本次实际版本，不承诺未来镜像源仍供应所有相同包。重建后必须核对包清单、实际 image digest、renderer SHA-256，更新锁定清单并运行 `npm run test:visual`；不能仅更换配置中的 digest 而宣称通过。已有核验镜像可用 Docker 的 save/load 原样转移，不需重新构建。

新视觉 benchmark 的 `prepare` 冻结相同制作合同、技能源文件字节、镜像和预览能力。`run` 仍是会发送模型请求的独立动作，须另行授权；新制作轮次不自动重试。旧轮次只查看/报告，不回写旧成果、盲选顺序或选票。

GitHub Linux ARM64 CI 使用 `node scripts/build-visual-preview.mjs` 在构建阶段取得锁定的 Linux 浏览器资产、构建固定镜像，并记录该次构建的实际 digest/包清单后再验证。此脚本不由模型运行时调用；其他平台可提供已核验的 Linux ARM64 上下文 `--context <目录>`。CI 结果绑定各次实际构建，不假定不同机器一定产生同一 digest。

角色、工具使用、版本和失败处理的控制提示词使用英文；用户原题、委派材料、反馈和技能正文保留原文。自然语言回复遵循用户语言，界面识别的“## 对评审意见的处理说明”标题保持中文。成员只在实际授权内工作并交接，主模型及宿主负责授权调整、接纳和最终集成版本检查。语言改写经过机制回归，不代表英文已被真实模型对照证明更有效。
