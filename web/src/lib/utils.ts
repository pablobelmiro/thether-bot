import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const el = document.createElement('textarea')
      el.value = text
      el.setAttribute('readonly', '')
      el.style.position = 'fixed'
      el.style.opacity = '0'
      document.body.appendChild(el)
      el.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(el)
      return ok
    } catch {
      return false
    }
  }
}

export function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

export function storageSet(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* storage unavailable */
  }
}

/** Strips spaces, dashes, dots and parentheses. Keeps an optional leading +. */
export function normalizePhone(input: string): string {
  return input.trim().replace(/[\s\-().]/g, '')
}

export function isValidPhone(input: string): boolean {
  return /^\+?\d{6,15}$/.test(normalizePhone(input))
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
