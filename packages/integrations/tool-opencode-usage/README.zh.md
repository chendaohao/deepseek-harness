# @deepseek-ai/dsh-tool-opencode-usage

[English](README.md) | 中文

模型可见的 `opencode_usage` 工具：查询 OpenCode Go 订阅用量——5 小时滚动、本周、本月三个窗口的已用百分比与重置时间。

## 功能

在 `ctx.tools` 上注册一个工具 `opencode_usage(mode?)`，并注册一段简短的 system-prompt 引导。工具通过两种获取模式之一查询 OpenCode Go：

- **api-key**：`GET <baseUrl>/zen/go/v1/usage`，携带 `Authorization: Bearer <apiKey>`，解析 `{ usage: { rolling, weekly, monthly } }` 响应。
- **web**：`GET <baseUrl>/workspace/<workspaceId>/go`，携带 `auth` cookie，解析 dashboard HTML——优先 SolidJS SSR 水合载荷，其次 `data-slot` 格式，人类可读倒计时（如 "1 hour 56 minutes"）按请求时钟换算。

`mode` 默认为 `auto`：能解析出 key 时走 api-key 获取，否则走 dashboard 抓取。canonical 结果报告实际使用的模式与三个窗口；响应中缺失或状态非 `ok` 的窗口保持 `null`。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 是否注册工具。 |
| `mode` | `auto` | `api-key`、`web` 或 `auto`。 |
| `apiKey` | — | 显式 OpenCode Go api key。 |
| `apiKeyEnv` | `OPENCODE_GO_API_KEY` | 存放 api key 的环境变量名。 |
| `readOpencodeAuth` | `true` | 是否回退读取 opencode 运行时认证存储。 |
| `workspaceId` / `authCookie` | — | dashboard 抓取凭证（配置或 `OPENCODE_GO_WORKSPACE_ID` / `OPENCODE_GO_AUTH_COOKIE` 环境变量）。 |
| `baseUrl` | `https://opencode.ai` | API 源；测试指向本地 stub。 |
| `timeoutMs` | `15000` | 协作式请求超时。 |

### 凭证解析

api key 按显式优先链解析：`config.apiKey` → 环境变量 `apiKeyEnv` → （`readOpencodeAuth` 开启时）opencode 运行时认证存储 `<XDG_DATA_HOME|~/.local/share>/opencode/auth.json` 的 `opencode-go` 条目。认证存储只是回退，绝非加载期失败：存储缺失、损坏或无对应条目时解析为 null，工具在执行期抛出消息，列出具体缺失的配置来源。dashboard 凭证先取配置，再取 `OPENCODE_GO_WORKSPACE_ID` 与 `OPENCODE_GO_AUTH_COOKIE` 环境变量（与 opencode-quota 生态同名，便于直接复用）。

## 校验

Schema 将 `mode` 约束为 `auto`/\`api-key`/\`web`。`execute` 拒绝：所选模式缺少凭证、HTTP 非 2xx 响应（附状态码与净化摘要）、无法解析的响应体、以及没有任何可用窗口的响应。单个窗口异常置 `null`，不影响整个查询。

## 渲染

canonical 结果为 `{ mode, queriedAt, windows: { rolling, weekly, monthly } }`；Native 渲染器每窗口一行（"5h rolling: 6% used (94% remaining), resets <ISO>"）。待定卡片为 search 类 generic 卡片，标题 "Query OpenCode Go usage"。

## 导出形态

函数/命名空间插件：导出 `name` / `inject` / `apply`，无 default 导出。多余的 `export default` 会被 Loader 的 `unwrapExports` 折叠并丢掉 `inject`（见 [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)）。

## Model Experience

### 工具 schema

#### 模型所见

模型看到生成的 [`opencode_usage` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-opencode-usage)。

#### Token 影响

工具可见的每个请求都有固定 schema 成本。

#### KV Cache 影响

定义与可见性不变时前缀稳定；插件生命周期或作用域限制可能使该 schema 的复用失效。

### 工具调用历史与结果

#### 模型所见

每次助手工具调用携带可选的 `mode` 参数。成功返回上述窗口渲染行。稳定的失败形态包括 `no usable OpenCode Go credentials: set config apiKey, the OPENCODE_GO_API_KEY environment variable, or an 'opencode-go' entry in the opencode auth.json`、`mode '<mode>' needs credentials: ...`、`OpenCode Go usage API error <status>: <snippet>` 以及 `OpenCode Go usage API returned ...` 解析失败。请求向 `baseUrl` 携带 bearer key 或 auth cookie；除工具调用与 canonical 结果外无任何内容被记录。

#### Token 影响

一次调用新增工具调用参数（可选的 `mode`）、canonical 结果与渲染窗口行；结果小且形状固定，与窗口数量无关。

#### KV Cache 影响

追加式；新可见内容跟在可复用请求前缀之后，不使既有 KV-cache 条目失效。

## 已知限制与待办

- **Dashboard 格式漂移** —— web 模式解析当前 SSR 与 `data-slot` 标记；未来标记变更需同步更新两个解析器（解析器有 fixture 单测覆盖）。
- **无 quotaProviders 生态** —— 本包只读取上述 OpenCode Go 来源；openrouter 等其他订阅配额不在范围内。
- **消费侧缺口** —— 工具无法报告 OpenCode Go 按 token 计费模型的用量（订阅只报告百分比窗口）。
