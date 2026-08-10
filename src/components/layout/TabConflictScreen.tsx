import { Copy, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'

export default function TabConflictScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 p-8 text-center">
      <Copy className="size-10 text-muted-foreground" />
      <h1 className="text-lg font-bold text-foreground">Already open elsewhere</h1>
      <p className="max-w-[380px] text-sm text-muted-foreground">
        SmartStock is already open in another tab or window on this device. To avoid conflicting
        changes, please continue there, or close it and try again here.
      </p>
      <Button variant="ghost" onClick={onRetry} className="mt-2">
        <RefreshCw className="size-3.5" /> Try Again
      </Button>
    </div>
  )
}
