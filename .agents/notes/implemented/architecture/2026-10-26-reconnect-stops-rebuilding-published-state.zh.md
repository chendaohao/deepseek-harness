# Agent Note: 重连不再重建页面已经显示的内容

Status: implemented

[English](2026-10-26-reconnect-stops-rebuilding-published-state.md) | 中文

## Problem

[载体被回收后重新打开它的流](2026-10-24-carrier-recycle-reopens-streams.zh.md)落地之后，手机页面从后台回来时内容还在，但界面在回来的路上明显重建了两次：置顶分区塌陷再长回来，会话列表的标题先变空再恢复。这来自两个互不相干的缺陷，而第一个还意味着上一版修复自己的头号结论——一次前台恢复只拨一次号——并没有兑现。

探针时间线（`~/.dsh/logs/reconnect-probe.log`，修复部署后的手机端记录）记录下的拨号是：

```
22:20:22.886 ws#45 construct   22:20:22.956 ws#45 close 1006 +70ms
22:20:23.202 ws#46 construct   22:20:26.045 ws#46 open +2844ms
```

构造后 70–105 ms 就出现闭码 `1006`，那是客户端主动 `close()` 一个从未完成握手的 socket，不是网络故障。只有 `cancelCandidate` 会关闭正在连接的 socket，而只有 `reconnect()` 与 `resume()` 会调用它。

**一次性回收标记从未命中。** `resume()` 清空 `socket` 并拨新号；新 socket 的 `socket` 字段只在驱动的 `opened` 回调里赋值。与此同时 `$events` 流死掉，Connection 的 generation 随之消失，它的重试调用 `mux.reconnect()`。那条路径判断的是 `recycleSuperseded && socket !== undefined`，而握手期间 `socket` 恒为 undefined——于是标记未被消费，请求直接落到取消 `resume()` 刚拨的那一条。一次前台恢复仍然付出两次拨号和两轮流失效。

**投影状态被两个互不相干的触发各重建一次。** control stream 在载体丢失时自行重启（`packages/api/session-controller/src/client/transport.ts`），其新 baseline 重播每个投影。与此同时，新 generation 的 `handleConnected()` 清空每个投影 store 并重拉列表。在两者之间，`pinned` 读到 `undefined`，而置顶分区正是由该 key 派生的——所以可见症状是分区塌陷再长回来，而不是一次安静的值替换。

两条路径的先后也不固定，因为 control 重启并不等 generation 死透。当 baseline 先到，顺序变成 seed → clear → 拉取，空窗比任何单一路径都长。

## Decision

**只要拨号已经开始，替代就算已经完成。** `reconnect()` 在 socket 存在**或**有拨号在进行时都认为标记已满足。`maintain()` 对这两个条件本来就幂等，所以提前返回不会让载体缺席。标记仍然一次性：被吸收的请求是回收自身的后果，下一个请求面对的是真正过期的 socket。

**换代只让水位退役，不删除值。** `ProjectionValueStore` 给每一行打上写入它的 generation 标记，`beginGeneration()` 只推进标记、不动映射。读取仍然返回上一代的值，屏幕上什么都不空；新 generation 的第一次写入替换它们。seq 只在同一代内可比，这正是让新 baseline 能压过携带更大 seq 的退役行的原因——也就是当初引入删除所针对的那个场景。

**cached block 仍然覆盖它的全部 key 集合。** 新 generation 的 block 未携带的退役 cached 行随该 block 一并丢弃，因为 block 是当前完整的答案，被省略的 key 是来源不再报告的 key。没有这一条，Host 已停止发送的 key 会熬过每一次重连。

`clear()` 保留，含义收窄为：Host 报告该 Session 不持有任何投影，那是缺席，不是换代。

## Alternatives considered

**惰性删除——清空映射但仍然返回旧值。** 否决：这是同一个缺陷的缩小版。真正要紧的读取者（列表重建、`useProjection` face）由同一个微任务通知，所以一个"已清空但仍可读"的映射需要再加一个"待定"状态来区分缺席与退役。generation 标记用一个整数就承载了这个区分。

**让 `handleConnected` 等 control baseline 到达后在同一个 tick 内 clear 再 seed。** 否决：它只修好 baseline 携带的 Session，对每个冷 Session 仍然无效，而且仍要推理两个写入者谁先到。按标记退役是把顺序问题消掉，而不是回答它。

**彻底删掉 `clear()` 路径，全靠换代退役。** 否决：`refreshProjections` 用 `clear()` 表达 Host 返回 `null`——该 Session 确实不持有投影。那不是换代，必须继续清空。

**保留 control stream 的自重启、删掉 `handleConnected` 的重拉。** 否决：自重启只修复 control 状态；列表仍然要为新一代重拉，而列表行走的是另一个 RPC。

## Consequences

手机从后台回来时每次回收只拨一次号，并且只渲染一个状态：已经在显示的值保持不变，直到 Host 为同一个 key 给出答案，然后原地替换。在同一份探针上，单纯的换代不再引发 Session 行块的一次整块替换。

代价是 `ProjectionValueStore` 现在会返回水位缺席的值——`get()` 返回退役值，而同一个 key 的 `seqOf()` 返回 `undefined`。这个不对称是刻意的，而且是承重的：把 `seqOf()` 当水位用的调用者不能拿上一代的 seq 去比当前代，`Session.retireAdmittedSubmission` 正是这样读的。将来若有读取者假设 `get()` 与 `seqOf()` 总是一致存在，那就是错的。

退役行也会一直保留到被写入，因此一个重连后再也没有为某个 key 刷新过的 Session 会无限期保留旧值。对显示而言这是预期行为，而每个拥有该 key 的路径都会在下一代写入它。

## Testing

`packages/api/gateway/tests/gateway.client.spec.ts` 钉住标记的两侧：在替代拨号仍在握手时发起重连不取消任何东西，而标记被消费之后的请求正常替换。第一条用例对旧的 `socket !== undefined` 判断会失败。

`packages/api/session-controller/tests/projection-store.client.spec.ts` 钉住退役：值熬过 `beginGeneration()`，水位不熬过，新一代更低 seq 的 baseline 仍然落地，省略该 key 的 cut 会让它退役，而同代的过期 cut 仍然输给更新的 frame。`tests/inbox-projection.client.spec.ts` 与 `tests/manager.client.spec.ts` 承载了两条点名旧行为的端到端预期——一次重连中原本会变空的冷 Inbox 与标题——现在断言值在被替换之前保持发布。
