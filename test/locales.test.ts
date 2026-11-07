import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..', 'locales')

function keys(obj: unknown, prefix = ''): string[] {
  if (!obj || typeof obj !== 'object') return [prefix]
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k))
}

const base = (file: string) => {
  // i18next plural suffixes (_one/_other/...) count as the same key
  return (k: string) => k.replace(/_(zero|one|two|few|many|other)$/, '')
}

for (const file of ['bot.json', 'web.json']) {
  test(`every locale has the same ${file} keys as English`, () => {
    const enPath = join(root, 'en', file)
    if (!existsSync(enPath)) return
    const norm = base(file)
    const en = new Set(keys(JSON.parse(readFileSync(enPath, 'utf-8'))).map(norm))
    for (const lng of readdirSync(root)) {
      const p = join(root, lng, file)
      if (lng === 'en' || !existsSync(p)) continue
      const other = new Set(keys(JSON.parse(readFileSync(p, 'utf-8'))).map(norm))
      const missing = [...en].filter(k => !other.has(k))
      const extra = [...other].filter(k => !en.has(k))
      assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, `${lng}/${file}`)
    }
  })
}
