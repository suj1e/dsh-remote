// Post-build fixes:
// 1. tsdown emits the host declaration with a content-hash suffix (lib/index-*.d.ts);
//    rename it to the stable lib/index.d.ts that package.json points at.
// 2. Wrap the raw CJS client bundle into the `window.__ModuleLoader__.load`
//    factory format the DSH browser module system consumes.
import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

const hashed = readdirSync('lib').filter((name) => /^index-.*\.d\.ts$/.test(name))
if (hashed.length > 1) {
  throw new Error(`expected at most one hashed dts, found: ${hashed.join(', ')}`)
}
if (hashed.length === 1) {
  renameSync(`lib/${hashed[0]}`, 'lib/index.d.ts')
}

for (const stale of readdirSync('lib').filter((name) => /\.d\.cts$/.test(name))) {
  rmSync(`lib/${stale}`)
}

const raw = readFileSync('lib/index.cjs', 'utf8')
const wrapped = `window.__ModuleLoader__.load({
\tid: "dsh-remote",
\tfactory: (require) => {
${raw}
\t\treturn module.exports;
\t}
});
`
writeFileSync('lib/client.js', wrapped)
rmSync('lib/index.cjs')
