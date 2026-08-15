# Agent Note: vision tools delegate image-format detection to the attachment store

Status: implemented

[English](2026-08-15-vision-tools-delegate-format-detection-to-store.md) | 中文

## 问题

`vision_observe` 与 `read_image` 对每次调用都施加路径扩展名允许列表（PNG/JPEG/WebP/GIF），任何没有可识别扩展名的路径都会在触碰文件之前被拒绝，即使字节本身是合法图片。attachment store 的准入本就会通过完整解码光栅（sharp）检测真实格式，并被文档声明为权威；工具层的门禁在它之前复制了一个更弱、基于扩展名的检查。附件库按 sha256 命名的对象（`~/.dsh/attachments/v1/objects/<sha256-prefix>/<sha256>`）没有扩展名，因此直接观察已提交的图片会以 `only accepts PNG/JPEG/WebP/GIF paths` 失败，直到把文件复制成带扩展名的名字。部署的 `mediaTypes` 允许列表同样只由这两个工具在 store 之前强制执行，而准入归 store 所有。

## 决策

`SaveImageAttachment.mediaType` 现在可选。store 的准入（`inspectMetadata`）完整解码字节，对检测出的类型强制执行部署的 `mediaTypes` 允许列表（`IMAGE_TYPE_NOT_ALLOWED`），并且只在调用方声明了类型时做交叉校验（`IMAGE_TYPE_MISMATCH` 对仍声明类型的调用方如浏览器上传路径保持不变）。两个工具都删除了扩展名允许列表和 mediaTypes 预检：它们读取有界字节后调用 `saveImage({ data, name })`，由 store 检测格式。文件的扩展名不再决定准入。

## 考虑过的替代方案

**工具侧按魔数嗅探。** 已拒绝：它会在两个工具（或一个共享 helper）中复制 attachment store 的权威 sharp 解码，为格式身份引入第二个事实来源，而且若不重写 store 的准入，仍无法在读取之前拒绝。

**保留扩展名门禁并为无扩展名路径增加逃生通道。** 已拒绝：为哈希命名路径加特例，会在保留误导性门禁的同时再开一条绕过它的路径。

## 后果

无扩展名和扩展名错误的图片文件现在都能在两个工具中工作（store 检测真实格式）；非图片文件会先按字节上限读取，然后由 store 以 `Unsupported or malformed image data.` 拒绝（此前在任何 I/O 之前就按扩展名拒绝——已列为已知限制）。仍然声明类型的调用方（浏览器上传）保持严格的交叉校验。

`gen-cordis-api` 目录生成器还需要在 `SERVICE_WALK_EXEMPTIONS` 中映射 `visionBridge` 标记服务（自 vision bridge 落地后就缺失，导致目录门禁失败）；豁免项把 `dsh-vision-bridge` 记为文档归属方。

验证：单元覆盖固定了检测格式准入、对检测类型执行允许列表拒绝、保留声明类型交叉校验、两个工具与扩展名无关的成功路径，以及非图片拒绝；`verify-cordis-api` 通过。
