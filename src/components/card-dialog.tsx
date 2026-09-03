import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Copy, Download, ImageIcon, Share2, Trash2, Video, Volume2, VolumeX } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { Hint } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  CARD_SECONDS, canRecord, canShareFiles, cardFrame, cardImage, copyCard, downloadCard, downloadClip,
  PRESETS, shareCard, type PresetId,
} from '@/lib/card'

/** How the numbers are laid out. The ledger is the card as it has always been; the ticket is a
 *  paper slip in the app's pixel face. */
export type Template = 'ledger' | 'ticket'
const TEMPLATES: { id: Template; label: string; hint: string }[] = [
  { id: 'ledger', label: 'Ledger', hint: 'The dark card: the money in a block, the figures in a band along the bottom' },
  { id: 'ticket', label: 'Ticket', hint: 'A receipt on cream paper, set in the app\'s own pixel face' },
]

/** What was picked to sit behind the card. A picture is a data URI, because it has to travel inside
 *  the SVG; a clip is an object URL, because a video of any length as a data URI is madness; a
 *  preset is one of the grounds the renderer draws itself. */
type Bg = { kind: 'image'; url: string } | { kind: 'video'; url: string } | { kind: 'preset'; id: PresetId }

/* The last ground and template chosen, per device. Only the built-in grounds are remembered — a
   photograph is a choice about one card, and a clip is a file this tab was holding open. */
const BG_KEY = 'stash-card-bg', TPL_KEY = 'stash-card-template'
const remembered = <T extends string>(key: string, ok: readonly T[], fallback: T): T => {
  try { const v = localStorage.getItem(key) as T | null; return v && ok.includes(v) ? v : fallback } catch { return fallback }
}
const remember = (key: string, v: string) => { try { localStorage.setItem(key, v) } catch { /* private mode */ } }

/**
 * The card, with whatever the person wants behind it.
 *
 * The dialog knows nothing about trades: it is handed `draw`, which turns a background and a
 * template into the SVG, and a name for the file. A finished trade, a week's recap and anyone
 * else's row all open the same window, so a card of one thing cannot drift from a card of another.
 *
 * The preview is not a drawing of the card: it is the same SVG the PNG is rasterised from, laid
 * over the same media, so there is nothing for the two to disagree about. A clip goes out as a
 * video with its own sound, which is the only thing here that costs real time — the recorder runs
 * at the wall clock, so the button says how far along it is rather than pretending it is instant.
 */
export function CardDialog({ draw, name, title, templates = ['ledger'], children }: {
  /** The card as SVG for a background — a data URI, `preset:<id>`, `''` for media drawn under it,
   *  null for none — and a template. */
  draw: (bg: string | null, template: Template) => string
  /** the file's stem — the symbol, the week */
  name: string
  title: string
  /** which layouts this card comes in; the switch only appears with more than one */
  templates?: Template[]
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [template, setTemplate] = useState<Template>(() => {
    const t = remembered(TPL_KEY, TEMPLATES.map((x) => x.id), 'ledger')
    return templates.includes(t) ? t : templates[0]!
  })
  const [bg, setBg] = useState<Bg | null>(() => {
    const id = remembered(BG_KEY, ['none', ...PRESETS.map((x) => x.id)] as const, 'none')
    return id === 'none' ? null : { kind: 'preset', id }
  })
  /** which press is running, and what it wants to say while it runs */
  const [busy, setBusy] = useState<{ job: 'copy' | 'png' | 'share' | 'video'; say: string } | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  /** the preview's sound, on unless the browser refused it — see the effect below */
  const [hush, setHush] = useState(false)

  /* The object URL behind a clip is a handle on a file this tab is holding open. Cleaning up on
     the way out of the effect hands back the one being replaced, so picking three clips in a row
     does not leak all three. */
  useEffect(() => () => { if (bg?.kind === 'video') URL.revokeObjectURL(bg.url) }, [bg])

  /* Playing it out loud, and dropping to silent only where that is refused. A clip picked for its
     sound is a clip you want to hear, and the press that opened this dialog is the interaction
     Chrome wants before it will autoplay one — an installed app is allowed it outright. Safari
     wants the gesture on the element itself and turns this down, so the rejection is the cue to
     mute and play anyway rather than sit there on a frozen first frame. Driven from here rather
     than the `muted` attribute, which React does not reliably set on the first render. */
  useEffect(() => {
    const v = video.current
    if (!v || bg?.kind !== 'video') return
    /* Out of the way while the recorder has the clip. It plays its own copy from the same file, so
       leaving this one running is the same sound a second or two out of step with the one being
       recorded — and a second decode competing with the encoder for the seconds it records in. */
    if (busy?.job === 'video') return v.pause()
    v.muted = hush
    void v.play().catch(() => { if (!hush) setHush(true) })
    // `open` is in here because closing unmounts the element: reopening hands back a fresh one that
    // nothing has pressed play on, and without it the second look at a card is a frozen first frame.
    // `busy.job` rather than `busy`: the label counts the seconds off, and the job is what changed.
  }, [bg, hush, open, busy?.job])

  /* What the renderer is told is behind it. A preset it draws itself; media is '' — the card being
     told there is something under it, so it drops its own ground and keeps the scrim. */
  const under = bg?.kind === 'preset' ? `preset:${bg.id}` : bg ? '' : null
  /* Only while it is open. `draw` is built inline by every row that offers a card, so it is a new
     function on each render and this memo would never hold: a log of fifty rows drew fifty cards
     and percent-encoded fifty SVGs on every poll, for a dialog nobody had pressed. Closed, Radix
     has unmounted everything that reads it. */
  const overlay = useMemo(
    () => (open ? 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(draw(under, template)) : ''),
    [open, draw, under, template],
  )

  /* What the still card bakes in: the picture itself, the frame the clip is paused on, or the
     preset. A video background does not put the two save verbs out of action — a card is a
     picture, and a clip always has one to give. */
  const still = () => draw(bg?.kind === 'image' ? bg.url
    : bg?.kind === 'video' ? (video.current ? cardFrame(video.current) : '')
      : under, template)

  const pick = async (f: File) => {
    if (f.type.startsWith('video/')) return setBg({ kind: 'video', url: URL.createObjectURL(f) })
    try {
      setBg({ kind: 'image', url: await cardImage(f) })
    } catch {
      setBg(null)
      toast('Not a picture', { description: `${f.type || 'That file'} is not something this browser can open.` })
    }
  }
  const choose = (b: Bg | null) => {
    setBg(b)
    remember(BG_KEY, b?.kind === 'preset' ? b.id : b ? 'upload' : 'none')
  }

  // one wrapper for all of them, so a press can never leave the buttons stuck in their busy state
  const run = async (job: NonNullable<typeof busy>['job'], say: string, work: () => Promise<void>, ok: string, bad: string) => {
    setBusy({ job, say })
    try {
      await work()
      if (ok) toast(ok)
    } catch (e) {
      toast(bad, { description: (e as Error)?.message === 'no recorder' ? 'This browser cannot record video.' : undefined })
    } finally {
      setBusy(null)
    }
  }

  /* A mute is for the clip it was pressed on. Closing puts the sound back on, so the next open
     asks the browser for it again rather than inheriting a decision about a different clip. */
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setHush(false) }}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            A picture, over anything you like. Nothing here leaves the device until you save it
            &mdash; a clip is read, drawn on and recorded in this tab.
          </DialogDescription>
        </DialogHeader>

        {/* The card at its own shape, whatever the window is doing. Rounded and clipped, so a
            picture that fills it cannot square off the corners the dialog rounded. */}
        <div className="bg-muted relative aspect-[1200/630] w-full overflow-hidden rounded-lg">
          {bg?.kind === 'image' && (
            <img src={bg.url} alt="" className="absolute inset-0 size-full object-cover" />
          )}
          {bg?.kind === 'video' && (
            /* No autoPlay and no muted here: both are the effect above's to decide, and an
               attribute fighting it is how the preview ends up silent on the render that mattered. */
            <video ref={video} src={bg.url} loop playsInline
              className="absolute inset-0 size-full object-cover" />
          )}
          <img src={overlay} alt={`${name} card`}
            className="pointer-events-none absolute inset-0 size-full" />
          {bg?.kind === 'video' && (
            <Button variant="secondary" size="icon"
              aria-label={hush ? 'Play the clip with sound' : 'Mute the clip'}
              aria-pressed={!hush}
              className="absolute right-2 bottom-2 size-8 rounded-full opacity-70 transition-opacity hover:opacity-100"
              onClick={() => setHush((q) => !q)}>
              {hush ? <VolumeX /> : <Volume2 />}
            </Button>
          )}
        </div>

        <input ref={file} type="file" accept="image/*,video/*" className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void pick(f)
            // cleared last, and never before the file has been read: WebKit drops the blob behind
            // a File the moment the input that produced it is reset
            e.target.value = ''
          }} />

        {/* The two choices that change the picture, above the verbs that take it away. Both are
            remembered, so the next card opens the way the last one was sent. */}
        <div className="flex flex-wrap items-center gap-2">
          {templates.length > 1 && (
            <div className="bg-muted/50 flex gap-1 rounded-lg p-0.5">
              {TEMPLATES.filter((x) => templates.includes(x.id)).map((x) => (
                <Hint key={x.id} label={x.hint}>
                  <Button size="sm" variant={template === x.id ? 'secondary' : 'ghost'}
                    aria-pressed={template === x.id}
                    className={cn('h-7', template !== x.id && 'text-muted-foreground')}
                    onClick={() => { setTemplate(x.id); remember(TPL_KEY, x.id) }}>
                    {x.label}
                  </Button>
                </Hint>
              ))}
            </div>
          )}
          {/* The shelf: nothing, the four built in, and the upload. Each swatch is the card's own
              shape, so the eye reads "this goes behind it" without a label. */}
          <div className="ml-auto flex items-center gap-1.5" role="radiogroup" aria-label="Background">
            <Hint label="No background — the card's own ground">
              <button type="button" role="radio" aria-checked={!bg} aria-label="None"
                className={cn('aspect-[1200/630] h-6 rounded-sm border bg-[#101014] transition-shadow',
                  !bg ? 'ring-foreground/70 ring-2 ring-offset-1 ring-offset-background' : 'hover:ring-foreground/30 hover:ring-2 hover:ring-offset-1 hover:ring-offset-background')}
                onClick={() => choose(null)} />
            </Hint>
            {PRESETS.map((x) => (
              <Hint key={x.id} label={x.label}>
                <button type="button" role="radio" aria-label={x.label}
                  aria-checked={bg?.kind === 'preset' && bg.id === x.id}
                  className={cn('aspect-[1200/630] h-6 rounded-sm border transition-shadow',
                    bg?.kind === 'preset' && bg.id === x.id
                      ? 'ring-foreground/70 ring-2 ring-offset-1 ring-offset-background'
                      : 'hover:ring-foreground/30 hover:ring-2 hover:ring-offset-1 hover:ring-offset-background')}
                  style={{ background: `linear-gradient(135deg, ${x.from}, ${x.to})` }}
                  onClick={() => choose({ kind: 'preset', id: x.id })} />
              </Hint>
            ))}
            <Hint label={bg?.kind === 'image' || bg?.kind === 'video' ? 'Change the picture or clip' : 'A picture or a clip of your own'}>
              <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2" onClick={() => file.current?.click()}
                aria-pressed={bg?.kind === 'image' || bg?.kind === 'video'}>
                {bg?.kind === 'video' ? <Video /> : <ImageIcon />}
                {bg?.kind === 'image' || bg?.kind === 'video' ? 'Change' : 'Upload'}
              </Button>
            </Hint>
            {(bg?.kind === 'image' || bg?.kind === 'video') && (
              <Hint label="Take the picture off">
                <Button variant="ghost" size="icon" className="text-muted-foreground size-7" aria-label="Remove background"
                  onClick={() => choose(null)}>
                  <Trash2 />
                </Button>
              </Hint>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-3">
          <Button variant="outline" size="sm" disabled={!!busy}
            onClick={() => void run('copy', 'Copying…', () => copyCard(still()), 'Card copied', 'Not copied')}>
            <Copy /> {busy?.job === 'copy' ? busy.say : 'Copy'}
          </Button>
          {/* The sheet, on the devices that have one — which is where a card is actually posted
              from. A cancelled sheet is an answer and says nothing. */}
          {canShareFiles() && (
            <Button variant="outline" size="sm" disabled={!!busy}
              onClick={() => void run('share', 'Sharing…',
                () => shareCard(still(), name).then((how) => { if (how === 'saved') toast('Card saved') }), '', 'Not shared')}>
              <Share2 /> {busy?.job === 'share' ? busy.say : 'Share'}
            </Button>
          )}
          <Button size="sm" disabled={!!busy}
            onClick={() => void run('png', 'Saving…', () => downloadCard(still(), name), 'Card saved', 'No card')}>
            <Download /> {busy?.job === 'png' ? busy.say : 'Save PNG'}
          </Button>
        </div>

        {bg?.kind === 'video' && (
          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            <p className="text-muted-foreground text-xs">
              {canRecord()
                ? `The clip with its own sound, up to ${CARD_SECONDS} seconds. It records as it plays, so this takes about as long as the clip does.`
                : 'This browser cannot record video — the picture still saves.'}
            </p>
            <Button size="sm" className="ml-auto tabular-nums" disabled={!!busy || !canRecord()}
              onClick={() => void run('video', 'Recording…',
                // whole seconds, and the recorder only says so when one turns over
                () => downloadClip(draw('', template), name, bg.url, (done, total) =>
                  setBusy({ job: 'video', say: `${done}s of ${Math.round(total)}s` })),
                'Video saved', 'No video')}>
              <Video /> {busy?.job === 'video' ? busy.say : 'Export video'}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
