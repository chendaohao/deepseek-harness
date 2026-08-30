# Agent Note: run_code strip failures carry the first failing line

Status: implemented

[English](2026-08-31-run-code-strip-failure-localization.md) | 中文

## Problem

`run_code` 程序没有通过 Node 的类型剥离时，模型只会收到解析器的消息——`Expected ',', got 'ident'`——没有行号、列号或代码帧，因为 `stripTypeScriptTypes` 抛出的是不带位置信息的裸 `SyntaxError`。一个真实的 PTC plan 会话为此付出了代价：模型生成了 `tools.bash({ command: "… echo "exit=$?" …" })` 这样内层裸双引号提前终结字符串字面量的程序，看不见解析在哪里停止，于是把本质上相同的坏代码连续重发了 75 次工具调用（约 180 步、约 20 分钟 LLM 时间），直到用户中止回合。

## Decision

worker-thread 代码运行时在把失败交给模型之前先做行级定位。遇到 strip 的 `SyntaxError` 时，它二分出"包裹后 strip 会以完整程序相同消息失败"的最小程序行前缀，然后在失败消息后追加定位指针和带行号的节选：

```
Expected ',', got 'ident'
first syntax error at program line 2:
    1 | const first = await tools.bash({ command: "pwd" });
>   2 | const res = await tools.bash({ command: "git show …; echo "exit=$?"" … });
    3 | return res.stdout.text;
```

二分的前提是解析具有前缀确定性：解析器从左到右扫描，任何包含第一个出错 token 的行前缀都会以相同消息失败，更短的前缀则不会——这使"前缀复现完整消息"成为单调谓词，可以二分。strip 保持位置不变、`async function` 包裹恰好增加一行，所以节选的行号就是程序自己的行号。行二分在宿主侧至多重复 strip ⌈log₂ 行数⌉ 次；strip 失败从不产生 worker，正常路径不受任何影响。worker 内部抛出的失败保持自身消息不变。

## Verification

- 真实故障形态（`command` 字符串内嵌裸双引号）现在报告 `first syntax error at program line 2` 并标记出错行。
- 五行程序里第 4 行的刻意错误定位到第 4 行；单行程序定位到第 1 行；节选展示相邻行并标记失败行。
- worker 内抛出的失败保持自身消息（不追加节选）。
- `packages/code-runtime/code-runtime-worker-thread/tests`：5 个文件，108/108 通过。

## Alternatives considered

**换一个能报告位置的解析器（esbuild、oxlint 的解析器、oxc）做诊断。** 否决——第二个解析器可能与 strip 用的解析器对"什么是错误"判断不一致，而且运行时会为纯诊断目的背上解析器依赖。

**给每个 strip 失败追加静态的引号书写提示。** 否决——大多数失败场景下这是猜测（写出语法错误的方式有很多），不适用的提示会侵蚀消息的可信度；定位到行本身才是持久的修复。

**在 tools 层（`run_code`）而非运行时里定位。** 否决——strip 步骤和它的函数包裹都在 worker-thread 后端；tools 侧重新实现会复制包裹偏移，并与 Python 后端的失败报告分叉。

## Consequences

语法失败的程序现在得到可自我纠正的失败信息，宿主成本有界（至多十几次进程内 strip，依旧不产生 worker）。失败消息至多增长三行节选、每行截断在 200 字符以内，仍受既有输出账本约束。节选行号就是程序自己的行，模型可以直接修改那一行。Node 升级注意：定位只依赖 `SyntaxError` 和消息相等，不依赖 Node 的错误文本——未来 Node 若丰富了消息，定位依然工作，只是指针行会与消息自带的信息重复。

## Related

- [CodeGraph MCP tools never registered without an inject declaration](2026-08-31-codegraph-tools-inject-declaration.zh.md)——同一次会话分析暴露的两个缺陷；该笔记覆盖工具缺失的另一半。
