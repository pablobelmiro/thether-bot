import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// A fake "python" that behaves like tools/transcribe.py: argv is -I <script> <file> <model> <lang>
const dir = mkdtempSync(join(tmpdir(), 'tether-voice-'))
const fake = join(dir, 'python')
writeFileSync(
  fake,
  `#!/bin/sh
case "$3" in
  *speech*) echo "  olá Claude, liste os arquivos  " ;;
  *silence*) exit 3 ;;
  *) echo "Traceback: boom" >&2; exit 1 ;;
esac
`,
)
chmodSync(fake, 0o755)
process.env.TETHER_WHISPER_PYTHON = fake

const { transcribe, TranscribeError } = await import('../src/server/core/transcribe.js')

test('transcribe returns the trimmed transcript', async () => {
  assert.equal(await transcribe(join(dir, 'speech.oga')), 'olá Claude, liste os arquivos')
})

test('transcribe maps exit 3 to no_speech', async () => {
  await assert.rejects(transcribe(join(dir, 'silence.oga')), (e: unknown) => e instanceof TranscribeError && e.code === 'no_speech')
})

test('transcribe reports the last stderr line on failure, and the queue keeps working', async () => {
  await assert.rejects(transcribe(join(dir, 'broken.oga')), (e: unknown) => e instanceof TranscribeError && e.code === 'failed' && /boom/.test(e.message))
  assert.equal(await transcribe(join(dir, 'speech2.oga')), 'olá Claude, liste os arquivos')
})
