import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn, copyText } from '@/lib/utils'

export function CopyButton({
  text,
  className,
  label,
}: {
  text: string | (() => string)
  className?: string
  label?: string
}) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const onClick = async () => {
    const ok = await copyText(typeof text === 'function' ? text() : text)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } else {
      toast.error(t('common.copyFailed'))
    }
  }
  return (
    <Button
      variant="ghost"
      size={label ? 'sm' : 'icon-sm'}
      className={cn('text-muted-foreground hover:text-foreground', className)}
      onClick={onClick}
      aria-label={copied ? t('common.copied') : t('common.copy')}
      title={copied ? t('common.copied') : t('common.copy')}
    >
      {copied ? <Check /> : <Copy />}
      {label && <span>{copied ? t('common.copied') : label}</span>}
    </Button>
  )
}
