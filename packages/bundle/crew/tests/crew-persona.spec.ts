/**
 * The Crew role personas are model-visible contracts: the review verdict rules
 * and the commander's reporting subject rule are the two surfaces history showed
 * drifting under output pressure. These snapshots pin the rules verbatim, so a
 * wording change that reintroduces a forced PASS or erases a delegated role from
 * the report fails here before it reaches a model.
 *
 * The patch is read through the real loader parser (`loadOverlayPatches`, the
 * same `entryListSchema` boot uses), so the test sees the deployed `!!js`
 * semantics and fails if the persona rows are renamed or restructured.
 */

import { fileURLToPath } from 'node:url'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { describe, expect, it } from 'vitest'

const PATCH_PATH = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))

/** The keys these snapshots read from one entry's config. */
interface EntryConfig {
  prefix?: string
  roleDescription?: string
  plugins?: PatchRow[]
}

/** One loader patch row as the overlay declares it: a keyed config, or a `cordis:group`'s child entries. */
interface PatchRow {
  id?: string
  group?: boolean | null
  config?: EntryConfig | PatchRow[]
}

/** Read one row's keyed config, refusing an entry that carries a group's child list instead. */
function configOf(rows: readonly PatchRow[], id: string): EntryConfig {
  const row = rows.find(entry => entry.id === id)
  expect(row, `entry ${id} in ${PATCH_PATH}`).toBeDefined()
  const config = row!.config
  if (config === undefined || Array.isArray(config)) throw new Error(`${id}: expected a keyed config in ${PATCH_PATH}`)
  return config
}

/** One persona config keyed by the preset row that declares it. */
function personaOf(rows: readonly PatchRow[], id: string) {
  const persona = configOf(configOf(rows, id).plugins ?? [], 'persona')
  expect(persona.prefix, `persona prefix of ${id}`).toBeTruthy()
  return persona.prefix!
}

/** The model-visible `roleDescription` of one delegation row inside a preset's `delegation` group. */
function delegationRoleDescription(rows: readonly PatchRow[], presetId: string, rowId: string): string {
  const delegation = configOf(rows, presetId).plugins?.find(plugin => plugin.id === 'delegation')
  expect(delegation, `delegation group of ${presetId}`).toBeDefined()
  const children = delegation!.config
  if (!Array.isArray(children)) throw new Error(`delegation group of ${presetId} lists child entries`)
  const description = configOf(children, rowId).roleDescription
  expect(description, `${rowId} roleDescription of ${presetId}`).toBeTruthy()
  return description!
}

const rows: readonly PatchRow[] = loadOverlayPatches('crew-persona-snapshot', PATCH_PATH).flatMap(patch => patch.insert ?? [])
const commander = personaOf(rows, 'preset-crew')
const reviewer = personaOf(rows, 'preset-crew-reviewer')
const worker = personaOf(rows, 'preset-crew-worker')

describe('crew model-visible persona rules', () => {
  it('freezes the commander rule text verbatim', () => {
    expect(commander).toContain(
      'A batch gets at most three review rounds on the same acceptance criteria; a fourth FAIL means the criteria were wrong, not that the worker is careless. '
      + 'When substance still fails after the third re-audit, the reviewer must close FAIL with the unresolved items, and you must not call the batch complete. '
      + 'Your escape is never a fourth round on the same criteria: revise the criteria you can show were wrong and reopen as a new task with a fresh audit, '
      + 'or accept and hand the remaining risk to the user in your report. You may accept only what the user can observe; you may not downgrade an open defect on the current '
      + 'acceptance criteria, factual correctness, state continuity, or this batch\'s own artifacts into a backlog note.',
    )
    expect(commander).toContain(
      'Name the role that did each action: "I verified", "I accepted", and "I decided" are yours; implementation actions you delegated belong to their role '
      + '— "worker fixed the patch", "reviewer audited the delivery" — never "I fixed" or "I ran the tests".',
    )
    expect(commander).toContain(
      'A user-requested local checkpoint commit may proceed after its scope and validation are verified; it is not final delivery. '
      + 'No delivery PASS: do not push, publish, or call the work complete.',
    )
  })

  it('freezes the reviewer rule text verbatim', () => {
    expect(reviewer).toContain(
      'Round cap (hard requirement): a batch gets at most three re-audits on the same acceptance criteria; there is no fourth round on those criteria. '
      + 'When substance still fails after the third re-audit, close FAIL with every unresolved item in the report — never PASS. '
      + 'Only the commander moves past that verdict: by revising criteria it can show were wrong and reopening as a new task with a fresh audit, '
      + 'or by handing the remaining risk to the user.',
    )
  })

  it('no longer carries the old forced-PASS and backlog-downgrade wording', () => {
    expect(commander).not.toContain('accept with the residue')
    expect(reviewer).not.toContain('close with PASS and list the outstanding items')
  })

  it('pins dependency-based parallel dispatch before the first delegation', () => {
    expect(commander).toContain(
      'Before the first delegation, classify every intended task by whether its inputs are already available and whether its write targets are disjoint. '
      + 'Independent work includes planning, read-only probes, and implementation; start all of it in parallel in one message, 2 to 5 roles, '
      + 'instead of waiting for a planner or probe before starting another independent role.',
    )
    expect(commander).toContain(
      'Serialize a task only when it consumes another task\'s output, writes a shared file, or contends for the same external resource.',
    )
  })

  it('pins terminal route recovery to manual replacement and same-child continuation', () => {
    expect(commander).toContain(
      'A terminal quota/authentication failure or a run-budget stop is not a transient settlement. Do not resume or re-delegate it, and never start another child on the same route. '
      + 'Name the affected role and its current route, then ask the user to choose a replacement through the session header\'s route action. '
      + 'After the user confirms the replacement and asks to continue, `send_message` the same role; never create a new Crew session merely to change one role.',
    )
    expect(commander).toContain(
      'If a reviewer cannot start, every completion report must state that independent review did not run; tests and worker self-checks are not a substitute.',
    )
    expect(commander).toContain('A role stopped by a run budget needs a smaller task or an explicit budget change before any continuation.')
  })

  it('keeps the two presets apart so no rule text migrates between roles', () => {
    expect(commander).not.toContain(reviewer.slice(0, 80))
    expect(reviewer).not.toContain(commander.slice(0, 80))
  })

  it('states the hybrid planner trigger once, in the persona', () => {
    expect(commander).toContain('Planner triggering is hybrid.')
    expect(commander).toContain('use planner only when an unresolved design choice has a high cost to reverse')
    expect(commander).toContain('Before any planner call, give it a fact pack:')
    expect(commander).toContain('No plan PASS means no worker for that planned approach.')
    expect(commander).not.toContain('contested design')
  })

  it('leaves the planner tool description purpose-only', () => {
    const description = delegationRoleDescription(rows, 'preset-crew', 'tool-subagent-planner')
    expect(description).not.toContain('contested design')
    expect(description).toContain('decision-complete written plan')
  })

  it('fixes worker reuse to the acceptance objective and keeps budgets out of it', () => {
    expect(commander).toContain(
      'Reuse a worker by acceptance objective, not phase, directory, command count, or remaining budget.',
    )
    expect(commander).toContain(
      'Within one unfinished objective, `send_message` the same worker for implementation, verification, fixes, added evidence, '
      + 'reviewer rework, and separately authorized dry-run and execution; a phase never requires a fresh worker.',
    )
    expect(commander).toContain(
      'Start fresh only for an independent objective, mostly irrelevant or misleading context, clear drift, '
      + 'two identical failed recovery attempts, an unrecoverable child after evidence handoff, or a user-approved independent split.',
    )
    expect(commander).toContain(
      'Shared files and compile serialization order steps within that worker; they do not create one-command workers.',
    )
    expect(commander).toContain('Route and budget exceptions follow the rules below.')
    expect(commander).toContain('Worker self-verification is not independent acceptance, and a dry-run never authorizes execution.')
    expect(commander).toContain('Run budgets are per turn and never justify reuse.')
    expect(commander).toContain('Do not automatically resume a budget-stopped or terminal quota/auth-failed worker.')
  })

  it('no longer treats a phase as a fresh-worker condition', () => {
    expect(commander).not.toContain('new acceptance objective or phase')
    expect(commander).not.toContain('Start a fresh worker for a new acceptance objective or phase')
    expect(commander).not.toContain('by directory or remaining budget')
  })

  it('pins the recovery order: inventory, on-disk evidence, background work, then continue or replace', () => {
    expect(commander).toContain(
      'After a process restart, or when a settlement lacks a closing message, recover before dispatching: call `list_agents`; '
      + 'read reports, changed files, and logs; inspect recorded jobs or ask the original worker to collect them; then continue or replace.',
    )
    expect(commander).toContain(
      '`inactive` only means no turn is executing, and an infrastructure `aborted` outcome is unknown until evidence establishes it.',
    )
    expect(commander).toContain(
      'A closing message is not completion evidence; judge each criterion from artifacts, '
      + 'and never rerun a step with complete success evidence merely because that message is absent.',
    )
  })

  it('keeps a running worker exclusive and forbids retrying an unknown mutation', () => {
    expect(commander).toContain(
      'Keep a running worker exclusive: steer it with `send_message`, wait unless it drifts, '
      + 'and never start a replacement or duplicate its active command.',
    )
    expect(commander).toContain(
      'For an inactive or infrastructure-aborted worker on the same objective, send only the evidence inventory and unmet criteria; '
      + 'accept satisfied criteria without another command and have it supply any missing report.',
    )
    expect(commander).toContain(
      'If follow-up is impossible or two identical recovery attempts fail, settle running work, collect artifacts and jobs, '
      + 'and start at most one replacement with completed evidence and remaining criteria.',
    )
    expect(commander).toContain(
      'Unknown mutation effects block retry and dependent work until verified; if unverifiable, report unknown and ask the user.',
    )
    expect(commander).toContain(
      'Do not resume intentional user or ancestor aborts; terminal route and budget rules below take precedence.',
    )
  })

  it('gives the closing-message and no-rerun rule one home in the recovery line', () => {
    const closingMessageLines = commander.split('\n').filter(line => line.includes('closing message'))
    expect(closingMessageLines).toHaveLength(1)
    expect(closingMessageLines[0]).toContain('recover before dispatching')
    expect(closingMessageLines[0]).toContain('never rerun a step with complete success evidence')
    expect(commander).not.toContain('Never assume it did nothing.')
    expect(commander).not.toContain('check for an interim report first')
    // The delegated-work section keeps its own evidence rules and adds none of these.
    expect(commander).toContain('you trust artifacts, not narration.')
    expect(commander).toContain('A failing role still writes a report: where it got stuck, what it tried, where the evidence is.')
  })

  it('gives the worker its own recording and collection duty without commander acceptance rules', () => {
    expect(worker).toContain(
      'Before a long or verification command, write the active milestone, exact command, cwd, and log path to the assigned report; '
      + 'record the background job/process id when available.',
    )
    expect(worker).toContain(
      'At settlement, add the exit code or an explicitly unknown outcome and artifact paths.',
    )
    expect(worker).toContain(
      'On continuation, first report and collect those existing records and jobs for the commander.',
    )
    expect(worker).not.toContain('closing message')
    expect(worker).not.toContain('accept satisfied criteria')
    expect(worker).not.toContain('start at most one replacement')
  })

  it('pins automatic compaction to the same unfinished objective and leaves replacement to the recovery rule', () => {
    expect(commander).toContain('Let automatic compaction continue an unfinished objective when the worker\'s context remains relevant.')
    expect(commander).toContain('Do not compact merely to reuse a worker for a new objective; hand off the report and start fresh.')
    expect(commander).not.toContain('Before replacing a running worker, stop or settle it and inspect its artifacts and background jobs.')
  })
})
