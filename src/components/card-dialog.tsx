import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Copy, Download, ImageIcon, Trash2, Video, Volume2, VolumeX } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import {
  CARD_SECONDS, canRecord, cardFrame, cardImage, cardSvg, copyCard, downloadCard, downloadClip,
  type CardPosition, type CardWho,
} from '@/lib/card'

/** What was picked to sit behind the card. A picture is a data URI, because it has to travel inside
 *  the SVG; a clip is an object URL, because a video of any length as a data URI is madness. */
type Bg = { kind: 'image'; url: string } | { kind: 'video'; url: string }

/**
 * The card, with whatever the person wants behind it.
 *
 * Two verbs used to hang off the row directly — save it, copy it — and they still do, but a
 * background is a thing you have to *see* before you agree to it, so they moved inside a window
 * that shows the card at the size it will be posted at. The preview is not a drawing of the card:
 * it is the same SVG the PNG is rasterised from, laid over the same media, so there is nothing for
 * the two to disagree about.
 *
 * A clip goes out as a video with its own sound, which is the only thing here that costs real time
 * — the recorder runs at the wall clock, so the button says how far along it is rather than
 * pretending it is instant.
 */
export function CardDialog({ p, r, who, children }: {
  p: CardPosition
  r: number | null
  who: CardWho | null
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [bg, setBg] = useState<Bg | null>(null)
  /** which press is running, and what it wants to say while it runs */
  const [busy, setBusy] = useState<{ job: 'copy' | 'png' | 'video'; say: string } | null>(null)
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

  /* The overlay only — the media sits behind it as its own layer. '' rather than null is the card
     being told there is something under it: it drops its own gradient and keeps the scrim that
     makes white text readable over a stranger's photograph. */
  const overlay = useMemo(
    () => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(cardSvg(p, r, who, bg ? '' : null)),
    [p, r, who, bg],
  )

  /* What the still card bakes in: the picture itself, or the frame the clip is paused on. A video
     background does not put the two save verbs out of action — a card is a picture, and a clip
     always has one to give. */
  const still = () => (bg?.kind === 'image' ? bg.url
    : bg?.kind === 'video' && video.current ? cardFrame(video.current)
      : null)

  const pick = async (f: File) => {
    if (f.type.startsWith('video/')) return setBg({ kind: 'video', url: URL.createObjectURL(f) })
    try {
      setBg({ kind: 'image', url: await cardImage(f) })
    } catch {
      setBg(null)
      toast('Not a picture', { description: `${f.type || 'That file'} is not something this browser can open.` })
    }
  }

  // one wrapper for all three, so a press can never leave the buttons stuck in their busy state
  const run = async (job: 'copy' | 'png' | 'video', say: string, work: () => Promise<void>, ok: string, bad: string) => {
    setBusy({ job, say })
    try {
      await work()
      toast(ok)
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
          <DialogTitle>Share {p.symbol}</DialogTitle>
          <DialogDescription>
            The trade as a picture, over anything you like. Nothing here leaves the device until you
            save it &mdash; the clip is read, drawn on and recorded in this tab.
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
          <img src={overlay} alt={`${p.symbol} card`}
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

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => file.current?.click()}>
            {bg?.kind === 'video' ? <Video /> : <ImageIcon />}
            {bg ? 'Change background' : 'Add a background'}
          </Button>
          {bg && (
            <Button variant="ghost" size="sm" className="text-muted-foreground"
              onClick={() => setBg(null)}>
              <Trash2 /> Remove
            </Button>
          )}
          <div className="ml-auto flex gap-2">
            <Button variant="outline" size="sm" disabled={!!busy}
              onClick={() => void run('copy', 'Copying…', () => copyCard(p, r, who, still()),
                'Card copied', 'Not copied')}>
              <Copy /> {busy?.job === 'copy' ? busy.say : 'Copy'}
            </Button>
            <Button size="sm" disabled={!!busy}
              onClick={() => void run('png', 'Saving…', () => downloadCard(p, r, who, still()),
                'Card saved', 'No card')}>
              <Download /> {busy?.job === 'png' ? busy.say : 'Save PNG'}
            </Button>
          </div>
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
                () => downloadClip(p, r, who, bg.url, (done, total) =>
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
