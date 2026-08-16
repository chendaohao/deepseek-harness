# @deepseek-ai/dsh-client-ui-settings-remote

[English](README.md) | 中文

Web 设置的**远程访问**页：remote-access 配对门的已绑定设备列表。浏览器插件注册一个本地化的 `settings.section` 贡献（id `remote`，排在通用、模型、插件之后）；设置壳拥有导航与面板外观。插件激活期间不发起任何 Remote 读取；打开页面时惰性调用 `ctx.remote.remoteAccessDevices.list()`（经 [`api-remotes`](../../api/remotes/README.md)），且因为插件注入 `remote.remoteAccessDevices` 服务，未开启 `--remote` 的部署上该分区不会激活。

每行显示配对时捕获的设备名（手机提供的名称或浏览器 User-Agent）、绑定日期、相对最近使用时间、滑动自动解绑倒计时（`{n} 天后自动解绑`）——任何被放行的请求都会在宿主机侧刷新该窗口。解绑是两步内联确认，调用 `remoteAccessDevices.unbind` 后重载列表；被解绑设备的下一次请求收到 401 并经二维码流程重新配对。加载、空态与通用失败态留在挂载组件内部；失败可重试且不暴露传输细节。注册使用 `ctx.slots.inject()`，因此跟随分区声明的迟到、重声明、语言切换与卸载，无需导入设置壳。

## Model Experience

无：本包只在浏览器设置中可视化并变更 remote-access 设备注册表，不注册任何模型可见内容。

#### KV Cache effect

无：本包既不组装也不发送 provider 请求。

## Known Limitations and Deferred Work

- **每次挂载或重试只有一个快照**——页面不订阅注册表变化（其他客户端的配对/解绑在重开或重试后出现）。
- **无本机标记**——`dsh_remote` cookie 为 HttpOnly，页面无法把某行匹配到当前浏览器；宿主侧 RPC 不携带调用方身份。
