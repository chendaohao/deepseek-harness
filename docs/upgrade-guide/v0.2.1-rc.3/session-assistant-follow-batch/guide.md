---
kind: upgrade-guide
description: "A session/follow opening that continues the caller's window no longer carries the live attempt's compact Assistant stream."
---
# Session follow adds assistant-stream-batch

English | [中文](guide.zh.md)

## Change

`session/follow` can emit `{ type: 'assistant-stream-batch', frames: [...] }` after an attempt's first chunk. Each nested frame keeps its original revision and index. Clients that only handle `assistant-stream` can reject or skip these batches. `assistantStreamBatchSize` defaults to 64.

An opening that answers a caller's `afterSeq` (`continued: true`) no longer carries `assistantStream.activeAttempt.stream`. It carries the attempt's `attemptId`, `startedAfterSeq`, `turn`, `step`, and `nextIndex` only. Such a caller already holds every durable event the prefix described, so the Host sends the cursor metadata needed to accept later frames and nothing else. An ordinary opening still sends the whole compact prefix. A Client that expands `stream` unconditionally reconstructs zero transient rows and then accepts the frames that follow, so it keeps working.

## Migration

1. Update the Client's `SessionFollowFrame` handling to iterate `frames` in order and apply the existing revision-continuity check to every nested frame. Do not treat a batch as one revision or discard the per-frame indexes.
2. Stop relying on `assistantStream.activeAttempt.stream` at a `continued` opening. Reseed the attempt's cursor state from the metadata and let the durable settlement carry the text; expanding an empty `stream` is already correct, so only code that assumed a non-empty prefix needs changing.
3. If you cannot update the Client immediately, set `assistantStreamBatchSize: 1` in the `SessionController` row of `cordis.yml` to keep every Assistant frame in its original single-frame form.
4. Confirm with a reconnect mid-attempt: the resumed attempt's next frame is accepted at its own index, and the durable settlement still reconstructs the full text.
