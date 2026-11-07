import path from 'node:path'
import { fileURLToPath } from 'node:url'
import animate from 'tailwindcss-animate'
import typography from '@tailwindcss/typography'

const webDir = path.dirname(fileURLToPath(import.meta.url))

const token = (name) => `hsl(var(--${name}) / <alpha-value>)`

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [path.join(webDir, 'index.html'), path.join(webDir, 'src/**/*.{ts,tsx}')],
  theme: {
    container: { center: true, padding: '1rem' },
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        serif: ['Fraunces', 'ui-serif', 'Georgia', 'serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        border: token('border'),
        input: token('input'),
        ring: token('ring'),
        background: token('background'),
        foreground: token('foreground'),
        primary: { DEFAULT: token('primary'), foreground: token('primary-foreground') },
        secondary: { DEFAULT: token('secondary'), foreground: token('secondary-foreground') },
        destructive: { DEFAULT: token('destructive'), foreground: token('destructive-foreground') },
        success: { DEFAULT: token('success'), foreground: token('success-foreground') },
        warning: { DEFAULT: token('warning'), foreground: token('warning-foreground') },
        info: { DEFAULT: token('info'), foreground: token('info-foreground') },
        muted: { DEFAULT: token('muted'), foreground: token('muted-foreground') },
        accent: { DEFAULT: token('accent'), foreground: token('accent-foreground') },
        popover: { DEFAULT: token('popover'), foreground: token('popover-foreground') },
        card: { DEFAULT: token('card'), foreground: token('card-foreground') },
        status: {
          idle: token('status-idle'),
          working: token('status-working'),
          waiting: token('status-waiting'),
          offline: token('status-offline'),
        },
        terminal: { DEFAULT: token('terminal'), foreground: token('terminal-foreground') },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'var(--radius)',
        sm: 'var(--radius)',
      },
      letterSpacing: {
        label: '0.14em',
      },
    },
  },
  plugins: [animate, typography],
}
