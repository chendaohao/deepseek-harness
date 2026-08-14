# @deepseek-ai/dsh-vision-llm

简体中文 | [English](README.md)

基于 LLM 能力缝的 `ctx.vision` 实现：把观察请求流式发送到配置的视觉能力模型路由。凭证、重试策略、流式都属于该路由自己的 adapter（通常是 `@deepseek-ai/dsh-llm-pi-ai`）；本包不接触 Provider 线格式或密钥。

## 配置

```yaml
- id: vision-llm
  name: '@deepseek-ai/dsh-vision-llm'
  config:
    # LLM seam provider route that serves the vision model (e.g. an llm-pi-ai route).
    provider: openai
    # Exact model id on that route; the model must declare image input.
    model: gpt-4o-mini
    # System instruction sent with every observation request (default below).
    prompt: "You are a vision observer ..."
    # Maximum images observed in one request (default 4).
    maxImagesPerRequest: 4
    # Cap on observation output tokens; absent leaves the provider default.
    maxTokens: 512
```

默认观察指令是稳定的模型可见文本：

> You are a vision observer for a text-only agent. Examine the image(s) precisely and describe their content as evidence another model will quote. Report visible text verbatim, layout and structure, objects, people, charts, numbers, and UI elements. Do not infer what is not visible. End with a one-line summary.

路由无法解析或模型未声明 `image` 输入时，加载即失败（`VISION_UNCONFIGURED`）：永远无法成功的观察是部署配置错误，而不是运行时意外。请在本插件之前加载带该路由的 `@deepseek-ai/dsh-llm-pi-ai`（或其它 adapter）。

## Model Experience

### 观察请求上下文

#### 模型所见

每次观察请求把配置的 `prompt` 作为系统槽，发送一条用户消息，内容为可选的 `question` 文本后接图片块。Provider adapter 把持久化图片引用解析为 Provider 原生图片输入；模型的回复成为证据文本。

#### Token 效果

每次观察：系统提示词加问题文本作为输入 token，证据文本（配置 `maxTokens` 时受限）作为输出 token。多图合并为一次请求可共享系统提示词。

#### KV Cache 效果

配置的 `prompt` 不变时系统提示词前缀稳定，Provider 侧前缀缓存按路由生效。

## Known Limitations and Deferred Work

- **无本地回退**——仅云端视觉；本地 OCR/视觉 Provider 是未来的 Provider，不是本实现的一种模式。
- **路由能力以 adapter 声明为准**——声明 `image` 输入但端点拒绝图片的模型，按 LLM 能力缝的能力契约在回合中途失败。