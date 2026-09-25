import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

/**
 * The browser half must materialize in a bare realm: the DSH module system
 * executes the factory with only (require) in scope. A wrapper that forgets
 * the CJS `module`/`exports` bindings crashes the whole web boot with
 * "exports is not defined" — this test reproduces that environment exactly.
 */
test('client bundle materializes in a bare realm', { skip: !existsSync('lib/client.js') && 'run pnpm run build first' }, () => {
  const code = readFileSync('lib/client.js', 'utf8')
  assert.match(code, /^window\.__ModuleLoader__\.load\(\{/m, 'wrapper shape')

  let captured: unknown
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(message: { id: string; factory: (require: (id: string) => unknown) => unknown }) {
          assert.equal(message.id, '@suj1e/dsh-remote', 'bundle id follows package.json name')
          const stubs: Record<string, unknown> = {
            react: { useState: () => [undefined, () => {}], useEffect: () => {}, useCallback: () => () => {} },
            'react/jsx-runtime': { jsx: () => null, jsxs: () => null, Fragment: 'fragment' },
            '@deepseek-ai/dsh-client-ui-primitives': { Button: () => null, Switch: () => null },
          }
          captured = message.factory((id: string) => stubs[id] ?? (() => null))
        },
      },
    },
  }
  vm.runInNewContext(code, sandbox, { filename: 'lib/client.js' })

  const exports = captured as { apply?: unknown; inject?: unknown }
  assert.equal(typeof exports?.apply, 'function', 'exports.apply')
  assert.deepEqual([...(exports?.inject as string[] ?? [])], ['slots', 'locale', 'configForms'], 'exports.inject')
})
