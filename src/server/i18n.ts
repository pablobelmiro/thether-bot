/**
 * Server-side translations (bot messages). Dashboard strings live in
 * locales/<lng>/web.json and are loaded by the web app.
 */

import i18next, { type TFunction } from 'i18next'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from './env.js'
import { SUPPORTED_LOCALES } from './settings.js'

const resources: Record<string, { bot: Record<string, unknown> }> = {}
for (const lng of SUPPORTED_LOCALES) {
  const file = join(paths.locales, lng, 'bot.json')
  if (existsSync(file)) resources[lng] = { bot: JSON.parse(readFileSync(file, 'utf-8')) }
}

const instance = i18next.createInstance()
await instance.init({
  resources,
  fallbackLng: 'en',
  supportedLngs: [...SUPPORTED_LOCALES],
  ns: ['bot'],
  defaultNS: 'bot',
  interpolation: { escapeValue: false },
  returnNull: false,
  showSupportNotice: false,
})

export function translator(lng: string): TFunction<'bot'> {
  return instance.getFixedT(lng, 'bot') as TFunction<'bot'>
}
