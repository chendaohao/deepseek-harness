# Agent Note：opencode_usage —— 双获取方式的 OpenCode Go 用量工具

Status: implemented

[English](2026-08-16-opencode-usage-tool.md) | 中文

## 问题

用户的 OpenCode Go 订阅用量（5 小时滚动 / 本周 / 本月百分比窗口）此前只能手工 `curl` `https://opencode.ai/zen/go/v1/usage` 并携带 `~/.local/share/opencode/auth.json` 里的 api key 获取。现成的 OpenCode 侧配额插件（opencode-quota）无法报告它：其 OpenCode Go provider 只支持浏览器 cookie 抓取 dashboard，其 OpenRouter provider 又会拒绝 `limit_remaining: null` 的响应。需求是把用量查询做成 DeepSeek Harness 的一等工具插件，覆盖两种获取场景——key 查询与网页（cookie）查询。

## 决策

**在新增的 `packages/integrations/` 组下添加 `@deepseek-ai/dsh-tool-opencode-usage`，注册 `opencode_usage` 工具，提供两种获取模式与显式优先的凭证链。**

- **api-key 模式** —— `GET <baseUrl>/zen/go/v1/usage`，携带 `Authorization: Bearer <key>`；每个窗口解析 `{status, percent, resetsAt}`，非 `ok`/非法窗口置 `null`，无任何可用窗口的响应使调用失败。
- **web 模式** —— `GET <baseUrl>/workspace/<workspaceId>/go`，携带 `Cookie: auth=<cookie>`；优先解析 SolidJS SSR 水合载荷（两种字段序），回退 `data-slot` 格式，人类可读倒计时按请求时钟换算。
- **模式选择** —— `auto`（默认）优先 api key，回退 dashboard 抓取；工具 `mode` 参数覆盖配置。
- **凭证链** —— api key：`config.apiKey` → 环境变量 `OPENCODE_GO_API_KEY` → opencode 运行时认证存储（`<XDG_DATA_HOME|~/.local/share>/opencode/auth.json` 的 `opencode-go` 条目，可用 `readOpencodeAuth` 关闭）。dashboard：配置 → 环境变量 `OPENCODE_GO_WORKSPACE_ID` / `OPENCODE_GO_AUTH_COOKIE`（沿用 opencode-quota 生态变量名）。凭证缺失在执行期失败并列出缺失来源；工具始终可见（tool-web 先例）。
- **仓库形态** —— 单包持有 schema、凭证解析、查询模式与呈现（tool-todo 先例）；不拆分 Service Definition / Provider / Consumer 三件套（单一外部集成工具不需要能力族）。新组 `integrations/` 而非 `web/`，因为 web 族被定义为搜索/抓取；组容器仿 `packages/mcp`。
- **keyless 快照** —— headless-agent 场景（`opencode-usage.cordis.snapshot.yml`）配脚本化 mock LLM 适配器（`opencode-usage-mock-llm.mjs`），对固定端口（39871）的本地 stub server 调用一次工具；持久化会话与 `snapshots/opencode-usage/session.expected.jsonl` 比较，先把工具实时的 `queriedAt` 规范化为哨兵值（goal 场景规范化先例）。任何环节都不需要 opencode.ai 流量或模型 key。

## 备选方案

- **给上级目录的 opencode-quota 增加 api-key 支持** —— 否决：用户选择了仓库内包；上游 provider 还带着我们无法控制的其它 bug（OpenRouter 的 `null` 校验）。
- **把包放进 `packages/web/`** —— 否决：web 组 README 把该族定义为搜索/抓取操作；外部订阅配额消费不属于网页内容检索。
- **快照录制真实模型会话** —— 否决：脚本化适配器让录制与回放都 keyless 且确定；真实模型录制需要 `DEEPSEEK_API_KEY` 且每次转录变更都会翻新。
- **快照指向随机 stub 端口** —— 否决：提交的场景配置必须在录制与回放间稳定，因此端口固定并在测试中说明（冲突风险仅限于并发快照运行）。

## 后果

- 新组 `packages/integrations/` 出现在 `packages/README.md`、tsconfig.base.json 通配、工具目录与模块图中；包遵循全部仓库门槛（双语 README 含 Model Experience、invariant 伴生、逐文件 100% 覆盖、HMR-safety 与 Loader 组合测试、keyless 快照）。
- `queriedAt` 天然随时间变化，快照套件对其规范化；canonical 结果保留真实的获取时间戳而不是冻结它。
- web 模式解析器锁定当前 dashboard 标记；格式漂移需要同步更新两个解析器（有 fixture 覆盖）。
- 工具默认读取用户的 opencode auth.json，因此已登录 OpenCode Go 的机器零配置即可用；关闭选项保证 CI 与 catalog 采集 hermetic。
