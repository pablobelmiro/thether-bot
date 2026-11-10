import { create } from 'zustand'
import { storageGet, storageSet } from './utils'

export type Theme = 'light' | 'dark'

const KEY = 'tether.theme'

function initialTheme(): Theme {
  const saved = storageGet(KEY)
  if (saved === 'light' || saved === 'dark') return saved
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

function apply(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

interface ThemeState {
  theme: Theme
  toggle: () => void
}

export const useTheme = create<ThemeState>((set, get) => {
  const theme = initialTheme()
  apply(theme)
  return {
    theme,
    toggle: () => {
      const next: Theme = get().theme === 'dark' ? 'light' : 'dark'
      apply(next)
      storageSet(KEY, next)
      set({ theme: next })
    },
  }
})

const SIDEBAR_KEY = 'tether.sidebar.collapsed'

interface SidebarState {
  collapsed: boolean
  toggle: () => void
}

export const useSidebar = create<SidebarState>((set, get) => ({
  collapsed: storageGet(SIDEBAR_KEY) === 'true',
  toggle: () => {
    const next = !get().collapsed
    storageSet(SIDEBAR_KEY, String(next))
    set({ collapsed: next })
  },
}))
