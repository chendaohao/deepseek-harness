/**
 * The bundle's substance is its patch file: the `dsh.bundle.patch` manifest
 * field must name a real, parseable patch list, and the four fork-local rows
 * must keep the gating discipline they carried in the shipped bundles.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

interface PatchRow {
  id?: string
  name?: string
  inject?: string[]
  config?: Record<string, unknown>
  disabled?: boolean
}

describe('dsh-workspace-ext bundle', () => {
  it('declares a parseable patch list through the dsh.bundle.patch manifest field', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const parsed = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    )
    expect(Array.isArray(parsed)).toBe(true)
    // The extension layer is one insert list over the composed tree.
    const rows = (parsed as { insert?: PatchRow[] }[]).flatMap(patch => patch.insert ?? [])
    expect(rows.find(row => row.id === 'session-pin')).toEqual({
      id: 'session-pin',
      name: '@deepseek-ai/dsh-session-pin',
    })
    // The remote rows defer to the webStartup flag service and stay inert
    // without `--remote`; each config expression names it.
    expect(rows.find(row => row.id === 'remote-tunnel')).toEqual({
      id: 'remote-tunnel',
      name: '@deepseek-ai/dsh-remote-tunnel',
      inject: ['webStartup'],
      config: { enabled: { __jsExpr: 'ctx.webStartup.remote ?? false' } },
    })
    expect(rows.find(row => row.id === 'remote-access')).toEqual({
      id: 'remote-access',
      name: '@deepseek-ai/dsh-remote-access',
      inject: ['webStartup'],
      config: {
        enabled: { __jsExpr: 'ctx.webStartup.remote ?? false' },
        resetSecret: { __jsExpr: 'ctx.webStartup.remoteReset ?? false' },
      },
    })
    expect(rows.find(row => row.id === 'client-ui-remote')).toEqual({
      id: 'client-ui-remote',
      name: '@deepseek-ai/dsh-client-ui-remote',
      inject: ['webStartup'],
      config: { enabled: { __jsExpr: 'ctx.webStartup.remote ?? false' } },
    })
    // The mounted plugins are exactly the declared dependencies.
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      '@deepseek-ai/dsh-client-ui-remote',
      '@deepseek-ai/dsh-remote-access',
      '@deepseek-ai/dsh-remote-tunnel',
      '@deepseek-ai/dsh-session-pin',
    ])
  })
})
