# Agent Note: run_code strip failures carry the first failing line

Status: implemented

English | [中文](2026-08-31-run-code-strip-failure-localization.zh.md)

## Problem

When a `run_code` program failed Node's type-strip, the model received only the parser's message — `Expected ',', got 'ident'` — with no line, column, or code frame, because `stripTypeScriptTypes` throws a bare `SyntaxError`. A real PTC plan session paid for that: the model emitted a `tools.bash({ command: "… echo "exit=$?" …" })` program whose nested raw double quotes ended the string literal early, could not see where parsing stopped, and re-emitted essentially the same malformed snippet for 75 consecutive tool calls (~180 steps, ~20 minutes of LLM time) until the user aborted the turn.

## Decision

The worker-thread code runtime localizes the failure before handing it to the model. On a strip `SyntaxError`, it bisects the smallest program-line prefix whose wrapped strip fails with the full program's message, then appends a pointer and a numbered excerpt to the failure message:

```
Expected ',', got 'ident'
first syntax error at program line 2:
    1 | const first = await tools.bash({ command: "pwd" });
>   2 | const res = await tools.bash({ command: "git show …; echo "exit=$?"" … });
    3 | return res.stdout.text;
```

The bisection rests on parsing being prefix-deterministic: the parser scans left to right, so every line prefix that contains the first offending token fails with the identical message and no shorter prefix does — which makes "prefix reproduces the full message" monotone and binary-searchable. The strip is position-preserving and the `async function` wrap adds exactly one line, so the excerpt's line numbers are the program's own. Line bisection re-strips at most ⌈log₂ lines⌉ times host-side; no worker ever spawns for a strip failure, so nothing else changes for the happy path. Failures thrown inside the worker keep their own messages untouched.

## Verification

- The real-world failure shape (nested raw double quotes inside the `command` string) now reports `first syntax error at program line 2` with the offending line marked.
- A deliberate error on line 4 of a five-line program localizes to line 4; a single-line program localizes to line 1; excerpt neighbors render with the failing line marked.
- In-worker thrown failures keep their own message (no appended excerpt).
- `packages/code-runtime/code-runtime-worker-thread/tests`: 5 files, 108/108 pass.

## Alternatives considered

**Parse with a second parser that reports positions (esbuild, oxlint's parser, oxc).** Rejected — a second parser can disagree with the stripping parser about what is an error, and the runtime would carry a parser dependency purely for diagnostics.

**Append a static quoting hint to every strip failure.** Rejected — the hint would be speculation on most failures (there are many ways to write a syntax error), and speculation that does not apply erodes the message's reliability; the located line itself is the durable fix.

**Localize in the tools layer (`run_code`) instead of the runtime.** Rejected — the strip step and its function wrap live in the worker-thread backend; a tools-side reimplementation would duplicate the wrap offsets and diverge from the Python backend's failure reporting.

## Consequences

Syntax-failing programs now get a self-correctable failure at a bounded host cost (a dozen extra in-process strips, worker still never spawned). Failure messages grow by up to three excerpt lines capped at 200 characters each, inside the existing output ledger. The excerpt numbers are the program's own lines, so the model can edit the exact line. Node upgrade note: the localization keys on `SyntaxError` plus message equality, not on Node's error text, so a future Node that enriches the message keeps working — the pointer line simply duplicates information the message may then already carry.

## Related

- [CodeGraph MCP tools never registered without an inject declaration](2026-08-31-codegraph-tools-inject-declaration.md) — the same session analysis that surfaced both defects; that note covers the missing-tools half.
