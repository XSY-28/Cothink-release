# CoThink

CoThink 是一个多模型协作工具，旨在让不同模型组成团队，通过讨论、相互检查和分工协作，获得更好的回答与任务成果。

CoThink 基于 Pi 开发，可复用 Pi 社区的技能（Skills）、提示模板和主题。其他插件需完成兼容适配后使用，具体范围见下方的[包管理说明](#安装和查看-pi-资源包)。

项目仍在早期预览阶段，支持 macOS 与 Windows（x64 / ARM64），可通过 npm 安装；Windows 也提供 ZIP 下载包。项目仍有一些 bug 和不完善之处。欢迎通过 [Issues](https://github.com/XSY-28/Cothink-release/issues) 反馈问题、分享使用体验或提出改进建议。

## 安装与启动

需要 Node.js ≥22.19、npm 和 Git。

当前 npm `latest` 为 `0.6.0-windows.2`。Windows Terminal + PowerShell 的命令见下方[安装说明](#windows-通过-npm-安装)。

安装最新版：

```sh
npm install -g cothink-v2
```

安装后运行 `cothink`。首次启动会引导你选择主副模型、为 Team 命名并配置认证；已有认证会继续复用。也可以运行 `cothink init` 单独完成设置，或用 `cothink --version` 检查版本。

更新到最新版使用同一条命令：

```sh
npm install -g cothink-v2@latest
```

如果全局安装提示权限不足，可安装到自己的目录，并将其加入 PATH：

```sh
npm install -g --prefix "$HOME/.local" cothink-v2
export PATH="$HOME/.local/bin:$PATH"
```

将上面的 `export` 加入 `~/.zshrc`，新终端也会使用该路径。更新前建议保留 `~/.cothink` 的备份；已经打开的旧进程需要退出重开。

### 从源码运行

当前版本 `0.6.0-windows.2` 包括持续对话模式、Windows 适配及 npm 安装兼容修复。GitHub 上的 `0.6.0-windows.1` ZIP 继续保留。

GitHub 仓库和发行下载公开可读。

```sh
git clone https://github.com/XSY-28/Cothink-release.git
cd Cothink-release
npm ci --ignore-scripts
node bin/cothink.js
```

首次设置选择一个主模型、至少一个有序副模型，并为 team 命名。通过 `/team` 复用、创建、调整和删除组合，已有服务商认证继续复用。API Key 隐藏输入，由 Pi 保存到 CoThink 数据根的 `pi/auth.json`；角色配置只保存模型引用。内置服务商不需要手填地址和协议。配置过程不发送生成请求；OAuth 登录可能需要浏览器操作。

旧版只配置主模型的配置仍可在一次性入口通过 `/one` 使用；建立具名 team 时需要至少一个副模型。普通讨论缺少评审时会在首次请求前拒绝。

## Windows 通过 npm 安装

安装 Node.js ≥22.19 与 Git for Windows。在 Windows Terminal 的 PowerShell 中运行：

```powershell
npm.cmd install -g cothink-v2
cothink.cmd
```

使用 `.cmd` 入口可以避免 PowerShell 对 `.ps1` 脚本的执行策略限制，无需修改系统执行策略。首次启动会引导设置 Team 和认证；也可先运行 `cothink.cmd init`。更新使用 `npm.cmd install -g cothink-v2@latest`，升级后退出旧窗口并重开。

npm 下载同一个跨平台包，按当前系统准备本地依赖。全局命令应来自当前 npm prefix；可用 `Get-Command cothink.cmd` 检查。数据仍在 `$HOME\.cothink`，安装和升级不删除配置、认证或历史。需要离线包时仍可使用下方 ZIP。

## Windows 下载与启动

到 [v0.6.0-windows.1 发行页面](https://github.com/XSY-28/Cothink-release/releases/tag/v0.6.0-windows.1) 下载与你的系统匹配的 `windows-x64.zip` 或 `windows-arm64.zip`（完整文件名包含版本），并用同页 SHA256SUMS 核对。不要选 GitHub 自动生成的 Source code 压缩包，它不包含离线依赖和启动脚本。

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

| 命令或按键 | 行为 |
| --- | --- |
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

输入框下方持续显示 `ONE · 单模型` 或 `COTHINK · 讨论`；预算按实际任务更新，临时 `/one <任务>` 完成后回到当前对话模式。模式切换不改变上下文和 Team。恢复、clone、fork、tree 和 reload 按所选历史保留模式，新对话及未记录模式的旧对话默认 CoThink。空会话的选择在首次发送消息后随对话落盘。运行中切换只影响下一条，当前任务的模式与预算已固定。

单模型纯答一次，讨论纯答三次；工作都可能多次调用，ONE 仅主模型独自工作、不评审或委派，CoThink 工作可按需委派。

新对话 `/new` 继承当前 team；全新进程采用最近一次选择或提交任务时使用的已保存 team。恢复、分支和导入使用各自会话的阵容快照。同一个 team 不共享聊天历史。`/thinking` 调整会话参数，无需给阵容重新命名。

修改阵容后在编辑器选择「保存为新 team」，输入新名字；取消保留原组合。原生模型切换快捷键也使用这个流程。删除前确认名称与阵容，不能删除当前对话选择的 team，且至少保留一个（允许2→1、禁止1→0）。删除不删除模型、认证或历史；旧对话保留独立快照，已删除的组合不会自动回到列表。

Team、模型和服务商菜单的长列表随选中项滚动。用 ↑/↓ 或鼠标滚轮移动，PageUp/PageDown 翻页，Home/End 跳到首尾，Enter 确认，Esc 取消；窗口缩放保留选中项。名称过长时仅缩略显示，选择仍对应完整模型或 team。此菜单修复已合入源码主线，尚未包含在上述 npm 版本中。

源码主线的终端启动页使用细线 C 和冷蓝方点标识，上横与方点右边缘对齐。至少 80×24 时显示完整标识，较小窗口使用紧凑标题；设置 `NO_COLOR` 时保持单色。新标识也尚未发布到 npm。

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
cothink list --json
cothink remove npm:包名
```

从源码运行时，将上面的 `cothink` 替换为 `node bin/cothink.js`。

包保存在当前 `COTHINK_HOME/pi/npm`，同一数据目录的所有 Team 共享。管理命令不需要模型配置、API Key 或已命名 Team，不发送生成请求。首版只支持 npm 来源；不支持本地路径、Git、URL 或 `--local`。

安装会联网下载文件，关闭根包和依赖的 npm 生命周期脚本，不执行扩展来检查兼容性。实际精确版本及 npm lockfile 会保留；再次安装同一精确版本会先核验现有文件，无版本或 tag 的显式安装可选择新版本，没有后台更新。安装/卸载前须退出使用同一数据目录的全部 CoThink 窗口，包括空闲会话；`list` 可在会话打开时执行且不联网、不补装。

可用的 skill 正文、Markdown 提示模板和 JSON 主题会在下次启动时载入。普通问答仍由一位评审完成三次调用，`/one` 一次；显式 `/skill:名称` 与模板使用现有入口。手工 `piResources` 保留，同名不同来源或覆盖 `/team`、`/models` 等本地命令的资源会在发布前报错。包资源不能引用包外路径或符号链接。

未知 JavaScript 扩展会显示「未启用，需要适配 agent-sync」，同包独立数据资源仍可使用。subagent/agent-teams 包禁止安装和加载。文本可读不代表其脚本、外部服务或原生依赖可执行；本功能不保证所有 Pi 插件兼容。包不会改变 Team、认证、工具权限或工作隔离规则。

失败和取消会保留候选及私有日志路径；不会自动重发安装。若提交中断，程序停止加载包；退出会话后下一次明确的 `install`/`remove` 会先核验备份并恢复上一稳定状态。证据不完整或目录被另行修改时会保留现场并报恢复错误。历史查询仍使用已保存的请求和技能正文，删除包不删除历史。

## 执行项目工作

在有 HEAD 提交的 Git 项目中启动并描述实际修改。主模型在首次请求中选择进入工作，无额外分类请求。`/one <任务>` 使用同一工具和版本流程独自工作。

每位执行者使用 agent-sync 的独立源码投影。写范围冲突在执行前等待，读快照不占写锁；已知范围可以直接声明，未知时先观察。领导可亲自工作，collect先返回可处理成果；成员不能递归委派。原目录未提交内容不自动进入起点，原用户目录不覆盖。非Git或无HEAD目录明确拒绝。

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

原生skills、模板和已审查纯UI资源保留。第三方JS须在加载前审核；当前允许固定哈希的orca-prefill纯UI文件，未适配的pi-web-access克隆/缓存、MCP服务器、plannotator和自有模型循环扩展拒绝加载。选中一个工具名不授予宿主写权限，候选中的.pi也不自动加载。兼容边界和源码/localhost/安装/PTY/真实模型证据见 VALIDATION.md。

## 数据与旧配置

数据根默认 `~/.cothink`，可用 `COTHINK_HOME` 指定。新数据分别存于 `pi/`、`tasks/`、`requests/`、`projects/`。旧 `runs/` 与会话记录继续只读可查，不自动恢复执行。

旧格式配置须显式导入：

```sh
cothink init --import-legacy
```

导入先备份原字节，再保存 Pi 认证和模型引用。回退时恢复保留的旧程序和对应旧配置，保留新旧历史；若配置在切换后又被修改，先核对差异，不强制覆盖。不要把认证文件或私有备份提交到仓库。

## 选择 Pi 资源

不自动继承 `~/.pi` 的全部设置。可在现有配置添加本地资源路径和明确工具名：

```json
"piResources": {
  "skills": ["/absolute/path/to/skill"],
  "extensions": ["/absolute/path/to/extension.ts"],
  "tools": ["fetch_content"]
}
```

`skills` 是普通自然语言问答的预载来源，默认不启用任何技能。配置路径后，每条任务会将其中允许自动调用的技能主文件正文加入实际模型上下文，主模型按当前目标与描述判断是否适用，无需 `/skill:`。普通纯答仍是三次，`/one` 仍是一次；技能不会扩大工具权限或构成执行授权。

每条任务冻结同一份内容供初稿、评审、修订使用；下一条才读取文件更新。只加载主文件，不递归读取引用或执行脚本；正文增加输入用量，不截断或自动重试。文件缺失、无效元数据、空目录及不同文件同名会在生成前报错，真实文件重复路径去重。`disable-model-invocation: true` 不自动预载。

`/skill:name`（包括 `/one /skill:name`）优先使用 Pi 原生显式展开，本条不再叠加自动预载列表，禁用自动调用的技能仍可显式使用。`/chat`、Ctrl+O、`show ID --all` 可查看已预载的名称、来源和哈希；这只表示已提供材料，不代表模型已使用。`show ID --json` 的原请求保留正文，旧任务不受技能文件之后的修改影响。恢复和查看本身不生成。

另有 `prompts`、`themes` 路径数组。主会话加载选定资源，工作领导只启用列出的扩展工具；成员使用独立资源集。原生技能的加载、reload 和命令展开已有检查。扩展须通过当前宿主的加载前审查；当前未适配的 pi-web-access、MCP adapter、plannotator 及自有模型循环扩展均拒绝加载。历史版本的加载/注册结果不能作为当前兼容承诺。

不安装或加载 subagent / agent-teams 插件；委派直接使用项目内 Pi SDK 会话。

## 调用与验证规则

- 默认不设本地模型超时或可省略的输出额度；`--timeout MS`、`--max-output-tokens N` 可显式设置，运行前展示实际政策。协议必填额度须配置，按模型配置的显式额度也会传到实际请求。
- 自动重试、压缩、预热关闭。未知请求不重发；纠错须有具体反馈。接纳结果未知时查询既有 requestId，不用新 ID 重做。
- 请求意图和工具意图先保存；保存失败则停止副作用。用量缺失保持未知，目录费用估算与账单区分，未知费用为 null。
- 源码与安装包的 localhost fixture、PTY、真实模型和用户现场检查属于不同证据层；具体版本及限制见 [VALIDATION.md](VALIDATION.md)。尚无 CI、异机或跨平台实机结论。

源码验证与固定依赖重建：

```sh
npm test
npm run test:pi-terminal
npm run build:pi
```

Pi 来源、固定补丁和产物哈希在 `vendor/pi-patches/`，许可说明在 `THIRD_PARTY_NOTICES.md`。重建使用固定源码与已发布目录数据，不刷新为最新模型目录。源码中的 `archive/agent-sync-git-20261019/` 只保留迁移测试所需的旧实现夹具，发行包与当前执行入口均不导入它。

## 许可证

CoThink 原创代码与仓库内 agent-sync 内核采用 [MIT](LICENSE)。第三方依赖保留各自许可证，固定 Pi 补丁、来源和许可说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
