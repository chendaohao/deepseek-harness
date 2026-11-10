---
description: "Compose a commander and three delegation roles — worker, planner, and reviewer — as Agent presets, each resolving its own model route."
kind: "package-bundle"
---

# @deepseek-ai/dsh-crew

English | [中文](README.zh.md)

## Summary

Compose a commander and three delegation roles — worker, planner, and reviewer — as Agent presets, each resolving its own model route.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Add the bundle to a profile's `dsh.profile.bundles`, after `@deepseek-ai/dsh-web-app`:

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@deepseek-ai/dsh-crew"
      ]
    }
  }
}
```

Select the `crew` preset when creating a session. It appears in the preset roster as **Crew**, ordered after the shipped presets.

| Preset | Selected by a person | Role |
|---|---|---|
| `crew` | yes | Commander: reads the request, splits the work, delegates, verifies deliveries, reports |
| `crew-worker` | no (`userSelectable: false`) | Executor with the full working tool set |
| `crew-planner` | no (`userSelectable: false`) | Writes a plan; does not change code |
| `crew-reviewer` | no (`userSelectable: false`) | Returns PASS or FAIL with citations; changes nothing |

Only `crew` appears in the new-session picker and on the presets page. The three role declarations exist for the delegation rows to mount; naming one in `session.create` is refused rather than starting a role child with no commander above it.

Each delegation row reads its own route namespace, so the three roles can run on three different models; a session that recorded a combination outranks that namespace, and a session that recorded none keeps reading it. This bundle serves those namespaces, so the **Models** settings page shows its crew-route block only in a profile that selects this bundle. Set the routes there under the worker, planner, and reviewer rows; a change reaches a role's next request, including a continuation or a cold resume. With no stored route the row falls back to its `agentOptions` baseline, which the worker row sets from `DSH_CREW_PROVIDER`, `DSH_CREW_MODEL`, and `DSH_CREW_EFFORT`.

The Models page edits a **combination library**, not the live routes: pick a combination, pick one of the three roles, and edit that role's provider, model, and reasoning effort. Saving writes only the library, so editing is never blocked by a role that happens to be running.

A new crew session picks one combination beside the preset chip, and that pick is recorded on the session itself. While the session has not started its first turn, picking another combination replaces the recorded one; once that turn opens, the session keeps what it recorded. Editing the combination library afterwards, or another session picking a different one, leaves this session's routes as they were. A failed delegation is repaired one role at a time from the session, which records the replacement and stops matching its source combination.

The session header's **Change route** action opens the live model catalog and replaces only the selected role through `crewFormation/replaceRole`. Selecting a combination or replacing a role checks the exact model and current adapter authentication without sending an inference request; a refusal leaves the recorded routes unchanged. The change does not retry the failed work. After it lands, ask the commander to continue the original subagent; its next turn reads the replacement route.

Each role turn has configurable step, wall-time, total-token, and repeated-failure limits on `crew-formation.budget`. The defaults are 300 steps, 60 minutes, 50 million tokens including cache reads and writes, and 6 consecutive identical tool failures. The **Subagent** settings page edits all four values. Exhaustion appends `crew/run-budget-exceeded` and blocks or cancels the turn before more work can continue. A running turn keeps its captured limits; saved changes and a manual continuation apply to the next turn.

The commander triggers `planner` on a hybrid rule. A user who asks for a planner or designer gets one; a user who excludes it never gets one; otherwise planner runs only when an unresolved design choice is expensive to reverse — competing interfaces or module ownership, materially different architectures, or a requirements conflict. Before any planner call the commander supplies a fact pack: verified facts with evidence, assumptions, unknowns, user decisions, the target metric, and non-goals. After a planner round the plan goes to `reviewer`, and no plan PASS means no worker for that planned approach. The `planner` tool description states purpose only, so the commander persona is the single home of the trigger rule.

Plans and audits move by delta. A planner's first version is the whole plan; every later version opens with a `## Revision <n>` section listing one line per edit, the section it touched, and the evidence that forced it, and leaves unchanged sections byte-identical. A reviewer reads that section first and then only the sections it names, so an unchanged document is never re-read end to end. Repeating a section in both the delta and its body makes the two drift and doubles the text every later round re-sends.

Worker reuse follows one acceptance objective — the observable result and its criteria — not the phase, the directory, the command count, or the remaining budget. Within one unfinished objective the commander continues the same worker through `send_message` for implementation, verification, fixes, added evidence, reviewer rework, and separately authorized dry-run and execution; a phase change never starts a worker. Only an independent objective, mostly irrelevant or misleading context, clear drift, two identical failed recovery attempts, an unrecoverable child after evidence handoff, or a user-approved independent split starts a fresh worker. Shared files and compile serialization order the steps inside one worker rather than splitting it per command, and a worker's own verification never replaces independent acceptance or turns a dry-run into authorization to execute.

A settlement notice is not a turn of its own. While another role is still running, the commander answers a notice without opening new work — no fresh delegation, no new command, no re-plan — because every notice re-sends the conversation to the model and already carries the child's conclusion plus the report path. The remaining conclusions are read once from disk, after the last running role settles or when the user speaks; a notice that reports a failure or drift still takes the settlement path above.

Recovery reads evidence before it dispatches. After a process restart, or when a settlement arrives without a closing message, the commander calls `list_agents`, reads each child's assigned report, changed files, and logs, inspects the recorded jobs or asks the original worker to collect them, and only then continues or replaces that child. `inactive` means no turn is executing, not success or failure; an infrastructure `aborted` outcome stays unknown until evidence settles it; and a missing closing message alone never reruns a step whose complete success evidence is on disk. A running worker stays exclusive: steer it with `send_message`, and never start a replacement or duplicate its active command. Satisfied criteria are accepted without another command, a missing report is written by the same worker, and when a follow-up is impossible or two identical recovery attempts fail, the commander settles the running work, collects the artifacts and jobs, and starts at most one replacement carrying the completed evidence and the remaining criteria. An unknown mutation effect blocks retry and dependent work until the target state is verified — an unverifiable one is reported as unknown.

The worker keeps the evidence, because a resumed worker and the commander both rely on it: before each long or verification command it records the active milestone, exact command, cwd, and log path in its assigned report, with the background job or process id when available; at settlement it adds the exit code or an explicit `unknown` and the artifact paths; on a continuation it collects those existing records and jobs first.

The worker batches its probes. When a task needs several independent probes of the same tool, CLI, endpoint, or file set, the probe list becomes one script or one shell loop run once, with the matrix written to a log the worker then reads in one bounded slice; the report states the probe count and that log path. Each request re-sends the whole conversation, so the same probe measured in one command costs a fraction of measuring it in ten.

Automatic compaction may carry a worker through the same unfinished objective while its context stays relevant, and is never a way to reuse a worker for a new objective: hand off the report and start fresh. Run budgets apply per turn and never justify reuse, so a budget-stopped or terminal quota/auth-failed worker is not resumed automatically until the user chooses a smaller task, an explicit budget change, or a replacement route; an intentional user or ancestor abort is not resumed at all.

A session's own routes are recorded by the formation service this bundle mounts (`dsh-crew/formation`), and a delegation row reads them through `subagentRouteSettings` before its own stored default. That is why a combination needs no second settings namespace per session: the session log is the store, so a cold resume replays the same routes without consulting the library.

The commander has no general shell or filesystem write/edit tools. Delegate every implementation action to `worker`, including a one-file patch or a single test command. `crew_git` supports the read operations `status`, `diff`, `log`, `show`, `ls-files`, `rev-parse`, `rev-list`, and `branch` queries; the write operations `checkout`, `reset`, `restore`, `stash`, `clean`, `commit`, `push`, `rebase`, `merge`, `switch`, `fetch`, and branch creation require user approval by default. Set `requireWriteApproval: false` on the `crew-commander-git` row, or set its `DSH_CREW_GIT_REQUIRE_WRITE_APPROVAL` environment input to `false`, to authorize writes without per-operation prompts; neither choice bypasses the Session sandbox. Arguments are literal argv values validated against per-operation option allowlists; `log` and `rev-list` also accept `-N` as a decimal commit limit. A count comes from `rev-list --count`, because `git log --count` is silently ignored, and a merge's introduced change count comes from `log --numstat --first-parent`, because `--numstat` alone prints no numbers for a merge. Every call applies the Session sandbox policy, disables repository hooks and filesystem monitors, refuses an editor prompt, and never invokes a shell or an external remote helper.

`branch` has exactly two accepted forms. An allowlisted query (`--list`, `--all`, `--remotes`, `--show-current`, `--contains=`, `--merged=`, `--points-at=`, `--format=`, `--sort=`) is a read; `branch <new-branch> [<start-point>]` creates a ref without switching HEAD, and the tool always passes `--no-track` so `branch.autoSetupMerge` and a remote-tracking start point cannot add upstream configuration. Delete, rename, copy, force, upstream edits, and a caller-supplied track flag have no form.

`fetch` takes one named remote and nothing else: `fetch [--dry-run] [--prune | --no-prune] <remote>`. URLs, paths, user refspecs, extra options, and a remote name outside `[A-Za-z0-9][A-Za-z0-9_-]*` are refused. The tool builds the rest of the argv itself — `--no-tags --no-prune-tags --no-write-fetch-head --no-auto-gc --upload-pack=git-upload-pack --refmap=` plus one fixed refspec into `refs/remotes/<remote>/*` — so repository configuration cannot redirect ref updates into local branches, delete tags, write `FETCH_HEAD`, run automatic maintenance, or name the upload-pack program. Every fetch is a write, including `--dry-run`; its transport and credential helpers keep the approved-write treatment.

A read also refuses every program the checkout's own configuration could run. Before a read starts, the tool lists the Git configuration keys that apply in that repository and uses Git's environment key/value slots to blank every program key — content filters, merge drivers, diff helpers, signing programs, the editor, the transport command, and credential helpers — for that call only. The separate slots preserve subsection names containing `=`. Reads disable `log.showSignature`, replace repository `format.pretty` with `medium`, reject `%G…` signature placeholders in `--format=`, and clear inherited Git trace destinations. If the complete key listing exceeds `maxOutputBytes`, the read fails with `CREW_GIT_CONFIG_UNREADABLE` instead of using incomplete overrides. Nothing is written to the configuration, the index, or their timestamps; a read shows the stored bytes of a filtered file (a Git LFS pointer) rather than its restored content. A write keeps the repository's filters and merge drivers, because a commit and a checkout rely on them; with the default approval requirement, the user's approval puts that consequence in front of the user.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package composes its roles through [cordis.patch.yml](cordis.patch.yml), declared by `dsh.bundle.patch`, and exports the commander-only `crew_git` plugin from its Host module. The layer inserts the three `subagent-*-route-settings` rows, the `subagent-route-presets` row, and four `@deepseek-ai/dsh-agent-preset` declarations, so it depends on the host plane `dsh-web-app` composes: the Agent preset registry and the `subagentRouteSettings` registry. The route rows live here, not in `dsh-web-app`, so a web deployment that selects no crew bundle serves no crew route namespace and the Models page shows no crew-route block; a namespace with no serving row makes its delegation row refuse to load rather than silently route to a different role. The preset row serves the combination library that the picker edits. Creating a session passes its selected combination to `crewFormation/selectRoutes`, which records the complete routes on that session; the per-role resolvers read that record through `subagentRouteSettings`, and only a session without a record falls back to the role route-settings namespaces.

Each role preset is mounted only by its delegation row. The commander's `delegation` group holds the three `tool-subagent` rows; `maxDepth: 1` bounds the chain at one level below the commander. `tool-subagent` stopped accepting a `persona` or `toolFilter` config on 2026-10-09, so a role's persona and tools come only from the preset named by its `agentPreset`.

</details>

<a id="model-experience"></a>
## Model Experience

### Commander and role catalogs

#### What the model sees

The commander sees three delegation tools — `worker`, `planner`, and `reviewer` — with role-specific descriptions, plus `send_message`, `list_agents`, and `interrupt_agent` from the control row. It keeps read/search tools and `crew_git`, but no general shell or filesystem writer. Each role child sees its own preset's tool set, narrowed by `preset-tool-mask`, and a persona stating its boundary: the planner writes a plan, the reviewer judges one, neither claims to change code. The reviewer's catalog does not carry a filesystem editor or a task-board writer at all, so its "write nothing except the report" rule is a property of the composition rather than a request the model has to honour. The planner description states what the role produces; when a planner round is worth spending is one clause of the commander persona.

#### Token effect

The commander's persona is the largest fixed cost in this bundle; it carries the coordination rules that the tool definitions do not enforce. Role children each load their own preset, so no role pays for another role's tools.

#### KV Cache effect

A role child's tool catalog is fixed by its preset, so repeated requests in one child keep a stable prefix. Re-dispatching after a settlement starts a new child and rebuilds the prefix.

## Known Limitations and Deferred Work

- **These rules are prompt constraints, not runtime enforcement.** The hybrid planner trigger, the fact pack, reuse by acceptance objective, the restart recovery order, the worker's evidence records, the compaction choice, and the plan-PASS/delivery-PASS wording all live in the commander and worker personas and the tool descriptions. A commander can still skip a planner round, reuse a worker across objectives, dispatch before reading the reports, rerun a step whose evidence exists, or call work complete without a delivery PASS. Nothing here schedules recovery, pools workers, or refuses a duplicate command; runtime refusal of either is the second delivery.
- **`crew_git` additions stay inside the approved-write model.** `rev-list` and `branch` queries are reads; every `fetch` and a branch creation are writes that a deployment may approve per call, so a deployment running `requireWriteApproval: false` gains unattended fetch and branch creation. `fetch` guarantees local branches, tags, `FETCH_HEAD`, automatic maintenance, and the upload-pack program stay untouched; it does not promise that the rest of `.git` is unchanged, because a fetch writes objects and the target remote-tracking ref. Its transport and credential helpers still run as approved writes.
- **The roles are siblings, not a gate.** A commander can skip planning or review and delegate straight to a worker. The plan PASS and delivery PASS binding, the digest invalidation when a plan changes, and the evidence manifest that make a gate enforceable are a separate delivery.
- **Role boundaries use different mechanisms.** The commander cannot directly implement because its preset omits general shell and filesystem writers. Each role preset also opens with `preset-tool-mask`, which calls `tools.restrict()` on that preset's scope and narrows the inherited global catalog to the names the declaration keeps. The mask is derived rather than hardcoded, so a deployment mounting an extra plugin narrows that too. Planner and reviewer shell rows remain for their declared read/report workflows; their personas still forbid implementation and long commands.
- **The role presets are declared unselectable, not hidden.** Each role carries `userSelectable: false`, so the new-session picker and the presets page offer only `crew`; a `session.create` naming a role is refused with `agent-preset/invalid`. The flag is a roster fact rather than a registry policy: an internal mount names the preset by id and never consults it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
