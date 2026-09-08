# Agent Note：转发客户端只读设置与 /m 表面移除

Status: implemented

[English](2026-09-08-forwarded-settings-fence-and-m-removal.md) | 中文

## 问题

两个表面对着同一个设置文档，却对「谁能写」说法不一。手机浏览器经配对的 remote-access 隧道打开桌面 Web shell 时拿到的是完整设置页，但 `ui-settings` 从 `remote.$host.isLoopback` 解析自己的持久化，把非回环页面留在进程本地：手机看到的是一面死镜像，而不是它被配对来看的主机值。反过来，服务端没有任何机制区分隧道调用方与桌面，任何未来从转发请求发出设置写入的客户端都会以桌面的完整权限触达宿主文档——包括绕开 agent 审批流的权限预设——以及凭据值。

与此同时，独立的 `/m` 移动页为同一状态的第二种渲染复制了传输、主题与配对面，而用户的真实用法就是用手机打开桌面 shell。

## 决定

**可写性归 Host 围栏所有；客户端渲染 describe 应答。** `client-connection` 把每请求事实（小写化、单字符串头）装入 `AsyncLocalStorage`，包住每一次 `/api` 分发；Gateway 的 WebSocket mux 在每次流打开外重新安装升级请求的事实。remote-access 反向代理给每个转发请求盖上 `x-dsh-proxied`，并从入站流量中剥掉它（该头常量移到 `host-webserver`——代理与控制器共同的下层属主）。`settings-controller` 检查该标记：`describe` 报告 `writable: provider.writable && (!forwarded || config.forwardedWrite)`，开关关闭时转发请求的每次设置写入都以新的 `settings/forwarded-write-disabled` 码拒绝。直连的进程内调用不装事实、不受影响——桌面保持原语义。

**凭据写入永不开放。** 即便 `forwardedWrite: true`，`credentials.set`/`unset` 也无条件拒绝转发调用方，`credentials.describe` 对它们把每个引用都报为不可写。隧道客户端可以改设置文档，但改不了宿主呼出所用的 API key。

**开关是显式的部署选择。** `forwardedWrite` 默认 `false`，web-app bundle 显式钉住它，`--remote` 不隐含它。失败响亮：错误码有名有姓，UI 可渲染、日志可 grep。

**客户端删掉自己的猜测。** `ui-settings` 删除 `memory` 持久化模式：镜像总是读取，`persistence` 不再是构造器或 binder 参数，`SettingsScopeSnapshot.mode` 收窄为字面量 `'host'`。可写性即 describe 应答，于是手机页实时跟随主机值，它支撑的每个可写控件都由服务端强制执行的同一条事实禁用。尚未按 `writable` 设门的主题与语言偏好写入在快照只读时跳过持久存储：会话内切换保留，注定失败的线路调用不再发出。设置文档动作保持仅回环，因为原始 yaml 携带未脱敏的密钥。

**`/m` 移除。** mobile 目录、其独立 tsdown 入口、ui-remote host 半区的两条路由 effect 与 config 门、它的测试与快照、bundle 行的 `webStartup` config 全部删除；ui-remote 的 host 半区成为惰性 Loader entry，其 tsdown config 回归纯预设的 `clientBundle`。`tsdown.client.ts` 的 `cssInlinePlugins` 提取保留：`clientConfig` 自己在用，且 `stylesheetFileId` 的裸 specifier 解析修好了桌面 bundle 的 `katex` CSS。workspace-ext 的 `client-ui-remote` 行只剩 `id`/`name`。TODO 的 `/m` i18n 任务随表面一并退役。

## 验证

settings-controller 测试双向覆盖围栏（带码拒绝、`forwardedWrite` 放行、三种姿态下 describe 的真实、凭据不可写）；request-facts 测试钉住头归一化、嵌套与并发；gateway 流测试证明升级事实到达流打开。ui-settings、ui-settings-models、ui-settings-plugins、ui-settings-general、ui-permission-presets、ui-theme 与 locale 套件演练只读姿态。快照政策：录制会话都在回环上重放，describe 值未变，因此不新增录制场景；围栏是非回环路径上的值语义变化，无 key 的 harness 造不出该路径。

## 备选方案

**把显式 `forwarded` 参数穿过每一层设置写入。** 否决：`describe` 是所有调用方共享的一份应答，客户端的可写真相仍需第二来源，且参数要穿过路由到控制器之间的每条接缝。

**让网关改写 `describe` 的 writable 字段。** 否决：网关返回不属于它的业务结果，等于把传输层塞进设置契约；端点清单与围栏归控制器所有。

**保留 `/m` 并给它也做设置一致性。** 否决：用户经桌面 shell 访问主机；第二种移动渲染只是为惯性保留的表面复制了传输、主题与配对代码。

## 后果

- 配对隧道的手机能看到实时设置文档，且可通过一个 `cordis.yml` 字段获得写权限；不开时每次写入都呈现有名可查的拒绝，而不是静默无操作或未授权的成功。
- request-facts 通道按构造即进程内：worker 线程或子进程能力重新分发设置调用时事实丢失，落回桌面一侧。未来跨进程分发必须显式转发该标记。
- `/m` 移除后 ui-remote 缩为桌面面板；每次客户端构建少产出一个 bundle 工件，mobile-css-inline Agent Note 的主题（独立移动工件）不复存在——该 Note 随目录一并退役。
- ui-settings 测试与共享客户端测试桩默认 `writable: true`；需要只读姿态的 spec 显式发布它。
