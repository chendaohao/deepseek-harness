# Agent Note: 移动语音应用审核修复

Status: implemented

[English](2026-08-16-mobile-voice-app-review-fixes.md) | 中文

## 问题

对移动语音应用的审核发现了单元测试未覆盖的缺陷：代码围栏内容只要含句末标点就会被朗读；消息图片在每次快照发布时重复下载，加载失败还会无限重试；乐观用户消息去重只覆盖实时路径；stop→start 的代际守卫捕获了错误的代际，留下僵尸 pump 持续运行；autoSpeak 开关丢失了 autoListen 钩子；模型选中态把所有共享同一模型 id 的 provider 都高亮；配对凭证持久化失败以未处理 rejection 告终；mux 流缺少针对静默死亡传输的空闲看门狗。

## 决定

每个缺陷都在其状态所属处修复：

- **`SpeakQueue.feed` 在未闭合围栏持有 buffer 时直接返回。**`drainFences` 剥离完整围栏后，剩余 buffer 只可能是围栏内容，此时切句会把含句末标点的代码读出声。守卫等待闭合符出现后再切句。
- **消息图片每个 attachment id 每行只下载一次。**`MessageImage` 的 effect 锚定 attachment id（父组件每次渲染都会重建内联 loader 闭包，此前导致每次快照发布都重新触发下载）；加载失败渲染占位符并保持失败态，不再经由 notice→发布→渲染循环无限重试。
- **`user/message` 去重在两条路径上生效。**pendingTexts 回显去重不再检查 `live`；历史重取会重放同一条回显，否则乐观行会被渲染两次。`switchSession` 连同视图一起清空 `pendingTexts`，被放弃的发送不会吞掉新会话中文本相同的真实消息。
- **`MobileConnection` 把 pump 自己的代际传入 `scheduleRetry`。**旧守卫在重试时刻读取 `this.generation`，导致 stop() → start() 之后苏醒的旧 pump 拿到新代际，在新 pump 旁边持续重连（每次会话切换多一条 mux socket）。被取代的 pump 现在在发布状态或打开 socket 之前就退出。
- **mux 流增加空闲看门狗**（`idleTimeoutMs`，默认 45 000，`0` 关闭）：每个送达的帧——包括宿主心跳——重新武装每个代际的定时器，定时器触发后中止该代际的流，以普通流结束的形式进入既有重试预算。与 Web 端 `ConnectionController` 的看门狗一致；宿主心跳（15 秒）保证活跃流永远不会触发它。
- **`setAutoSpeak` 通过共享的 `buildSpeakQueue` 重建**，speaking 结束钩子（同时驱动 autoListen）在开关切换后仍然生效。
- **模型选中记录 provider。**`VoiceChatController` 从 `session.models.current` 与 `selectModel` 发布 `selectedModelProvider`；设置面板按 provider+id 匹配，两个 provider 广告同一模型 id 时不再同时高亮。
- **配对持久化失败可见。**`PairScreen` 等待 `onPaired` 的持久化步骤，并显示专门的 `pairPersistFailed` 文案，而不是让 promise 无观察者地 reject。

## 备选方案

- **在 `drainFences` 内剥离未闭合围栏体**——否决：围栏体必须保留到闭合符到达，切句器无论如何都需要自己的守卫；feed 时守卫是唯一正确的拦截点。
- **只稳定 loader 引用（`useCallback`）**——否决：能消除每次渲染的重取，但消除不了失败重试循环；把 effect 锚定 attachment id 能同时解决两者。
- **只靠宿主心跳做客户端活性判断**——否决：心跳只证明宿主在发送，不证明客户端接收路径存活；对操作系统从不暴露关闭的 socket，客户端侧期限是唯一的端到端保证。
- **重连时清空 pendingTexts 而不是在历史折叠中去重**——否决：清空仍会重复渲染历史重取重放的那一行，而历史路径消费的正是实时路径使用的同一条去重记录。

## 后果

- 新增八个回归测试（围栏标点、历史重取去重、切换会话清 pendingTexts、开关后的 autoListen、看门狗触发/保活/关闭、被取代的 pump）；包保持逐文件 100% 覆盖门禁，keyless 隧道 e2e 在 replay 模式下仍然通过。
- 看门狗中止以普通流结束呈现，重连成本与预算行为不变；真正死亡的传输现在会重连，而不是停留在陈旧的 `online` 状态。
- `stop() → start()` 语义现在确定：旧 pump 静默退出，只有最新 pump 拥有 socket 与状态发布权。
- apps/mobile 界面文案新增 `imageLoadFailed` 与 `pairPersistFailed`（中/英）；快照词汇新增 `selectedModelProvider`。
