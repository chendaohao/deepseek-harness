# Agent Note：根据会话记录重建的手机端分层结构（此前被 .gitignore 静默清空）

Status: implemented

[English](2026-08-17-mobile-rebuilt-from-records.md) | 中文

## 问题

用户认为已实现的一组手机端文件——`PairingScreen.tsx`、`DeviceBindingScreen.tsx`、`src/lib/api.ts`、`src/lib/native-module.ts`、`src/app/_layout.tsx`、`src/state/voice.ts`、android 配置以及 `docs/cookbook/adding-a-typert-remote.md`——据报已丢失。

取证确认它们从未进入 git（没有提交、stash 或游离对象；也没有任何 DSH 会话写过它们）。真正持久的发现是丢失机制而不是文件本身：根 `.gitignore` 的裸 `lib/` 规则静默忽略了 `apps/mobile/src/lib/`，而 `apps/mobile/.gitignore` 忽略了 `android/`（continuous native generation）——这两条路径下的文件对 git 隐形，任何清理被忽略文件的操作（`git clean -fdX`、`expo prebuild`）都会零痕迹删除它们。

## 决策

从已提交代码按层重建手机应用的目标结构，每步提交，并修补 gitignore 漏洞，使该层今后可被跟踪。

- `src/lib/api.ts` 负责线缆客户端装配（base URL + 配对 cookie）；`adapters/transport.ts` 保留为兼容别名。
- `src/state/voice.ts` 负责 `VoiceChatController` 生命周期，以订阅者方式发布快照；`useVoiceController` hook 绑定该 store。
- Expo Router 迁移让 `src/app` 路由 index/pair/chat/devices，`PairScreen` 更名为 `PairingScreen`，配对状态位于路由树 Context。
- `src/screens/DeviceBindingScreen.tsx` 展示当前主机绑定与 30 天自动解绑规则，提供重新配对或解绑。
- `docs/cookbook/adding-a-typert-remote.md` 记录 Remote 贡献契约（线缆类型、`TypertRemoteService` + `@Remote`、`zod` 依赖、`/typert` 与 `/remote` 导出、api/remotes 接线与失败模式）。
- `apps/mobile/.gitignore` 反选恢复 `src/lib/`；被忽略的 `android/` 重建风险已记录，但未解除忽略。

## 备选方案

- **只接受丢失并仅修补 gitignore**——已否决：用户要求重建该结构，且分层提供了仓库门禁所需的可测试性。
- **只重建路由 UI、不做 api/voice 分层**——已否决：分层正是本笔记的目的；界面消费 store 与传输工厂，而不是在组件状态里构造控制器。
- **现在就为主机侧加 mux devices RPC 以支持多设备列表**——暂缓：多设备列表是 Web 侧功能；界面暂只管理当前绑定，该 RPC 属于本笔记范围之外的主机改动。

## 结果

每一层都有 node 规格测试（`apps/mobile/tests`），typecheck 与 `expo export --platform android` 通过，cookbook 双语对通过 doc-sync 的 md-wrap、类型检查与站点检查（两个先于本次存量的 master 门禁失败——`verify-export-jsdoc` 的 `RemoteLocaleKey` 与 attachment 的 type-equiv 漂移——保持不变）。

- `apps/mobile/src/lib/` 下的文件不再从 git 消失；未来的 `native-module` 层可以安全落在那里。
- 被忽略的 `android/` 目录仍会在 `expo prebuild` 时重建；原生配置必须收进 expo prebuild plugin 或被强制跟踪。
- 唯一用过 glm-5.3 的 DSH 会话（`session-b9495644`）做的是已提交的 P1/P2 手机端与远程设备工作，因此已记录会话没有任何内容丢失。
