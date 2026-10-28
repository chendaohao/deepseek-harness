---
kind: upgrade-guide
description: "Session follow can emit assistant-stream-batch frames; older Clients must expand them or use single-frame batching."
---
# Session follow adds assistant-stream-batch

English | [中文](guide.zh.md)

## Change

`session/follow` can now emit `{ type: 'assistant-stream-batch', frames: [...] }` after an attempt's first chunk. Each nested frame keeps its original revision and index. Clients that only handle `assistant-stream` can reject or skip these batches. Updated Clients expand them automatically. `assistantStreamBatchSize` defaults to 64.

## Migration

1. Update the Client's `SessionFollowFrame` handling to iterate `frames` in order and apply the existing revision-continuity check to every nested frame. Do not treat a batch as one revision or discard the per-frame indexes.
2. If you cannot update the Client immediately, set `assistantStreamBatchSize: 1` in the `SessionController` row of `cordis.yml` to keep every Assistant frame in its original single-frame form.
3. Confirm with multiple chunks: the attempt start and first chunk arrive as `assistant-stream`, later chunks arrive in order, and the attempt ends with continuous revisions and unchanged durable event seq values.
