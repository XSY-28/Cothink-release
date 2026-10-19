# agent-sync

独立的本地协作版本工具。多个执行者可以申请写范围，读取固定输入，私下编辑，再把经过检查的结果接纳到一条正式历史。读快照不阻塞写者；写范围重叠时等待，独立范围并行。

支持 Node.js ≥22.19、Git，以及需要执行命令时的本机 Docker Desktop Linux 容器。首次验证平台为 Apple silicon macOS + Linux arm64。包只使用 Node 内置模块；纯文件编辑、历史查询不需要 Docker、Pi、模型或 API Key。

## JS 使用

项目须已有 Git 提交；工具不替用户初始化仓库。`home` 是仓库之外的私有数据目录。正式结果保存在工具报告的 `integrationRef`，原工作目录和分支不自动覆盖。

```js
import { createAgentSync } from '@cothink/agent-sync';

const v = await createAgentSync({ project: '/absolute/project', home: '/absolute/sync-data' });
try {
  const c = await v.beginChange({
    requestId: 'begin-1', actor: 'writer', intent: '更新说明', scope: ['README.md'],
  });
  const old = await v.read({ changeId: c.changeId, path: 'README.md' });
  await v.edit(c.changeId, {
    requestId: 'edit-1', expectedVersion: c.privateVersion,
    edits: [{ path: 'README.md', oldHash: old.contentHash,
      contentBase64: Buffer.from('# 新说明\n').toString('base64') }],
  });
  const p = await v.prepareChange(c.changeId, { requestId: 'prepare-1' });
  const r = await v.acceptChange({
    changeId: c.changeId, candidateVersion: p.candidateVersion, requestId: 'accept-1',
  });
  console.log(r);
} finally { await v.close(); }
```

运行前保存 mutation 的 requestId。重用相同 ID/输入会返回原事实；不同输入会被拒绝。`unknown` 时先 `inspect({requestId})`；`not_found` 也不能证明未执行，不自动重发未知动作。

空检查策略保存为 `verification: "unverified"`。它只表示版本已保存，没有业务测试通过的含义。

## Shell 与正式检查

宿主提供固定配置；调用者不能通过命令修改镜像、挂载、网络、宿主环境或资源上限：

```js
const execution = {
  engine: 'docker',
  image: 'node@sha256:<实际拉取的64位digest>',
  network: 'none',
  limits: { memoryBytes: 4294967296, cpus: 2, pids: 256 },
  artifactPaths: ['node_modules'],
};
const v = await createAgentSync({
  project, home, execution,
  checks: [{ command: 'node', args: ['--test'] }],
});
const r = await v.exec(changeId, {
  requestId: 'command-1', expectedVersion: privateVersion,
  command: 'printf done > a.txt; printf warning >&2; exit 7',
}, { signal, onData: bytes => process.stdout.write(bytes) });
```

命令文本原样交给容器 Bash；输出按字节流传回，完整日志通过 `read({outputRef,offset,limit})` 分页。非零退出保留合法修改与实际 exitCode。工作容器按修改懒创建并复用，交接时暂停全部进程；后台服务可以跨命令使用。每条命令不继承上一条 Shell 的临时 export。

容器只得到 `readScope ∪ scope` 的源码投影和声明的辅助产物，默认 `readScope: ["."]`。任意 Shell 都保守登记可见范围的基线，可能要求刷新较宽的依据。正式检查使用全项目组合快照和独立干净容器；检查修改源码会失败，依赖产物不会从工作容器直接带入检查。

镜像须包含 Bash、Node 和所需工具。网络关闭；项目依赖必须事先准备在固定镜像中。没有可用引擎/镜像时明确失败，不能回退到宿主 Shell。动态联网安装、私有 registry、宿主 API、嵌套 Docker、macOS GUI/专属构建不在当前支持范围。检查配置不接受环境变量或秘密，容器环境固定。

Docker exec 使用同一个 Docker 引擎的 Exec API，保存 exec ID 并查询真实退出状态；启动/停止/暂停与镜像管理使用参数数组调用 CLI。宿主只连接当前 context 的本地 Unix socket，容器得不到 socket。宿主进程失联时，私有 stdin 通道 EOF 会结束运行中的容器；已暂停容器先保持无写者，重新打开写实例时确认清理。

## 继续修改与恢复

- `prepareChange` 固定候选，之后仍可编辑同一草稿；旧候选保持可查。预检使用 `{check:true}`。
- `basis_changed` 返回实际变化路径和版本。宿主审核后调用 `refreshChange(changeId,{requestId,reason})`，保留已有草稿并三方换基；文本冲突保留两侧和反馈。
- 扩大范围用同一 refresh 操作传 `scope`；先保存并释放，再整组申请。新范围须包含全部未接纳修改。
- 越界/非法源产物使整个 Shell 导入失败，现场保留且后续命令被阻止。明确 `refreshChange(...,{resetExecution:true,reason})` 才封存未导入环境并从已确认草稿继续。手工改投影也先保存证据，不能偷偷接纳。
- `abandonChange` 终止相关容器后释放范围，保留版本/失败资料。`close` 必须 await；重新打开后旧授权失效，原草稿须显式 refresh 才能继续。

同一项目只有一个本地写 owner，不能靠墙钟到期抢占活进程。不同 `home` 也不能同时写。显式登记现有 `integrationRef` 会保留该引用和历史；移交方负责停止旧写者。正式 ref 不能被其他工作区 checkout 后由本工具推进。

## 查询历史

```js
await v.inspect();
await v.inspect({ changeId });
await v.inspect({ requestId: 'accept-1' });
await v.inspect({ history: { limit: 20, cursor } });
await v.inspect({ fromVersion, toVersion });
await v.read({ version, path: 'a.txt' });
await v.read({ changeId, path: '.', kind: 'tree' }); // 搜索前登记整个搜索范围，含无匹配依据
```

历史读取不登记当前修改的依赖。文件不存在时 contentBase64/contentHash/mode 为 null。目录和 tree 返回固定清单及 fingerprint。版本是不透明字符串；不要拼接 Git 表达式。二进制内容使用 base64，可保留普通或可执行 mode。

`beginChange({...,restoreFrom:oldVersion})` 在授权范围创建恢复旧内容的新草稿，仍经原检查接纳，不 reset 正式历史。只读实例 `{readOnly:true}` 仅提供 read/inspect/close；查询不会修复磁盘、启动容器或运行检查。

## JSONL stdio

```sh
agent-sync --project /absolute/project --home /absolute/sync-data --config /absolute/config.json
```

配置 JSON 为 `{ "checks": [], "execution": ... }`，纯文件客户端可省略 execution。每行输入 `{id,method,params}`，mutation 的 id 就是 requestId。

```json
{"id":"begin-1","method":"beginChange","params":{"actor":"a","intent":"修改文件","scope":["a.txt"]}}
{"id":"inspect-1","method":"inspect","params":{}}
{"id":"cancel-1","method":"cancel","params":{"targetId":"begin-1"}}
```

edit/exec/prepareChange/refreshChange/abandonChange 的 params 包含 changeId 及其参数。结果 `{id,result}`；错误 `{id,error:{code,message}}`；命令输出 `{id,event:{type:"output",dataBase64}}`。等待不会堵塞 inspect/accept/cancel。EOF 关闭 owner、取消运行并保留中断事实。

## 当前边界

可信本地宿主、一个正式 ref、受控接口内的合作执行者。Git 是版本存储，owner 与权限由本工具强制执行。源码 symlink/gitlink、硬链接、设备/socket、大小写别名、歧义路径不支持；依赖目录中的链接仅作容器内部辅助产物。所有普通 Git ignored 源文件仍报告，不能通过临时更改 .gitignore 逃避写范围检查。

没有默认命令时限；宿主可显式传 timeoutMs。checkCurrent 每次运行当前冻结策略，首版不缓存复用检查。镜像与策略改变后需要新的候选/检查。Docker 隔离与稳定快照的保证限于已验证的平台和负向样本，不声称覆盖任意容器逃逸或业务数据一致性。

## 本仓库中的测试与使用

此目录是 CoThink 当前使用的 agent-sync 0.1.1 内核，协议版本为 1。它仍可由无模型的确定性 JS 或 stdio 客户端独立使用；CoThink 负责模型和调度，内核负责范围、版本、隔离执行与接纳。

在 CoThink 仓库根目录运行 `npm run test:agent-sync-core`。完整测试需要本机 Docker 引擎及本目录 `execution-manifest.json` 固定的 linux/arm64 镜像。缺少引擎或镜像会明确失败，不作为 skip 通过。测试包含真实容器和故障注入，不修改 Docker 全局设置。

可从本目录运行 `npm pack` 获取不含模型依赖的独立包；安装后使用上面的 JS/stdio 入口。纯文件 API 不要求 Docker，运行时不读取测试清单，调用方直接传入 execution。CoThink 的完整安装、迁移与证据边界见仓库根目录 README.md 和 VALIDATION.md。

原创内核代码采用 MIT，见本目录 LICENSE。
