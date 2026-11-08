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
      'Reuse a worker by acceptance objective, not by directory or remaining budget. '
      + 'Within the same unfinished objective, use `send_message` for incremental fixes, added cases, repeated verification, and reviewer-requested rework. '
      + 'Start a fresh worker for a new acceptance objective or phase, an independent task in the same directory, mostly irrelevant old context, or repeated drift. '
      + 'A failure report without a closing message stays with the same worker: check for an interim report first, accept it once it is complete, '
      + 'and replace the worker only after the same failure twice or a clear drift; a new acceptance objective or phase still starts a fresh worker. '
      + 'Files and reports are already shared; reuse only preserves relevant working context.',
    )
    expect(commander).toContain('Run budgets are per turn and never justify reuse.')
    expect(commander).toContain('Do not automatically resume a budget-stopped or terminal quota/auth-failed worker.')
  })

  it('pins automatic compaction to the same unfinished objective and requires settling a running worker first', () => {
    expect(commander).toContain('Let automatic compaction continue an unfinished objective when the worker\'s context remains relevant.')
    expect(commander).toContain('Do not compact merely to reuse a worker for a new objective; hand off the report and start fresh.')
    expect(commander).toContain('Before replacing a running worker, stop or settle it and inspect its artifacts and background jobs.')
  })
})
