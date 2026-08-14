import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const binScript = fileURLToPath(new URL('./fixtures/vision-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/vision.cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

describe('vision-agent keyless smoke', () => {
  it('boots the real Loader tree with the vision seam and observes an image', async () => {
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'vision-agent',
      tempDirPrefix: 'vision-agent-smoke-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath],
      tsconfigPath,
    })
    expect(stderr).toBe('')
    const lines = stdout.trimEnd().split('\n')
    const result = JSON.parse(lines.at(-1) ?? '{}') as Record<string, unknown>
    expect(result['type']).toBe('result')
    expect(result['visionRoute']).toEqual({ provider: 'vision-route', model: 'vision-model' })
    expect(result['tools']).toContain('vision_observe')
    expect(String(result['evidence'])).toContain('mock vision evidence')
    expect(result['usage']).toEqual({ inputTokens: 9, outputTokens: 7 })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
