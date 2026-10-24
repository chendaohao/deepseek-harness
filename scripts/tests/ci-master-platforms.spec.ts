/** Scheduling policy for post-merge native runtime carriers, the hosted Node gate, and Wine. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { gatesForMode } from '../run-gates.ts'

const root = resolve(import.meta.dirname, '../..')
const masterPush = "github.event_name == 'push' && github.ref == 'refs/heads/master'"
const runtimeBuilder = './.github/workflows/build-exe-for-python-sdk.yml'

interface Job {
  if?: string | boolean
  uses?: string
  needs?: string[]
  with?: Record<string, unknown>
  secrets?: Record<string, string>
  steps?: Array<{
    name?: string
    run?: string
    if?: string
    uses?: string
    env?: Record<string, string>
    with?: Record<string, unknown>
  }>
  'runs-on'?: string | string[]
  'continue-on-error'?: boolean
  'timeout-minutes'?: number
}

interface Workflow {
  on: Record<string, unknown>
  jobs: Record<string, Job>
  concurrency?: Record<string, unknown>
}

function workflow(name: string): Workflow {
  return load(readFileSync(resolve(root, '.github/workflows', name), 'utf8')) as Workflow
}

function commands(job: Job): string[] {
  return (job.steps ?? []).flatMap(step => step.run ? [step.run] : [])
}

// These boolean/string cases share Actions and JavaScript semantics. GitHub
// supplies status functions; this probe is not a general Actions interpreter.
function evaluateCondition(expression: string, cancelled: boolean, results: string[], event = 'pull_request'): boolean {
  const source = expression.trim().replace(/^[$][{][{]|[}][}]$/g, '')
    .replaceAll('needs.*.result', 'results')
  return runInNewContext(source, {
    cancelled: () => cancelled,
    always: () => true,
    contains: (values: string[], value: string) => values.includes(value),
    results,
    github: { event_name: event },
  }, { timeout: 1000 }) as boolean
}

const verdicts = [['ci.yml', 'all-checks-passed'], ['ci-windows.yml', 'windows-checks-passed'], ['ci-python.yml', 'python-checks-passed']] as const

describe('master-only platform scheduling', () => {
  it.each(verdicts.flatMap(([file, job]) => ['success', 'failure', 'skipped', 'cancelled'].map(result => [file, job, result] as const)))(
    '%s %s reports %s dependencies in active runs but never starts a cancelled-run verdict', (file, job, result) => {
      const aggregate = workflow(file).jobs[job]!
      const results = aggregate.needs!.map(() => 'success')
      results[0] = result
      const condition = aggregate.if as string
      // A status function prevents Actions from implicitly gating on success().
      expect(condition).toContain('!cancelled()')
      expect(evaluateCondition(condition, false, results)).toBe(true)
      expect(evaluateCondition(condition, true, results)).toBe(false)
      expect(evaluateCondition(condition, false, results, 'push')).toBe(false)
      const failureStep = aggregate.steps!.find(step => step.name === 'Fail if any needed job did not succeed')!
      expect(evaluateCondition(failureStep.if!, false, results)).toBe(result !== 'success')
      expect(failureStep.run).toContain('exit 1')
    },
  )

  it('distinguishes the obsolete always verdict from the cancellable status guard', () => {
    expect(evaluateCondition("always() && github.event_name == 'pull_request'", true, ['success'])).toBe(true)
    expect(evaluateCondition(workflow('ci.yml').jobs['all-checks-passed']!.if as string, true, ['success'])).toBe(false)
  })

  it('keeps the required Python PR verdict and its two x64 targets in CI Python', () => {
    const pr = workflow('ci-python.yml')
    expect(Object.keys(pr.on)).toEqual(['pull_request'])
    expect(pr.jobs['python-runtime']).toMatchObject({
      if: "github.event_name == 'pull_request'",
      uses: runtimeBuilder,
      with: { ci: true, targets: 'node24-linux-x64,node24-win-x64' },
    })
    expect(pr.jobs.windows).toBeUndefined()
    expect(JSON.stringify(pr.jobs)).not.toMatch(/wine-windows-gates|check:windows-wine/)
    const aggregate = pr.jobs['python-checks-passed']!
    expect(aggregate.needs).toContain('python-runtime')
    expect(aggregate.needs).not.toContain('windows')
    expect(aggregate.needs!.every(id => id in pr.jobs)).toBe(true)
    expect(aggregate.if).toBe("${{ !cancelled() && github.event_name == 'pull_request' }}")
    expect(aggregate.steps).toContainEqual(expect.objectContaining({
      if: "contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled') || contains(needs.*.result, 'skipped')",
    }))
    for (const file of ['ci.yml', 'ci-windows.yml']) {
      expect(workflow(file).jobs['python-runtime']).toBeUndefined()
    }
  })

  it('runs all three deferred carriers on master pushes with fail-loud API credentials', () => {
    const master = workflow('ci-master.yml')
    expect(master.on.push).toEqual({ branches: ['master'] })
    expect(Object.keys(master.on).sort()).toEqual(['push', 'workflow_dispatch'])
    const runtime = master.jobs['python-runtime']!
    expect(runtime).toMatchObject({
      if: masterPush,
      uses: runtimeBuilder,
      with: { ci: true, targets: 'node24-linux-arm64,node24-macos-arm64,node24-macos-x64' },
      secrets: { DEEPSEEK_API_KEY_EXTERNAL: '${{ secrets.DEEPSEEK_API_KEY_EXTERNAL }}' },
    })
    expect(runtime.needs).toBeUndefined()
    expect(runtime['continue-on-error']).toBeUndefined()
    const builder = workflow('build-exe-for-python-sdk.yml')
    expect(builder.concurrency?.['cancel-in-progress']).toBe(
      '${{ !inputs.release }}',
    )
    const build = builder.jobs.build!
    const preflight = build.steps!.find(step => step.name === 'Preflight installed-wheel real API test (POSIX)')!
    expect(preflight.if).toContain('inputs.ci')
    expect(preflight.if).toContain("github.event_name != 'pull_request'")
    expect(preflight.if).toContain('github.event.pull_request.head.repo.fork')
    expect(preflight.if).toContain("github.event.pull_request.user.login == 'dependabot[bot]'")
    expect(preflight.run).toContain('exit 1')
  })

  it('runs no self-hosted standby on a master push and keeps one hosted Node gate', () => {
    const master = workflow('ci-master.yml')
    const hostedMinimal = master.jobs['hosted-minimal']!
    expect(hostedMinimal).toMatchObject({
      if: masterPush,
      name: 'hosted-minimal / linux',
      'runs-on': 'ubuntu-latest',
    })
    expect(hostedMinimal.needs).toBeUndefined()
    expect(hostedMinimal['continue-on-error']).toBeUndefined()
    // The unsharded aggregates never fit a standard hosted runner: they stay in
    // the standby definitions, so this gate names type and lint commands only.
    expect(commands(hostedMinimal)).toEqual(['pnpm install --frozen-lockfile', 'pnpm run typecheck', 'pnpm run lint'])
    expect(hostedMinimal.steps).toContainEqual({
      uses: 'actions/setup-node@v7.0.0',
      with: { 'node-version': '${{ env.PRIMARY_NODE_VERSION }}' },
    })
    // A standard hosted runner has four cores and no swap headroom for the
    // Host compiler's 4 GiB heap plus a second program-building worker.
    for (const step of hostedMinimal.steps!) {
      if (step.run?.startsWith('pnpm run')) expect(step.env, `${step.run} must bound its worker count`).toBeDefined()
    }

    // A self-hosted label this fork never registers queues until the job limit
    // cancels the whole run, leaving master without any Node verdict. Reusable
    // `uses:` jobs and the dispatch-only benchmarks declare no runs-on here, so
    // only a job that really selects a runner can reach the self-hosted labels.
    for (const [name, job] of Object.entries(master.jobs)) {
      if (name === 'hosted-minimal' || job.if === false) continue
      expect(JSON.stringify(job['runs-on'] ?? ''), `${name} must not select a self-hosted label`).not.toContain('self-hosted')
    }
    // Disabled lanes keep their definitions so a registered runner restores them.
    for (const name of ['serial-linux-selfhosted', 'serial-windows'] as const) {
      const standby = master.jobs[name]!
      expect(standby.if).toBe(false)
      expect(standby['runs-on']).toEqual(expect.arrayContaining(['self-hosted']))
      expect(standby.steps!.length).toBeGreaterThan(1)
    }
  })

  it('runs Wine once on hosted master CI and seeds its own apt cache', () => {
    const master = workflow('ci-master.yml')
    const wine = master.jobs.windows!
    expect(wine).toMatchObject({ if: masterPush, 'runs-on': 'ubuntu-latest' })
    expect(wine.needs).toBeUndefined()
    expect(wine['continue-on-error']).toBeUndefined()
    expect(master.jobs['wine-apt-cache']).toBeUndefined()
    expect(Object.values(master.jobs).flatMap(commands).filter(command => command.includes('wine-windows-gates.sh')))
      .toEqual(['bash scripts/wine-windows-gates.sh'])
    expect(wine.steps).toContainEqual(expect.objectContaining({
      uses: 'actions/cache@v6.1.0', with: { path: '~/wine-debs', key: '${{ steps.wine-cache-key.outputs.key }}' },
    }))
    expect(commands(wine).join('\n')).toContain('--download-only wine')
    expect(wine.steps).toContainEqual(expect.objectContaining({ name: 'Shut down wineserver', if: 'always()' }))
    // Graph construction needs a pnpm entrypoint but never launches it.
    const previous = process.env.npm_execpath
    process.env.npm_execpath = '/test/pnpm.cjs'
    try {
      for (const mode of ['ci-linux-primary', 'ci-windows-complete'] as const) {
        expect(gatesForMode(mode).map(gate => gate.displayCommand).join('\n')).not.toMatch(/wine/i)
      }
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, 'npm_execpath')
      else process.env.npm_execpath = previous
    }
    expect(process.env.npm_execpath).toBe(previous)
  })

  it('retains the complete release matrix independently of CI scheduling', () => {
    const release = workflow('python-release.yml')
    const calls = Object.values(release.jobs).filter(job => job.uses === runtimeBuilder)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.with).toMatchObject({
      release: true,
      targets: 'node24-linux-x64,node24-linux-arm64,node24-macos-arm64,node24-macos-x64,node24-win-x64',
    })
  })
})
