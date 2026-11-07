/**
 * Per-user unlock state for the bot. In memory only: a restart always locks.
 */

export type UnlockResult = 'ok' | 'wrong' | 'blocked'

export interface LockOptions {
  idleMs: () => number
  maxAttempts: number
  lockoutMs: number
  now?: () => number
}

export class Lock {
  private unlocked = false
  private lastActivity = 0
  private failures = 0
  private blockedUntil = 0
  private readonly now: () => number

  constructor(private readonly opts: LockOptions) {
    this.now = opts.now ?? Date.now
  }

  isUnlocked(): boolean {
    if (!this.unlocked) return false
    if (this.now() - this.lastActivity > this.opts.idleMs()) {
      this.unlocked = false
      return false
    }
    return true
  }

  touch(): void {
    if (this.unlocked) this.lastActivity = this.now()
  }

  /** `check` verifies the password (kept outside so the hash never lives here) */
  tryUnlock(check: () => boolean): UnlockResult {
    const t = this.now()
    if (t < this.blockedUntil) return 'blocked'
    if (check()) {
      this.failures = 0
      this.unlocked = true
      this.lastActivity = t
      return 'ok'
    }
    this.failures++
    if (this.failures >= this.opts.maxAttempts) {
      this.failures = 0
      this.blockedUntil = t + this.opts.lockoutMs
      return 'blocked'
    }
    return 'wrong'
  }

  blockedForMs(): number {
    return Math.max(0, this.blockedUntil - this.now())
  }

  lock(): void {
    this.unlocked = false
  }
}
