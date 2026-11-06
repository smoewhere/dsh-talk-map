import { build } from 'esbuild'
import { writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/index.ts'],
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  target: 'node22.19',
  write: false,
  legalComments: 'none',
})
mkdirSync(path.join(root, 'lib'), { recursive: true })
const temp = path.join(root, 'lib', '.index.build.js')
writeFileSync(temp, result.outputFiles[0].contents)
renameSync(temp, path.join(root, 'lib', 'index.js'))
console.log(`build-host: lib/index.js ${result.outputFiles[0].contents.length} bytes`)
