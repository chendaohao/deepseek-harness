import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin } from '../vitest.shared.ts'

/**
 * Standalone vitest config for the `repro/` diagnostic folder. The root
 * vitest config's include globs deliberately omit `repro/` (these suites are
 * not collected by `pnpm test` or CI); run them explicitly:
 *
 *   pnpm vitest run --config repro/vitest.config.ts repro/run-code-invalid-args.spec.ts
 */
export default defineConfig({
  plugins: [
    tsconfigPaths({ projects: ['./tsconfig.base.json'] }),
    standardDecoratorPlugin(),
  ],
  test: {
    setupFiles: ['./scripts/test-invariants.ts'],
    include: ['repro/**/*.spec.ts'],
    pool: 'forks',
  },
})
