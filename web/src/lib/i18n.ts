import i18n from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { initReactI18next } from 'react-i18next'
import en from '../../../locales/en/web.json'
import es from '../../../locales/es/web.json'
import ptBR from '../../../locales/pt-BR/web.json'

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'pt-BR', label: 'Português (Brasil)' },
  { code: 'es', label: 'Español' },
] as const

export type LanguageCode = (typeof LANGUAGES)[number]['code']

export function toSupportedLanguage(lng: string | undefined | null): LanguageCode {
  if (!lng) return 'en'
  const lower = lng.toLowerCase()
  if (lower.startsWith('pt')) return 'pt-BR'
  if (lower.startsWith('es')) return 'es'
  return 'en'
}

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { web: en },
      'pt-BR': { web: ptBR },
      es: { web: es },
    },
    ns: ['web'],
    defaultNS: 'web',
    fallbackLng: 'en',
    supportedLngs: ['en', 'pt-BR', 'es'],
    nonExplicitSupportedLngs: false,
    load: 'currentOnly',
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'tether.lang',
      caches: ['localStorage'],
      convertDetectedLanguage: (lng: string) => toSupportedLanguage(lng),
    },
  })

i18n.on('languageChanged', (lng) => {
  document.documentElement.lang = lng
})
document.documentElement.lang = i18n.language || 'en'

export function setLanguage(lng: string) {
  const code = toSupportedLanguage(lng)
  if (i18n.language !== code) void i18n.changeLanguage(code)
}

export default i18n
