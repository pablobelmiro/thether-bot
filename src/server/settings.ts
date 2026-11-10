/**
 * Typed settings on top of the key/value table.
 */

import { PERMISSION_MODES, type PermissionMode, type Settings, type SettingsPatch } from '../shared/api.js'
import type { Repo } from './db/repo.js'

export const SUPPORTED_LOCALES = ['en', 'pt-BR', 'es'] as const

export function normalizeLocale(input: string | undefined): string | undefined {
  if (!input) return undefined
  const l = input.toLowerCase()
  if (l.startsWith('pt')) return 'pt-BR'
  if (l.startsWith('es')) return 'es'
  if (l.startsWith('en')) return 'en'
  return undefined
}

export class SettingsService {
  constructor(private readonly repo: Repo) {}

  get(): Settings {
    const token = this.repo.getTelegramToken()
    return {
      locale: this.repo.getSetting('locale', 'en'),
      defaultPermissionMode: this.repo.getSetting<PermissionMode>('defaultPermissionMode', 'ask'),
      idleLockHours: this.repo.getSetting('idleLockHours', 12),
      telegramEnabled: this.repo.getSetting('telegramEnabled', true),
      hasTelegramToken: !!token,
      telegramTokenHint: token ? token.slice(-4) : undefined,
      scheduleConcurrency: this.repo.getSetting('scheduleConcurrency', 2),
    }
  }

  patch(p: SettingsPatch): Settings {
    if (p.locale !== undefined) {
      const l = normalizeLocale(p.locale)
      if (!l) throw new Error(`Unsupported language: ${p.locale}`)
      this.repo.setSetting('locale', l)
    }
    if (p.defaultPermissionMode !== undefined) {
      if (!PERMISSION_MODES.includes(p.defaultPermissionMode)) throw new Error('Invalid permission mode')
      this.repo.setSetting('defaultPermissionMode', p.defaultPermissionMode)
    }
    if (p.idleLockHours !== undefined) {
      const h = Number(p.idleLockHours)
      if (!Number.isFinite(h) || h < 0.25 || h > 24 * 7) throw new Error('Idle lock must be between 15 minutes and 7 days')
      this.repo.setSetting('idleLockHours', h)
    }
    if (p.telegramEnabled !== undefined) this.repo.setSetting('telegramEnabled', !!p.telegramEnabled)
    if (p.scheduleConcurrency !== undefined) {
      const n = p.scheduleConcurrency
      if (!Number.isInteger(n) || n < 1 || n > 10) {
        const err = new Error('Invalid concurrency: must be between 1 and 10')
        err.name = ''
        throw err
      }
      this.repo.setSetting('scheduleConcurrency', n)
    }
    return this.get()
  }

  /** Setup is complete once there is a password and at least one allowed phone */
  isConfigured(): boolean {
    return this.repo.hasPassword() && this.repo.listPhones().length > 0
  }
}
