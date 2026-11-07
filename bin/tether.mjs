#!/usr/bin/env node
// Entry point: `tether` starts the server; other subcommands go to the CLI.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const [cmd] = args

if (cmd === '--version' || cmd === '-v') {
  console.log(JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version)
  process.exit(0)
}

const target = !cmd || cmd === 'start' ? 'index' : 'cli'
const compiled = join(root, 'dist', 'server', `${target}.js`)
// node:sqlite prints an ExperimentalWarning on load; it's safe to hide
const nodeFlags = ['--disable-warning=ExperimentalWarning']

const argv = existsSync(compiled)
  ? [...nodeFlags, compiled, ...args]
  : [...nodeFlags, join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(root, 'src', 'server', `${target}.ts`), ...args]

// tsx re-launches node, so pass the flag through NODE_OPTIONS as well
const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} ${nodeFlags.join(' ')}`.trim() }
const child = spawn(process.execPath, argv, { stdio: 'inherit', env })
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig))
child.on('exit', code => process.exit(code ?? 0))
