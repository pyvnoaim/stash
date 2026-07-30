import { CandlestickChart, ChartLine, Monitor, Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { SHORTCUTS } from '@/lib/keys'
import { revealTheme } from '@/lib/utils'
import { setApiKey, setChart, useStash, type ChartStyle, type Theme } from '@/lib/store'

const THEMES: { id: Theme; label: string; icon: React.ElementType }[] = [
  { id: 'auto', label: 'System', icon: Monitor },
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
]

const CHARTS: { id: ChartStyle; label: string; icon: React.ElementType }[] = [
  { id: 'line', label: 'Line', icon: ChartLine },
  { id: 'candles', label: 'Candles', icon: CandlestickChart },
]

export function SettingsDialog({ open, onOpenChange }: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const s = useStash()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Everything here is kept on this machine.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-2">
          <Label>Theme</Label>
          <div className="grid grid-cols-3 gap-1.5">
            {THEMES.map(({ id, label, icon: Icon }) => (
              <Button
                key={id}
                size="sm"
                variant={s.theme === id ? 'default' : 'outline'}
                onClick={() => revealTheme(id)}
              >
                <Icon className="size-3.5" />
                {label}
              </Button>
            ))}
          </div>
          <p className="text-muted-foreground text-xs">
            System follows whatever the machine is set to, and changes with it.
          </p>
        </div>

        <Separator />

        <div className="grid gap-2">
          <Label>Markets chart</Label>
          <div className="grid grid-cols-2 gap-1.5">
            {CHARTS.map(({ id, label, icon: Icon }) => (
              <Button
                key={id}
                size="sm"
                variant={s.chart === id ? 'default' : 'outline'}
                onClick={() => setChart(id)}
              >
                <Icon className="size-3.5" />
                {label}
              </Button>
            ))}
          </div>
        </div>

        <Separator />

        <div className="grid gap-2">
          <Label htmlFor="td-key">Stock data key</Label>
          <Input
            id="td-key"
            type="password"
            placeholder="Twelve Data API key"
            defaultValue={s.apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <p className="text-muted-foreground text-xs">
            Free key from twelvedata.com — needed only for the stock feeds. Crypto and gold work without it.
          </p>
        </div>

        <Separator />

        <div className="grid gap-2">
          <Label>Keyboard</Label>
          <dl className="grid gap-1.5">
            {SHORTCUTS.map(([key, what]) => (
              <div key={key} className="flex items-baseline gap-3">
                <dt className="shrink-0"><Kbd>{key}</Kbd></dt>
                <dd className="text-muted-foreground text-xs">{what}</dd>
              </div>
            ))}
          </dl>
          <p className="text-muted-foreground text-xs">
            List shortcuts do nothing while a field has focus, or on the Overview, Calendar and PDF tabs.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
