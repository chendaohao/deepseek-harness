# Agent Note: 先测量再移除 loopback WebSocket 压缩

Status: implemented

[English](2026-11-05-remote-websocket-loopback-compression.md) | 中文

## 问题

remote-access 路径终止两条 WebSocket hop：Gateway 经面向 Host 的一跳到 Proxy，再由 Proxy 到远程客户端。两者原先都用 level `4` 和 1,024 字节中继阈值协商 `permessage-deflate`。因此，一个大型下行载荷要经历 Gateway deflate、Proxy inflate 和 Proxy deflate，尽管第一跳并不承载公网字节。

这第一跳无论怎么绑定都不离开本机。`RemoteAccess` 拨号的是 `ctx.webServer.host`，也就是 Web 服务器在本机绑定过的地址；拨向本机自己的任一地址时，内核从本地路由表直接用 loopback 接口应答，没有任何接口承载这些字节。在接口绑定拓扑上实测：经绑定到本机接口地址的 socket 传 8 MiB，`lo` 计入 8,400,318 字节，接口本身不到 1.1 KB，与空闲 3 秒窗口相同。因此不存在哪类部署能靠这一跳的压缩省下公网字节，移除它是在删除重复工作，而不是用带宽换 CPU。

既有压缩决策明确记录默认值和级别都未经测量。当时的测试只证明协商与载荷等价，不证明 CPU、传输时延或内存。

已交付代码里还有两个惰性常量被描述得像在生效。`ws` 只在协商出 `*_no_context_takeover` 时才读 `perMessageDeflate.threshold`，并且总是用协商出的 `*_max_window_bits` 覆盖 `windowBits`。Gateway 的 `MUX_DEFLATE_WINDOW_BITS` 是 15，而 15 **就是** zlib 默认的 32 KB 窗口，模块注释却说该常量避开了"32 KB 默认值"，构造函数注释又说"默认 15 位窗口会在帧中途重置字典"——同一个文件对同一个数字给出了两种互否的说法。

## 决定

remote-access 的 Proxy 只压缩面向远端的 WebSocket 一跳。面向本地 Web 服务器的拨号拒绝 `permessage-deflate`，于是一个大型下行载荷只 inflate 一次，而不必先被 Gateway deflate、被 Proxy inflate、再为远程客户端 deflate 一次。

`websocketCompression: 'none' | 'deflate'` 保留名称与取值，`'deflate'` 仍是默认值，但该值现在只描述面向远端的一跳：

```text
const downstreamCompression = websocketCompression === 'deflate' ? deflateOptions(internals.deflateLevel) : false
new WebSocketServer({ noServer: true, maxPayload: internals.maxPayload, perMessageDeflate: downstreamCompression })
new WebSocket(url, { perMessageDeflate: false })
```

逐帧逻辑无需改动。对未协商出扩展的 socket，`ws` 会把每次 send 的 `compress` 置为 `false`，因此中继现有的逐帧 `compress` 参数在 Host 向一跳上本来就正确。

Gateway 直连行为未变：浏览器、Desktop 与 Node 载体仍在 `/api/remote.mux` 上以相同默认值和相同的 1,024 字符发送阈值协商该扩展。

这项改动没有任何部署可观察到的后果：它停止压缩的那一跳无法离开本机，因此没有设置、wire 格式或运维动作随之改变，也不需要升级指南。

### 作出该判断的测量

改动的依据是传输诊断，而不是字节数推理。诊断留在其 owner 旁边：[`remote-stream.perf.ts`](../../../../packages/remote/remote-access/tests/remote-stream.perf.ts)，配一份 fresh-process worker、固定负载常量和一份编译型集成适配器。

**适配器是必需的，不是可选的。** 两个被测入口都不是公开导出：`RemoteStreamMuxServer` 没有从 `@deepseek-ai/dsh-api-gateway` 的入口导出，`createRemoteProxy` 也没有从 `@deepseek-ai/dsh-remote-access` 的入口或任何 `exports` 子路径导出。与其为测量新增生产导出，[`remote-stream-adapter.ts`](../../../../packages/remote/remote-access/tests/remote-stream-adapter.ts) 重新导出两个源码模块，沿用 [`benchmarks/terminal-io/session-adapter.ts`](../../../../benchmarks/terminal-io/session-adapter.ts) 的既有做法。因此该诊断解析源码而非构建后的 `lib/`，报告也如此声明，不主张已发布产物证据。

| 字段 | 决定 |
|---|---|
| 用户操作 | 经 remote-access 发送大型 opening、已合批回答和大型上行帧；只有客户端验证完全部载荷才算完成 |
| 入口路径 | 生产的 `RemoteStreamMuxServer` 与 `createRemoteProxy` 类，以及 loopback 上的 `ws` 客户端；排除 cloudflared、公网时延、模型生成、Assistant 合批、Client fold 和浏览器绘制 |
| 负载 | 1.4 MiB 重复 JSON opening，尺寸取自 Gateway mux deflate 常量旁记录的 1,395 KB Session 快照；1,000 个合成 delta 每帧 50 个合成 20 个约 6.5 KB 的回答帧，每帧都越过 1,024 字节中继阈值；1 MiB 与 64 KiB 上行帧；20 个阈值以下帧作为不压缩对照 |
| 对照 | A：两跳都协商扩展（生产拨号已拒绝该扩展，因此由中继的测试钩子恢复）；B：Gateway 配 `none`、Proxy 配 `deflate` 且保持生产拨号，即现行拓扑。两臂跑的是同一份生产中继，唯一差异是面向 Host 的一跳是否协商 |
| 计时与内存 | 握手与上行排空都在计时前完成；最后一个载荷验证后停止；峰值与常驻 RSS 分别记录 |
| 指标 | 整链路进程 CPU、墙钟时间、P95 帧间隔、面向远端 wire 字节、峰值与常驻 RSS |
| 样本 | 按交错顺序 `A A B B A A B B A A B B A B`，每个变体 7 个 fresh child，先丢弃一个 warmup；记录三次完整运行 |

**Host 跳这一臂必须靠钩子。** Proxy 的拨号无条件拒绝该扩展，因此配成压缩的 Gateway 没有可以协商的对端：只设 `gateway: 'deflate'` 的臂把现行中继测了两遍，本诊断的第一版正是如此，所以它的 A/B 差异无法复现。`internals.hostHopDeflate` 只在测量时恢复拨号上的扩展；生产代码从不设置它。

用进程 CPU 作口径的理由是 `process.cpuUsage()` 报告 `RUSAGE_SELF`，其中包含 zlib 在 libuv 线程池里消耗的时间，即使那部分工作从不占用事件循环。同样因为是同一进程，单个 worker 无法把 CPU 拆给两跳。

wire 字节通过在客户端与 Proxy 之间插入一个 loopback TCP 中继、累加其转发字节来计数。`ws` 没有公开计数器，而 inflate 之后的载荷长度恰好会掩盖压缩决定改变的东西。

### 参照测量

2026-11-05，`linux x64`，Node `v24.16.0`。直接运行诊断：

```sh
node --import tsx/esm packages/remote/remote-access/tests/remote-stream.perf.ts
```

计时间隔：所有握手与上行排空之后，直到客户端验证完最后一个下行载荷——1 个 opening 帧、20 个回答帧、20 个小帧，以及 Host 消费的 2 个上行帧。每个样本都报告 `payloadsMatch: true` 且恰好 41 个下行载荷帧。

| 指标 | A（两跳） | B（Host 跳明文） | 变化 |
|---|---|---|---|
| 进程 CPU，7 样本中位数（ms） | 60.98 | 45.61 | **−25.20%** |
| 进程 CPU，全部样本（ms） | 56.80, 58.74, 60.98, 90.91, 66.27, 56.52, 70.97 | 40.90, 70.04, 39.37, 44.14, 45.61, 49.26, 48.63 | |
| A/A 噪声底（CPU 中位数） | 20.82% | | |
| 面向远端 wire 字节 | 7 个样本全为 122,249 | 7 个样本全为 122,249 | 0% |
| P95 帧间隔，中位数（ms） | 0.94 | 0.90 | −0.04 ms |

同一台机器、同一顺序再跑两次，分别报告 −43.23%（A 79.60、B 45.19，噪声底 1.52%）与 −25.96%（A 61.59、B 45.60，噪声底 11.56%）。候选臂的中位数三次都在 0.9% 内（45.19–45.61 ms），而对照臂在 30.5% 内波动（60.98–79.60 ms）。只有仍在压缩的那一臂不稳定，正是这项改动预测的方向；对效果最保守的界是噪声底最大的那次 −25.20%。

结论：面向 Host 的一跳的压缩不划算。保守那次运行 CPU 下降 25%，远超该次的噪声底；远程客户端收到的字节一字节不差；帧间隔没有退化。wire 计数完全相同是预期结果而非测量假象：改动的只有面向 Host 的一跳，而客户端读的是面向远端的一跳。效果三次都大于噪声底，但在这台机器上幅度无法分辨到优于四分之一；方向是确定的，因为候选臂的离散度只有对照臂的一小部分。

CPU 区间同时包含两跳在同一进程里的开销，因此它不单独测量 Gateway。这不削弱结论：改动从路径上移除了工作，而结果发生漂移的正是保留这项工作的那一臂。

### Lane：只出报告，不做门禁

该诊断不是回归门禁，位置也体现了这一点。[benchmarks/AGENTS.md](../../../../benchmarks/AGENTS.md) 把 `.perf.ts` 后缀留给包内诊断，并把它们排除在 `test:bench` 之外。它是普通入口脚本而非 Vitest 用例，与既有包内诊断形态一致：父进程为每个样本起一个 fresh child，child 打印一行 JSON，父进程打印聚合报告。

没有任何 Vitest 配置收录它，因此 `ci-*`、`doc-sync` 与 `test:bench` 都不会收集它。之所以需要 `tsx`，是因为两个被测类都解析源码；这代价每个 child 只付一次，并写进报告而不是藏起来。

把它提升为门禁是另一次改动：在 `benchmarks/` 里加经校准的预算与经审阅的参考机期望。

### 级别是测试钩子，不是配置

`WS_DEFLATE_LEVEL` 决定面向远端一跳的 zlib 级别，它与中继上限一起挂在 `internals` 上，因为没有测量支持一个配置字段，也没有部署要求它。诊断在构造代理前设置它，生产代码从不触碰。把 `deflateLevel` 加进 `RemoteAccess` 的 config，等于把一个未调优的常量变成承诺出去的 surface。

### 同一改动中修正的惰性常量

`ws` 只在协商出 `*_no_context_takeover` 时才读 `perMessageDeflate.threshold`，并且总是用协商出的 `*_max_window_bits` 覆盖 `windowBits`。两个字面量因此都是自称配置的文档。现在它们按实际作用描述，而中继自己那个确实生效的 1,024 字节常量，也按其逐帧判定来描述。

Gateway 的 `MUX_DEFLATE_WINDOW_BITS` 注释自相矛盾：它把 15 位同时说成"zlib 能给的窗口上限"（避开"32 KB 默认值"）和"避免帧中途重置字典"的取值，而 15 位**就是** `Z_DEFAULT_WINDOWBITS`——32 KB。该注释现在说明这个字面量只是记录协商值，并不改变它。

## 后果

在实测负载下，保守那次运行里大型下行的整链路 CPU 降低四分之一，帧间隔没有退化。远程客户端的字节没有变化，因为停止压缩的那一跳并不是客户端读取的那一跳。

**接口绑定部署什么也没失去。** 以具体 `--host` 地址启动的部署同样把这一跳留在本机内：代理拨的是 Web 服务器刚在同一台机器上绑定的地址，内核用本地表经 `lo` 应答。没有任何原本被压缩的东西被暴露出去，因此这类部署无需改动，也不会收到通知。

**level `1` 已在确定后的拓扑上测量并被否决。** 只在面向远端的一跳上把它与 `4` 对比，每个变体 7 个 fresh child，以 `B` 为对照按 `B B C C` 交错：

| 指标 | B（level 4） | C（level 1） | 变化 |
|---|---|---|---|
| 进程 CPU，7 样本中位数（ms） | 46.50 | 44.13 | −5.10% |
| B/B 噪声底（CPU 中位数） | 0.06% | | |
| 面向远端 wire 字节 | 7 个样本全为 122,249 | 7 个样本全为 136,018 | **+11.26%** |

同一顺序再跑一次报告 −7.38%，噪声底 20.45%，因此 CPU 差异在这台机器的分辨率下既不大也不可复现；而字节代价是精确且无歧义的：level `1` 在每一个样本上都给远程客户端多发 11.26% 的字节；更便宜的级别在这里换不到可测量的收益，却向压缩本要保护的链路加税，因此保留 `4`。

两次运行彼此的分歧大于任何一次报告的效果，这是这条结果里诚实的部分。所以测量是靠字节否掉 level `1`，而不是证明 `4` 是 CPU 最优。更安静的机器或更多样本也许能找到真实的 CPU 节省；但它仍须先压过慢速链路上 11.26% 的字节增量。

Gateway 直连的级别未动，在移动前需要自己的直接 mux 证据。

**测量看不见的东西不在其覆盖内。** 它测的是 loopback 上的生产组件，不是经公网隧道的手机，也不覆盖接口绑定拓扑的整体：上面那次独立的接口计数测量只覆盖那一跳，不覆盖该拓扑的其他部分。Assistant 合批、Client fold 与浏览器绘制同样在范围之外，因此它不保护这些环节的时延。

**功能行为未变且有测试钉住。** Proxy 测试证明上游拨号不 offer `Sec-WebSocket-Extensions` 而下游仍协商压缩、大小帧的内容与顺序与二进制标记不变，并且 `'none'`、pending 与 backlog 上限、Ping/Pong、关闭与重连行为与改动前一致。

该包的压缩测试套件全绿，含新增用例：上游拨号不 offer 扩展，而访客侧仍协商成功。Gateway 套件除 `keeps a socket alive while compressed frames are written without a Pong` 外全绿；该用例在回退本改动后同样失败，属既有的活性计时抖动，不是本改动的回归。

## 范围与现有决定

已实现的 [permessage-deflate 决策](2026-10-18-websocket-permessage-deflate.zh.md)继续拥有配置词汇、Gateway 直接协商、它自己的 1,024 字符发送阈值、上下文接管、容量与活性语义。中继的 1,024 字节阈值是 remote-access 自己的常量，由本 Note 拥有。

已实现的[手机远程接入决策](../feature/2026-08-14-remote-phone-access.zh.md)继续拥有配对、信任归一化、中继上限、心跳、重连与下游压缩；其中"面向 Host 的一跳也协商压缩"这一条正是本改动替换掉的内容。

## 备选方案

**不作测量就保留双跳压缩。** 否决，因为重复工作没有定价。先测量是改动任一跳的前提。

**全局关闭 Gateway 压缩。** 否决，因为直接连接的远程客户端仍需要节省下行带宽，现有配置也已覆盖选择其他策略的部署。

**把恢复 level `1` 当作既定修正。** 否决，历史也支持这一否决：Gateway 最初以 level `1` 落地，后续提交在没有任何测量的情况下改写成 `4`。比较两个级别需要在确定拓扑上的证据，而不是从这段历史的任一端推断。

**把面向 Host 的一跳当作恒为 loopback 从而跳过取舍。** 否决，因为绑定地址可配置且代理跟随它，"没有带宽可节省"只在默认 `127.0.0.1` 绑定下成立。

**新增级别、阈值或窗口配置。** 暂缓，因为没有部署需求或测量证明需要新字段。修正惰性字面量不会把它们变成性能调优手段。

**为基准公开被测类。** 否决，改用私有集成适配器：只为诊断存在的生产导出是没有其他消费者的 surface。

**捆绑合批、上行复制、监听分发或 HTTP keep-alive 修改。** 排除。每一项都需要自己的 profile 与所属行为测试，不能把另一个变量藏进压缩对照。
