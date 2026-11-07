import { useTranslation } from 'react-i18next'
import { Spinner } from '@/components/common/page'

export function FullScreenLoader() {
  const { t } = useTranslation()
  return (
    <div className="flex h-full items-center justify-center gap-3 text-sm text-muted-foreground">
      <Spinner />
      {t('common.loading')}
    </div>
  )
}
