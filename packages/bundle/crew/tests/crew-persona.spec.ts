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

/** One loader patch row as the overlay declares it: only the fields these snapshots read. */
interface PatchRow {
  id?: string
  config?: { plugins?: { id?: string; config?: { prefix?: string } }[] }
}

/** One persona config keyed by the preset row that declares it. */
function personaOf(rows: readonly PatchRow[], id: string) {
  const row = rows.find(entry => entry.id === id)
  expect(row, `preset row ${id} in ${PATCH_PATH}`).toBeDefined()
  const persona = row!.config?.plugins?.find(plugin => plugin.id === 'persona')?.config
  expect(persona?.prefix, `persona prefix of ${id}`).toBeTruthy()
  return persona!.prefix!
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
})
