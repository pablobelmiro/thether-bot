/**
 * Speech to text for voice messages. Claude can't take audio, so a voice note is
 * transcribed locally with faster-whisper (tools/transcribe.py) and sent as text.
 *
 * One transcription at a time: whisper uses every CPU core it can get, and two in
 * parallel would only slow both down and starve the Claude sessions.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, voice } from '../env.js'

export class TranscribeError extends Error {
  constructor(
    readonly code: 'unavailable' | 'no_speech' | 'failed',
    message: string,
  ) {
    super(message)
  }
}

const script = join(ROOT, 'tools', 'transcribe.py')
let queue: Promise<unknown> = Promise.resolve()

export function voiceAvailable(): boolean {
  return voice.enabled && existsSync(voice.python) && existsSync(script)
}

export function transcribe(file: string): Promise<string> {
  const run = queue.then(() => runOnce(file))
  queue = run.catch(() => {})
  return run
}

function runOnce(file: string): Promise<string> {
  if (!voiceAvailable()) {
    return Promise.reject(new TranscribeError('unavailable', `faster-whisper not found at ${voice.python}`))
  }
  return new Promise((resolve, reject) => {
    // -I: isolated mode, so nothing next to the uploaded file or in the cwd is imported
    execFile(
      voice.python,
      ['-I', script, file, voice.model, voice.language],
      { timeout: voice.timeoutMs, maxBuffer: 1024 * 1024, cwd: ROOT },
      (err, stdout, stderr) => {
        if (err) {
          if ((err as { code?: unknown }).code === 3) return reject(new TranscribeError('no_speech', 'No speech found'))
          const tail = String(stderr).trim().split('\n').slice(-1)[0] ?? ''
          return reject(new TranscribeError('failed', err.killed ? 'Transcription timed out' : tail || err.message))
        }
        const text = String(stdout).trim()
        if (!text) return reject(new TranscribeError('no_speech', 'No speech found'))
        resolve(text)
      },
    )
  })
}
