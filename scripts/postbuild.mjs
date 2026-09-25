// Post-build step for the two things tsdown cannot emit directly:
// 1. tsdown names the host declaration with a content-hash suffix
//    (lib/index-*.d.ts); package.json types point at lib/index.d.ts.
// 2. The browser half must be a `window.__ModuleLoader__.load({id, factory})`
//    script — DSH's client module system registers factories lazily under the
//    package name. tsdown only emits plain CJS, so wrap it here.
import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

const hashed = readdirSync('lib').filter((name) => /^index-.*\.d\.ts$/.test(name))
if (hashed.length > 1) {
  throw new Error(`expected at most one hashed dts, found: ${hashed.join(', ')}`)
}
if (hashed.length === 1) {
  renameSync(`lib/${hashed[0]}`, 'lib/index.d.ts')
}

const { name } = JSON.parse(readFileSync('package.json', 'utf8'))
const raw = readFileSync('lib/index.cjs', 'utf8')
const wrapped = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(name)},
\tfactory: (require) => {
${raw}
\t\treturn module.exports;
\t}
});
`
writeFileSync('lib/client.js', wrapped)
rmSync('lib/index.cjs')
