---
kind: upgrade-guide
description: "A model switch inside a started conversation no longer rewrites the deployment default model."
---

# A started conversation keeps its model switch

English | [中文](guide.zh.md)

## Change

`session/selectModel` still records the selection for that Session, but it saves the selection as the deployment default only when the Session has no recorded turn. A conversation that has already started keeps its switch local: its own route advances from the next step, while Sessions created afterwards keep starting from the previously saved default.

Switching models in the composer of a new, unstarted conversation still sets the default, which is the gesture that states a preference for later Sessions. The [default model](../../../../packages/core/agent-default-model/README.md) service itself is unchanged and still writes whatever a caller saves.

Consumers that relied on any Session's pick becoming the default must now send that intent through an unstarted Session, or write the default explicitly. No wire field, event, or stored setting changes: the same `agent-default-model` settings section is written, just less often.

## Migration

1. Client entries that offer "switch this conversation's model" keep working; remove any copy promising that the switch also changes the default for new Sessions.
2. A workflow that pinned the deployment default by switching an existing conversation must switch an unstarted one instead, or set the default through the settings section directly.
3. Confirm that switching models in a conversation with recorded turns leaves `agent-default-model` untouched, and that the same switch in a new conversation still updates it.
