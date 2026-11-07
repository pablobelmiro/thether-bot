/**
 * Password hashing (scrypt) and secret encryption at rest (AES-256-GCM with a
 * local key file readable only by the owner).
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 32, SCRYPT)
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${hash.toString('base64')}`
}

export function verifyPassword(password: string, stored: string | undefined): boolean {
  if (!stored) return false
  const [kind, n, saltB64, hashB64] = stored.split('$')
  if (kind !== 'scrypt' || !saltB64 || !hashB64) return false
  const expected = Buffer.from(hashB64, 'base64')
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { ...SCRYPT, N: Number(n) })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/** Constant-time comparison of two strings */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

/** Read the key file, creating it (mode 600) on first use */
export function loadOrCreateFile(path: string, create: () => string): string {
  if (existsSync(path)) return readFileSync(path, 'utf-8').trim()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const value = create()
  writeFileSync(path, value + '\n', { mode: 0o600 })
  chmodSync(path, 0o600)
  return value
}

export class SecretBox {
  private readonly key: Buffer

  constructor(keyFile: string) {
    this.key = Buffer.from(loadOrCreateFile(keyFile, () => randomBytes(32).toString('base64')), 'base64')
    if (this.key.length !== 32) throw new Error(`Invalid key in ${keyFile}`)
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const data = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final()])
    return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`
  }

  decrypt(box: string): string {
    const [v, iv, tag, data] = box.split(':')
    if (v !== 'v1' || !iv || !tag || !data) throw new Error('Unknown secret format')
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf-8')
  }
}
