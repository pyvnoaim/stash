import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import {
  DEMO_MACD, DEMO_RSI, DEMOS, GUIDES, macd, mirrorDemo, rsi, sma, type Demo, type Signal,
} from '@/lib/market'

/* The guide for a reading, with a worked example above the words. The example is drawn from DEMOS
   by the same sma/rsi/macd code the live chart uses — the bars are invented, the pattern in them is
   not, and a test asserts each fixture still contains the thing its guide describes. */

const UP = '#10b981', DOWN = '#ef4444'

/** Price into the 0..100 box, high at the top. */
const scale = (v: number, lo: number, hi: number) => ((hi - v) / (hi - lo || 1)) * 100

const path = (v: (number | null)[], lo: number, hi: number, n: number) => {
  let d = '', pen = false
  v.forEach((p, i) => {
    if (p == null) { pen = false; return }
    d += `${pen ? 'L' : 'M'}${((i / (n - 1)) * 100).toFixed(2)} ${scale(p, lo, hi).toFixed(2)} `
    pen = true
  })
  return d.trim()
}

function DemoChart({ demo }: { demo: Demo }) {
  const { candles, ma, band, panel, mark, rsiPeriod } = demo
  const n = candles.length
  const closes = candles.map((c) => c.c)
  const fast = ma ? sma(closes, ma[0]) : []
  const slow = ma ? sma(closes, ma[1]) : []
  const finite = (a: (number | null)[]) => a.filter((x): x is number => x != null)
  const ys = [...candles.map((c) => c.l), ...candles.map((c) => c.h), ...finite(fast), ...finite(slow)]
  const pad = (Math.max(...ys) - Math.min(...ys)) * 0.08 || 1
  const lo = Math.min(...ys) - pad, hi = Math.max(...ys) + pad
  const x = (i: number) => (i / (n - 1)) * 100
  const w = (100 / n) * 0.62

  // the band the guide is pointing at: the high and low of the last `band` bars
  const seg = band ? candles.slice(-band) : []
  const bandHi = seg.length ? Math.max(...seg.map((c) => c.h)) : 0
  const bandLo = seg.length ? Math.min(...seg.map((c) => c.l)) : 0

  // the lower panel, normalised into its own box so its shape reads without a second axis
  const m = panel === 'macd' ? macd(closes, ...DEMO_MACD) : null
  const series = panel === 'rsi' ? rsi(closes, rsiPeriod ?? DEMO_RSI)
    : m ? m.line
      : candles.map((c) => c.v ?? 0)
  const pv = [...finite(series), ...(m ? finite(m.signal) : [])]
  const pLo = panel === 'rsi' ? 0 : Math.min(...pv, 0)
  const pHi = panel === 'rsi' ? 100 : Math.max(...pv, 0.0001)

  return (
    <div className="bg-muted/30 rounded-lg border p-2">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className={cn('w-full', panel ? 'h-32' : 'h-44')}>
        {band && (
          <>
            <rect x="0" y={scale(bandHi, lo, hi)} width="100"
              height={Math.max(scale(bandLo, lo, hi) - scale(bandHi, lo, hi), 0)} className="fill-violet-500/10" />
            {[bandHi, bandLo].map((lvl, i) => (
              <line key={i} x1="0" x2="100" y1={scale(lvl, lo, hi)} y2={scale(lvl, lo, hi)}
                className="stroke-violet-500/60" strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
            ))}
          </>
        )}
        {/* the bars the guide is actually about, lit from behind */}
        {mark && (
          <rect x={x(mark[0]) - w} y="0" width={x(mark[1]) - x(mark[0]) + w * 2} height="100"
            className="fill-foreground/7" />
        )}
        {ma && (
          <>
            <path d={path(slow, lo, hi, n)} className="stroke-amber-500 fill-none" strokeWidth={1.25} vectorEffect="non-scaling-stroke" />
            <path d={path(fast, lo, hi, n)} className="stroke-sky-500 fill-none" strokeWidth={1.25} vectorEffect="non-scaling-stroke" />
          </>
        )}
        {candles.map((c, i) => {
          const col = c.c >= c.o ? UP : DOWN
          const top = scale(Math.max(c.o, c.c), lo, hi)
          return (
            <g key={i} fill={col}>
              <line x1={x(i)} x2={x(i)} y1={scale(c.h, lo, hi)} y2={scale(c.l, lo, hi)} stroke={col} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
              <rect x={x(i) - w / 2} y={top} width={w} height={Math.max(scale(Math.min(c.o, c.c), lo, hi) - top, 1)} />
            </g>
          )
        })}
      </svg>

      {panel && (
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="mt-1 h-12 w-full border-t pt-1">
          {panel === 'rsi' && [30, 70].map((lvl) => (
            <line key={lvl} x1="0" x2="100" y1={scale(lvl, pLo, pHi)} y2={scale(lvl, pLo, pHi)}
              className="stroke-muted-foreground/40" strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
          ))}
          {panel === 'macd' && (
            <line x1="0" x2="100" y1={scale(0, pLo, pHi)} y2={scale(0, pLo, pHi)}
              className="stroke-muted-foreground/40" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          )}
          {panel === 'volume'
            ? candles.map((c, i) => {
                const v = c.v ?? 0
                const top = scale(v, pLo, pHi)
                return <rect key={i} x={x(i) - w / 2} y={top} width={w} height={Math.max(100 - top, 0.6)}
                  className={cn(v > pHi * 0.6 ? 'fill-foreground/70' : 'fill-muted-foreground/40')} />
              })
            : (
              <>
                {/* MACD is a cross between two lines, so both have to be here — one line on its own
                    illustrates nothing the guide is describing */}
                {m && <path d={path(m.signal, pLo, pHi, n)} className="stroke-amber-500 fill-none" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
                <path d={path(series, pLo, pHi, n)}
                  className={cn('fill-none', m ? 'stroke-sky-500' : 'stroke-foreground')} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
              </>
            )}
        </svg>
      )}
      <p className="text-muted-foreground mt-1 text-center text-[10px]">
        {panel === 'rsi' ? 'an example — price, with RSI beneath; the dashed lines are 30 and 70'
          : panel === 'macd' ? 'an example — the MACD line (blue) crossing its signal line (amber); the flat line is zero'
            : panel === 'volume' ? 'an example — price, with the volume traded per bar beneath'
              : ma ? 'an example — price, with the fast (blue) and slow (amber) averages'
                : band ? 'an example — price, with the band the guide describes'
                  : 'an example, not live data'}
      </p>
    </div>
  )
}

/** The concept's fixture, mirrored when this particular reading runs the other way. */
const demoFor = (signal: Signal): Demo => {
  const base = DEMOS[signal.kind]
  return signal.tone === (base.flipOn ?? 'bear') ? mirrorDemo(base) : base
}

export function GuideDialog({ signal, onClose }: { signal: Signal | null; onClose: () => void }) {
  return (
    <Dialog open={!!signal} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        {signal && (
          <>
            <DialogHeader>
              <DialogTitle>{signal.label}</DialogTitle>
              <DialogDescription>{signal.detail}</DialogDescription>
            </DialogHeader>
            {/* one fixture per concept, flipped when the reading points the other way — a "Downtrend"
                guide illustrated by a rising chart is worse than no picture */}
            <DemoChart demo={demoFor(signal)} />
            <p className="text-muted-foreground text-sm leading-relaxed">{GUIDES[signal.kind]}</p>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
