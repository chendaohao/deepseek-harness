# Agent Note: 新会话界面选 preset 与首条消息的竞态

Status: implemented

[English](2026-08-16-hero-preset-pick-races-the-first-send.md) | 中文

## 问题

在新会话界面选了 preset 之后立刻发送首条消息，选择会被丢掉。[座位设计](../architecture/2026-08-03-per-session-agent-presets.md)只是暂存选择，直到会话列表更新时才通过 `agentPresets.select` 应用；发送路径并行发出 prompt，主机通常先启动回合，然后以 `agent-preset-locked`（"会话已开始，preset 已固定"）拒绝，会话保持创建时的默认 preset。会话日志记录了两种次序：选择先于消息的会话运行了所选 preset（并伴随大量重复的 `agent-preset/selected` 事件——创建期间每次列表更新都各自发出一条 select RPC）；消息在创建时即被注入的会话则以默认 preset 运行，且没有任何选择记录。

## 决定

在竞态的两侧各修一处：

- **座位控制器的 apply 单飞（single-flight）。**`AgentPresetSeatController.apply()` 记录在途 RPC，并把并发调用合并到它上面（会话列表在一个 tick 内发布多次更新，每次都触发列表变更处理器）；等待中的调用在结束后重新检查暂存，因此在途期间的新选择仍然落地。`runApply` 只清除自己应用的那条暂存——更新的暂存在旧 apply 完成或失败后存活。
- **发送路径等待暂存选择落地。**座位控制器发布一个根级 `agentPresetSeat` 服务（结构化的 `pendingApply()` 接口，经 `ctx.get` 读取、绝不 import——插件边界保持干净），在会话作用域挂载时接到座位控制器上，作用域塌缩时重置为空操作。`ConversationController.send` 与 `sendSession` 在 `session.prompt` 之前 await 它，于是首条消息发送前的选择会在首个回合之前完成组合，而不是与回合竞速。`pendingApply` 在所有形态下都会终止：无暂存、已应用、被拒、传输失败、或无从应用（无会话——暂存留给列表变更处理器）。

## 备选方案

- **在主机侧调整 create 与 prompt 的顺序**（等 preset 落地后再做 inbox 注入）——否决：回合启动是主机对 prompt 的准入契约；让每条首条消息都等待一次 preset 往返会拖慢不组合 preset 的部署，而且客户端本来就掌握暂存状态。
- **只依赖列表变更处理器应用选择，把等待写进文档**——否决：处理器在会话创建之后才触发，而那一刻 prompt 可能已经赢得竞速；只有发送路径能串行化自己的派发。
- **在输入机而不是会话服务里等待 gate**——否决：`ConversationController.sendSession` 是 composer 与服务两条路径共同经过的唯一 prompt 咽喉点，一处 await 覆盖全部路径（包括在其后串行的图片准入）。

## 后果

- hero 界面选 preset 现在会在首个 prompt 之前确定性地完成组合，包括选完立即发送的流程；重复 select 风暴消失（每条暂存一次 RPC）。
- 无暂存时每次发送只多一个微任务；主机无响应时 select RPC 自身的超时先拒绝，prompt 随即按自己的失败路径继续。
- 在座位控制器、apply 与服务测试中各新增回归测试（共十二个）；逐文件覆盖率门禁保持绿色，完整 GUI 套件与 keyless 回放 e2e 通过。
