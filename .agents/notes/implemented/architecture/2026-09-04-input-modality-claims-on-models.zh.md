# Agent Note: 已发现与手工声明模型的输入模态声明

Status: implemented

[English](2026-09-04-input-modality-claims-on-models.md) | 中文

## 问题

未写 `input` 字段的手工声明 pi-ai 模型会解析为路由的 `defaultInput`（`['text']`），因此向具备视觉能力的第三方模型发图——触发场景是网关背后的 `glm-5.3-flash`——在请求离开 harness 之前就被 `MODEL_DOES_NOT_SUPPORT_IMAGES` 拒绝。两条本可知道得更多的路径都没有披露模态：模型发现只从列表回复解析 id、名称与容量，Models 页面则完全没有 `input` 字段的编辑入口。唯一的修法是手改 `settings.yaml`。

## 决策

`LlmDiscoveredModel` 增加 `input?: readonly ('text' | 'image')[]`，`dsh-llm` 的 `discoverModels` 去重重建时原样透传。`dsh-llm-pi-ai` 读取两种列表写法——OpenAI 风格的顶层 `modalities` 与 OpenRouter 的 `architecture.input_modalities`——已安装 catalog 路径则转发每个 catalog 条目自己的 `input`。本 harness 不认识的模态词（`audio`、`video`、`file`）逐项丢弃，`text` 旁边混入一个生僻词不会抹掉 text 事实；没有任何认识词的条目不携带 `input` 字段，读作"端点没有说出可用的信息"，由继承决定。

Models 页面把候选的模态采纳进可编辑行，在选择器里给声明了图像的候选加徽标，并在容量折叠区按行编辑该声明：勾选**图像**存储 `input: ['text', 'image']`，取消勾选留下显式的纯文本 `input: ['text']`，没有 `input` 字段的行走继承。共享校验器拒绝不是字符串列表、或缺少 `text` 的已存 `input`——没有 `text` 的列表命名不出可用模型，拒绝按行报告，而不是让加载器拒绝整个配置段。

该声明仍维持 `llm-pi-ai` 配置 schema 早已定义的语义：对端点的断言，而非对端点的检查。端点若在声明之下仍拒绝图像，依旧在对话中途由提供方报错。

## 备选方案

**取消勾选图像时删除整个字段。** 这会让复选框在"声明纯文本"与"继承"之间切换，但两个状态并非用户会放在一起推理的相邻事实——继承是 catalog 层的属性，唯一可见信号会是一个悄然失去意义的复选框。取消勾选得到显式 `['text']`，恰好说出用户表达的内容。

**仅在没有认识词残留时整体丢弃。** 原样保留 `['text', 'image', 'audio']` 会转发 pi-ai schema（`MODALITIES`）拒绝的值，加载时使配置段失效；逐词过滤是既保留已知事实、又不虚构 schema 面的唯一写法。

**现在就暴露 audio/video。** 没有 harness 适配器服务它们，没有消费者的 schema 面是投机性配置。

**DeepSeek catalog 也开放模态编辑。** DeepSeek 直连适配器的 catalog 按自有固定 schema 校验，其官方模型的模态不是部署选择；那里的编辑器只会宣传一个没有有意义取值的旋钮。

## 后果

具备视觉能力的网关模型可以从 Models 页面开始收图：获取、看徽标、采纳，或勾一个复选框。不报告模态的列表维持现状——行走继承，端点不置可否时的纯文本判定仍需手写 YAML 的 `input` 字段。校验器的形态检查可能拒绝 schema 同样会拒绝的手改值；无论哪种，页面都会按行报告。
