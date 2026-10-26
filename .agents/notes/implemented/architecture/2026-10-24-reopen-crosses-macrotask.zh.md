# Agent Note: 重开必须跨越宏任务边界

Status: implemented

[English](2026-10-24-reopen-crosses-macrotask.md) | 中文

## 问题

[载体回收修复](2026-10-24-carrier-recycle-reopens-streams.zh.md)让当前代次下的载体故障无限重开流，堵住了「页面永不重连」这个缺陷。它同时引入了新的一个，只在慢链路上出现：手机从后台回来，运行几十毫秒后彻底停止执行脚本。界面还在、还能接受触摸，但什么都不响应，只有杀掉浏览器才能恢复。

重开循环的三个性质叠加出了它。

**第一次重开在下一个微任务就完成。** `streamRetryDelay(1)` 返回 `0`，而 `defaultStreamRetryTimer` 对零延迟的结算根本不经过定时器队列。于是面对一个重开得和失败一样快的对端，整个循环都跑在微任务队列里。

**revision 变化会清零 attempt 计数。** `read()` 在 `observedRevision !== this.revision` 时清空 `attempt`，退避永远爬不过第一档。任何 restart 都把流打回立即档，也就是那个不经过定时器的状态。

**`carrierFailed` 可以重开刚刚被告知已死的这条流。** `createSessionControlStream` 正是如此，因为控制基线在载体丢失后必须重建 Host 状态，而不能等一个前台恢复永远不会发布的代次。于是一次载体故障从失败处理器内部产生了新 revision，revision 检查让循环直接回到顶部，循环再也没离开它开始时的那个任务。

这个循环在墙钟上无界，效果上却是同步的：没有定时器、也没有别的由宏任务触发的 await，页面的 `setInterval` 回调永远不会被调度。在手机上经隧道实测，`revision` 在 21 毫秒内从 35 涨到 114，期间 `attempt` 一直是 0、一次重试延迟都没请求过。页面自己的 5 秒心跳在同一时刻停摆。

这个缺陷需要一个快速失败的对端才能显现。健康链路上重开一次就成功了，循环退出。而在握手要花几秒的 3G 隧道上，对端立即失败，循环永远重复。

## 决定

**重开绝不在下一个微任务完成。** `streamRetryDelay` 对每次尝试都至少返回 `StreamRetryConfig.minMs`（200 毫秒），第一次也算。这个下限过去是抖动下限，现在是一条结构性保证：每次重开都跨越宏任务边界，于是无论对端失败得多快，微任务饥饿都不可能发生。

**revision 变化绝不清零 attempt 计数。** 另一个代次开始，不等于载体已恢复。只有一次被接受的 opening 才能证明这一点，而 `accept()` 已经恰好在那个点清零。

**被取代的代次在循环服务其替代者之前，要等过一格节奏。** `awaitSupersede` 复用同一条 `streamRetryDelay` 序列，因此调用方无法把「被取代」和「载体重开」区分开。这个等待有意不看代次自己的 abort 信号：那个信号正是这次 restart 中止的，而它的中止才是循环走到这里的起因。

## 验证

`packages/api/gateway/tests/control-retry.client.spec.ts` 里的三条回归测试，每条都做了双向验证——在修复上通过，在回退那一处具体改动时失败：

| 测试 | 回退的改动 | 失败信息 |
| --- | --- | --- |
| `never reopens without a delay` | `streamRetryDelay` 下限 | `expected 0 to be greater than or equal to 200` |
| `does not reset the backoff when a restart replaces the generation` | revision 重置 | `expected 1262 to be greater than or equal to 1559` |
| `waits before serving a generation that a carrier callback restarted` | supersede 等待 | `expected [] to have a length of 3` |

第三条断言的是定时器的调用顺序，而不是墙钟上的饥饿：早先的版本统计一个 `setInterval` 计数器，结果在坏代码上也通过，因为测试里的假定时器会以真实页面不会的方式让出控制权。让这个缺陷可观测的是「定时器到底有没有被问到」，所以测试现在检查的就是这个。

端到端确认来自手机经隧道实测，不是来自测试套件：自重启的控制流在一次前后台循环里，`revision` 从 114 降到 4，`attempt` 达到 2，`delay=200` 首次出现。

## 备选方案

**只靠延迟下限，让 revision 变化继续重置尝试次数。** 否决：下限只能消除单次重开的饥饿，revision 重置仍把序列钉在 `attempt = 1`，链路反复抖动时每次重开都只付第一档。不重复消耗第一档，延迟才有机会爬升。

**在循环里显式 `setTimeout(0)` 让出，而不是给延迟加下限。** 否决：这会把调度保证放到第二处，后续改动可以再次抹掉；而 `streamRetryDelay` 仍可以返回零延迟，定时器实现会完全绕开定时器队列直接 resolve。下限把保证留在每次重开都会调用的那一个函数里。

**让 `awaitSupersede` 等待一个固定常量，而不是复用重试序列。** 否决：调用方从此可以区分 supersede 与运营商重开，而且两条路径会随重试配置演进而漂移。复用序列让 supersede 等待成为同一节奏的改名。

**在前台重同步或任何观察到的 Host 进展上重置尝试次数。** 否决：两者都不是运营商已恢复的证据；`accept()` 记录的才是这件事件，也是唯一重置计数的地方。

## 后果

前台恢复后的重连比过去至少慢 200 毫秒。这是那条保证的代价；在手机路径上，相对于 socket 握手它不可见。

`awaitSupersede` 走的是一条在测试里很难抵达的路径，除非能控制微任务队列，所以本文记录人工证据与单测覆盖并列，而不是声称测试套件覆盖了它。
