import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'node24',
    dts: { sorted: true },
    unbundle: false,
    // package.json exports stay hand-maintained (tsdown's generator rewrites
    // them with hashed artifact names).
    exports: false,
  },
  {
    entry: ['src/client/index.tsx'],
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    unbundle: false,
    exports: false,
    external: [
      'react',
      'react/jsx-runtime',
      // Static baseline module (seeded table in the browser shell).
      '@deepseek-ai/dsh-client-ui-primitives',
    ],
  },
])
