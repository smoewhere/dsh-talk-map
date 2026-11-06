import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const install = process.env.DSH_TEST_INSTALL ?? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness')
const executable = join(install, 'DeepSeek Harness.exe')
if (!existsSync(executable)) throw new Error('Set DSH_TEST_INSTALL to the installed DSH rc.5 directory')
const result = spawnSync(executable, ['test/session-lifecycle-real.cjs'], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_TEST_APP: join(install, 'resources', 'app.asar') },
  stdio: 'inherit', windowsHide: true,
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
