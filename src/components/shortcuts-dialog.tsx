import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FIXED, HOTKEYS, pretty } from '@/lib/keys'
import { hotkey, useStash } from '@/lib/store'

/**
 * Every key, on one sheet, behind `?`. Read off the same two tables Settings shows — the rebindable
 * ones with whatever they are bound to now, the fixed ones as written — so this can never disagree
 * with what the keys actually do. Its open state is App's, so the list's keys stand still behind it.
 */
export function ShortcutsDialog({ open, onOpenChange: setOpen }: { open: boolean, onOpenChange: (v: boolean) => void }) {
  const s = useStash()

  const Key = ({ k }: { k: string }) => (
    <kbd className="bg-muted text-foreground/80 min-w-6 shrink-0 rounded-md border px-1.5 py-0.5 text-center font-mono text-[11.5px]">{k}</kbd>
  )
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle>Keyboard</DialogTitle>
          <DialogDescription>Rebind the first group in Settings → Keys.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-x-10 gap-y-6 sm:grid-cols-2">
          <section className="grid content-start gap-2.5">
            <p className="text-muted-foreground text-xs font-medium">Yours to rebind</p>
            {HOTKEYS.map((h) => (
              <p key={h.id} className="flex items-center justify-between gap-4 text-sm">{h.what}<Key k={pretty(hotkey(s, h.id))} /></p>
            ))}
          </section>
          <section className="grid content-start gap-2.5">
            <p className="text-muted-foreground text-xs font-medium">Always</p>
            {FIXED.map(([k, what]) => (
              <p key={k} className="flex items-center justify-between gap-4 text-sm"><span className="min-w-0">{what}</span><Key k={k} /></p>
            ))}
            <p className="flex items-center justify-between gap-4 text-sm">This sheet<Key k="?" /></p>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
