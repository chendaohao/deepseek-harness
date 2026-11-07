---
kind: upgrade-guide
description: "Crew commanders no longer expose general shell or filesystem mutation tools; implementation moves to worker and Git writes use approved crew_git calls."
---

# Crew commanders require delegated implementation

English | [中文](guide.zh.md)

## Change

Previously, a Crew commander could use `bash` or `pwsh`, `write`, and `edit` to implement a task itself, including after skipping every delegation role. New Crew sessions remove those capabilities. Direct reads and answers remain available, while every implementation action belongs to `worker`. Git operations use `crew_git`: write operations require approval, and every call applies the Session sandbox and disables repository-selected command hooks. Existing sessions retain the plugin revision with which they started.

## Migration

1. Create a new Crew session after upgrading. Delegate every file mutation, general command, build, test, and deployment to `worker`; the commander no longer offers a direct-implementation fallback for small tasks.
2. Use `crew_git` for commander-owned Git operations. Review and approve each write operation when prompted. If approval is unavailable or rejected, treat the operation as not performed.
3. Confirm the new session's tool catalog contains `worker`, `planner`, `reviewer`, `read`, and `crew_git`, and does not contain `bash`, `pwsh`, `write`, or `edit`.
4. Expect reads to report stored bytes for filtered files and not to verify commit signatures. `crew_git` uses command-local environment key/value pairs to blank every configured program key, including keys whose subsection contains `=`. It disables `log.showSignature`, replaces repository `format.pretty` with `medium`, rejects `%G…` placeholders in `--format=`, clears inherited Git trace destinations, and refuses the read with `CREW_GIT_CONFIG_UNREADABLE` when the complete key listing exceeds `maxOutputBytes`. Nothing is written to the configuration or index.
5. Keep repositories' filters for writes. `checkout`, `commit`, and `merge` retain the filters and merge drivers a working tree depends on; the approval prompt is what puts that consequence in front of the user.
6. Pass `--message=` to `crew_git commit`. Its stdin is closed and it refuses to open an editor, so a commit without a message fails immediately instead of waiting; the same applies to `merge` without `--no-edit` or `-m`.
