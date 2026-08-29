import { readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const testsDir = fileURLToPath(new URL('../tests/', import.meta.url))
const files = (await readdir(testsDir))
  .filter(file => file.endsWith('.test.mjs'))
  .sort()
  .map(file => join(testsDir, file))

if (files.length === 0) throw new Error('no test files found')

const child = spawn(process.execPath, ['--test', ...files], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
})

child.once('error', error => {
  throw error
})
child.once('exit', (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal)
  process.exitCode = code ?? 1
})
