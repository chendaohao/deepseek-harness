import { clientBundle } from '../tsdown.client.ts'
import type { UserConfig } from 'tsdown'

/**
 * Browser-only standalone entry for the `/m` mobile surface: a self-bootstrapped
 * React app (createRoot to body) served at `/m/mobile.js`. Unlike the plugin
 * client bundle it has no `__ModuleLoader__` handoff — the page owns its own
 * React tree — so every dependency (react, react-dom) is inlined and nothing is
 * external except browser globals. Emitted only during the Client pass (and
 * plain `pnpm run bundle`); the Host pass skips it exactly like the node half.
 */
export function standaloneMobile(): UserConfig {
  return {
    name: '@deepseek-ai/dsh-client-ui-remote/mobile',
    entry: { mobile: 'src/mobile/index.tsx' },
    outDir: 'lib',
    format: 'esm',
    platform: 'browser',
    target: 'es2024',
    dts: false,
    sourcemap: true,
    // The node-half lib outputs share this outDir; never wipe them.
    clean: false,
    external: [],
    // The page is served raw by the host webserver, outside the loader module
    // table — inline every dependency (react, react-dom) into the artifact.
    noExternal: (id: string) => true,
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    outputOptions: {
      entryFileNames: 'mobile.js',
      // The page is served as one file; shiki's dynamic language imports must
      // fold into the single artifact rather than emit sibling chunks that the
      // host webserver would not publish.
      inlineDynamicImports: true,
    },
  }
}

const SKIP_WORKSPACE_BUILD: UserConfig = { entry: '' }

/**
 * Package build face: the plugin halves during the Client pass plus the
 * standalone `/m` bundle; nothing during the Host pass (the node lib emits in
 * the Client pass, the same as every other client package).
 */
export default (({ env }) => {
  if (env?.DSH_BUILD_FACE === 'host') return [SKIP_WORKSPACE_BUILD]
  return [
    ...clientBundle('@deepseek-ai/dsh-client-ui-remote', ['lib/types/index.js'])({ env }),
    standaloneMobile(),
  ]
})
