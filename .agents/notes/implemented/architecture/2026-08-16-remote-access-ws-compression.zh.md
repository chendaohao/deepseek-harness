# Agent Note：远程访问隧道腿 WebSocket 压缩——下游腿启用 permessage-deflate

状态：已实施

简体中文 | [English](2026-08-16-remote-access-ws-compression.md)

## 问题

remote-access 代理把 Web GUI 的两条事件流 WebSocket 经公网 quick tunnel 转发；这些字节全部经由代理的"下游（面向隧道）腿"过网。该腿从未协商压缩：代理的 `WebSocketServer` 与上游客户端都没有设置 `perMessageDeflate`，下行 socket 同样没有。事件帧是冗余度很高的 JSON 文本，而远程使用又以移动数据链路为主，因此这是远程访问中最大的可移除带宽开销。

## 决策

新的 `dsh-remote-access` 配置 `wsCompression` 开启时（默认 `true`），`createRemoteProxy` 在下游腿启用 permessage-deflate，采用 `ws` 库默认协商参数（1 KiB 压缩阈值、`concurrencyLimit` 10）。loopback 腿保持明文——上游客户端传入 `perMessageDeflate: false`——因为回环一跳上的 zlib 零带宽收益且两侧都消耗 CPU。压缩在 WebSocket 握手时按连接协商，因此不声明该扩展的客户端（旧浏览器、无支持的原生栈）透明地不协商压缩，已建立的连接绝不受影响：改动只作用于下一次 `dsh web` 重启之后开始的新握手。

## 备选方案

- **两条腿都压缩**——否决：loopback 一跳无带宽收益；主机与客户端双份 zlib 压力毫无意义。
- **在下行源头而非代理处压缩**——否决：下行 socket 服务的是 loopback 流量，其压缩永远不会过网；代理是唯一帧要穿过隧道的跳点，且在那里启用可覆盖代理的所有消费者。
- **默认关闭 `wsCompression`**——否决：当前所有浏览器与 `ws` 客户端都会声明该扩展，移动链路上的带宽节省正是远程访问的意义所在；配置仍保留，作为 CPU 受限主机的逃生门。

## 影响

- 隧道腿 WebSocket 流量现在被压缩；代理测试测得 68 KiB 重复 JSON 载荷以下游腿约 250 字节过网（约 270 倍），而 echo 目标仍收到完整明文。
- 每条消息的 zlib 开销（按 `ws` 阈值仅 ≥ 1 KiB 的消息）落在手机与主机两侧；`concurrencyLimit` 限制并发压缩器数量。
- 已建立的连接不受影响（协商以握手为界）；下次重启后新连接自动协商，且无需重新配对——设备绑定与 cookie 与传输无关，见 [remote-device-bindings 记录](../feature/2026-08-15-remote-device-bindings.md)。
- `wsCompression: false` 可恢复先前的未压缩行为。
- 覆盖：`proxy.spec.ts` 断言协商的开/关两个分支，并借助透明字节计数中继验证压缩后的线路字节低于未压缩往返的四分之一，且载荷完整性一致。
