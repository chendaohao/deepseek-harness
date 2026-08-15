# @deepseek-ai/dsh-tool-vision

简体中文 | [English](README.md)

面向模型的 `vision_observe` 工具：读取 PNG/JPEG/WebP/GIF 文件，字节经 attachment 服务持久化，返回配置的视觉模型为该文件产出的文本证据。

与 `read_image`（要求当前模型路由接受图片输入）不同，`vision_observe` 适用于文本路由：图片从不进入主模型，只有证据进入。对于主模型无法看图的部署，它是 `read_image` 的互补工具。

## 注册

插件仅在 `tools`、`fs`、`vision`、`attachments` 全部挂载时加载（硬注入，不同于多工具文件系统套件中 `read_image` 的条件注册）：没有持久化 attachment 存储就无法提交图片字节，没有 `ctx.vision` 就没有观察器。

## 工具

### `vision_observe`

参数：`file_path`（必填）、`question`（可选）。输出携带 `path`、`evidence` 与已提交的 `image` 引用元数据。渲染出的文本信封固定如下：

```
<path>...</path>
<evidence>
...evidence text...
</evidence>
```

执行在一切文件 I/O 之前先做全部拒绝检查：非空路径、已挂载的 attachment 服务，然后是常规文件读取目标（按会话 cwd 解析、`fs/observed` 事件、attachment 限额的字节上限）。store 的准入从字节中检测图片格式并强制部署的媒体类型允许列表，因此文件的扩展名不决定准入。字节先经 `attachments.saveImage` 提交（内容寻址、幂等）再观察，即使工具结果随后被记录，证据也引用持久化对象。

## Model Experience

### 工具 schema

#### 模型所见

模型看到工具目录中生成的 [`vision_observe` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-vision)，snake_case 参数。插件加载后工具无条件注册（无路由门控——工具的用途恰恰是主模型无法看图时）。

#### Token 效果

无固定指导成本：工具只贡献其 schema。每次执行花费一次观察请求的 token（见 `dsh-vision-llm`）。

#### KV Cache 效果

无——工具不增加系统提示词文本。

## Known Limitations and Deferred Work

- **单次调用单图**——工具观察它读取的单个文件；多图对比是桥接的批次行为，不是本工具的行为。
- **仅云端视觉**——证据来自配置的视觉路由；无本地 OCR 回退。