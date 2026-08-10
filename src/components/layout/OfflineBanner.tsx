import { WifiOff } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'

export default function OfflineBanner() {
  return (
    <Alert className="shrink-0 gap-2 rounded-none border-0 border-b bg-amber-900 px-4 py-2 text-amber-200">
      <WifiOff className="size-3.5" />
      <AlertDescription className="text-sm font-semibold text-amber-200">
        Working offline — changes are saved locally and will sync automatically once you&apos;re back online.
      </AlertDescription>
    </Alert>
  )
}
