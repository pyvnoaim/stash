import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Copy, Download, ImageIcon, Trash2, Video } from 'lucide-react'
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

  /* The object URL behind a clip is a handle on a file this tab is holding open. Cleaning up on
     the way out of the effect hands back the one being replaced, so picking three clips in a row
     does not leak all three. */
  useEffect(() => () => { if (bg?.kind === 'video') URL.revokeObjectURL(bg.url) }, [bg])

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

  return (
    <Dialog open={open} onOpenChange={setOpen}>
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
            /* muted and looping: this is a preview running behind a dialog, and a preview that
               starts talking is one nobody forgives. The sound is not lost — the recorder takes it
               from the file rather than from this element. */
            <video ref={video} src={bg.url} autoPlay loop muted playsInline
              className="absolute inset-0 size-full object-cover" />
          )}
          <img src={overlay} alt={`${p.symbol} card`} className="absolute inset-0 size-full" />
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
