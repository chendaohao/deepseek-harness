# vision-agent

简体中文 | [English](README.md)

[视觉能力家族](../../packages/vision/README.md) 的可运行示例：纯文本主模型路由仍能看图——请求桥接把粘贴图片转换为文本证据，`vision_observe` 工具把本地图片文件转换为文本证据。视觉模型是 LLM 能力缝上的独立路由，通常是声明 `input: [text, image]` 的 `llm-pi-ai`。

## 运行

```sh
# repo root .env (gitignored) or exported env:
#   OPENAI_API_KEY=sk-…   # the vision route's key
#   DEEPSEEK_API_KEY=sk-… # the main model's key
pnpm dsh --profile web --patch examples/vision-agent/cordis.yml
```

在输入框粘贴图片：桥接通过视觉路由观察它，主模型基于证据回答。让 agent 对本地文件调用 `vision_observe` 即可走工具路径。

## 组合

`cordis.yml` 按加载顺序挂载能力缝：`llm` + `llm-pi-ai`（视觉路由）、`attachment-local`（持久化图片字节）、`vision-llm`（加载时校验路由）、然后是 `vision-bridge` 与 `tool-vision` 两个消费方。把 `openai` profile 换成任何声明图片输入的 pi-ai 路由即可；凭证按请求经凭证存储解析。

## Keyless 冒烟

`tests/keyless-smoke.e2e.ts` 用 mock 视觉路由（`tests/fixtures/`）启动真实 Loader 树，验证能力缝元数据、`vision_observe` 注册，以及经 attachment 能力缝的真实观察往返。