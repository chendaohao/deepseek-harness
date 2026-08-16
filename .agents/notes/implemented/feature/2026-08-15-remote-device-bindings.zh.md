# Agent Note：远程访问设备绑定——每设备 cookie、30 天滑动解绑、设置页

Status: implemented

[English](2026-08-15-remote-device-bindings.md) | 中文

## Problem

remote-access 配对门（[remote phone access note](2026-08-14-remote-phone-access.md)）铸造的是无状态 cookie：`v1` 值只编码过期日，同一天配对所有设备共用同一个 cookie 值。没有设备身份、没有最近使用信号、没有撤销手段，GUI 里也无从展示——而产品要求 Web 设置里有设备列表，绑定 30 天不用自动失效、使用即刷新。

## Decision

**把绑定状态下沉到服务端；cookie 变为每设备能力，注册表拥有过期。**

- **Cookie v2**（`secret.ts`）：`v2.<deviceId>.<mac>`，每次配对随机生成 16 字节设备 id；HMAC 把 id 绑到主密钥，常量时间校验。去掉内嵌过期日——过期由注册表裁决。v1 形态整体拒绝（预发布立场：不留兼容）。
- **设备注册表**（`devices.ts`）：每次配对一条记录（`deviceId, label, boundAt, lastUsedAt`），持久化在 `$DSH_HOME/secrets/remote-devices.json`（tmp+rename 原子写，0600）；损坏文件加载即高声失败。写盘按"每设备每 UTC 天至多一次"节流；`flush()` 供测试与拆卸等待静默。
- **滑动窗口**：`authorize` 验 cookie 后 `touch`——放行即刷新 `lastUsedAt`；`now - lastUsedAt >= 30 天` 删除绑定并回 401（自动解绑）。`list()` 惰性 GC 过期行。WS 升级只在握手时过门；窗口在下一个普通请求上滑动（已写明的语义）。
- **浏览器 cookie 刷新**：浏览器遵循 Max-Age，因此每个 UTC 天的首个放行请求在转发响应上搭车一条 `Set-Cookie`（同值、新的 30 天 Max-Age）——合并时排在目标自身 set-cookie 数组之后（node 保证客户端侧为数组）。
- **配对标签**：`/pair/<ticket>?name=`（清洗、≤64 字符）优先于 User-Agent 前缀；手机端上报机型名（expo-device）。
- **Remote 面**：`RemoteAccessGateway extends TypertRemoteService`（命名空间 `remoteAccessDevices`）提供 `list()`/`unbind(deviceId)`，仅在插件启用于服务 init 中挂载；客户端装配挂载生成的命名空间，新增 [`ui-settings-remote`](../../../../packages/client/ui-settings-remote/README.md) 设置页渲染列表（标签、绑定日期、相对最近使用、倒计时）与两步手动解绑。
- **`resetSecret` 轮换密钥并同时清空注册表**——所有 v2 cookie 的 HMAC 一次性失效；陈旧绑定不得残留。

## Alternatives considered

- **保留无状态 cookie、只加长 Max-Age**——否决：没有按设备撤销、没有最近使用，GUI 列表反正还要一个并行注册表；一个绑定两份真相。
- **把 lastUsed 嵌进 cookie 由其自证新鲜**——否决：客户端可控的 cookie 自述新鲜度不可信；窗口只能服务端拥有。
- **用 session/projection 事件做列表实时更新**——暂缓：设置页在打开/重试/解绑时重载；需要实时性时可循 settings-document 先例加推送失效事件。
- **宿主未启用插件时隐藏设置分区**——暂缓：typert 命名空间在客户端总是挂载，缺席检测需要在 `apply` 里主动探测（每个 Remote 设置页都避免的模式）；页面先降级为失败态，README 记录该限制。

## Consequences

- cookie 契约是 remote 插件的公开词汇：值格式（`v2.<id>.<mac>`）、`?name=` 配对参数、30 天 `DEVICE_INACTIVITY_MS` 窗口都归宿主所有；移动端核心只在配对中不透明地存储 cookie 原值。
- 注册表写盘按天节流：崩溃至多损失一天窗口进度（30 天窗口可容忍）；拆卸前 flush。
- 每个 Web 部署的设置导航都会多出 远程访问/Remote Access（goldens 已相应刷新）；非 `--remote` 部署上该页显示失败态，直到按错误码区分。
- 长连接 WebSocket 在设备解绑后存活到重连——与此前 cookie 语义一致；已写入 README 安全模型。
- 重建的 typert faces（`./typert`、`./remote` 导出）随标准 host 构建产出；客户端装配在 pluginInventory 旁挂载该命名空间。
