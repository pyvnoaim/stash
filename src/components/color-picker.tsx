import { useEffect, useState } from 'react'
import { Ban, Check } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

/* A row that covers most choices in one click, and a square and a slider behind the swatch for
   the rest. <input type="color"> would be fewer lines, but it opens the OS colour panel — a
   window of its own, three times the size of this dialog, that no styling here can reach. */
const PRESETS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899',
]

/** `3b82f6`, `#3B82F6` and `#39f` all mean the same colour. Anything else means none. */
export function readHex(v: string): string | null {
  const h = v.trim().replace(/^#/, '').toLowerCase()
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h
  return /^[0-9a-f]{6}$/.test(full) ? '#' + full : null
}

/* HSV is what a square and a slider are: hue along the slider, saturation across the square,
   value down it. Hex is what gets stored, so the two conversions live here and nowhere else. */
interface HSV { h: number; s: number; v: number }

function toHex({ h, s, v }: HSV): string {
  const part = (n: number) => {
    const k = (n + h / 60) % 6
    const c = v - v * s * Math.max(0, Math.min(k, 4 - k, 1))
    return Math.round(c * 255).toString(16).padStart(2, '0')
  }
  return `#${part(5)}${part(3)}${part(1)}`
}

function fromHex(hex: string): HSV {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255)
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  const h = d === 0 ? 0
    : max === r ? 60 * (((g - b) / d) % 6)
      : max === g ? 60 * ((b - r) / d + 2)
        : 60 * ((r - g) / d + 4)
  return { h: (h + 360) % 360, s: max ? d / max : 0, v: max }
}

const grip = 'absolute size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-md ring-1 ring-black/10'

/** Pointer capture, so a drag that leaves the square keeps reporting to it instead of stopping. */
function dragging(fn: (x: number, y: number) => void) {
  const at = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const clamp = (n: number) => Math.min(1, Math.max(0, n))
    fn(clamp((e.clientX - r.left) / r.width), clamp((e.clientY - r.top) / r.height))
  }
  return {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId)
      at(e)
    },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) at(e)
    },
  }
}

export function ColorPicker({ value, onChange }: {
  value: string | null
  onChange: (v: string | null) => void
}) {
  // the field is free text while you type it, so a half-written hex is not thrown away mid-keystroke
  const [text, setText] = useState(value ?? '')
  useEffect(() => setText(value ?? ''), [value])

  /* HSV is kept rather than recomputed: black and white have no hue to read back, so dragging
     value to the bottom and up again would otherwise lose the hue you had picked. */
  const [hsv, setHsv] = useState<HSV>(() => fromHex(value ?? '#3b82f6'))
  useEffect(() => {
    if (value && value !== toHex(hsv)) setHsv(fromHex(value))
    // hsv is deliberately not a dependency: this follows the prop, not our own edits
  }, [value])   // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (next: HSV) => { setHsv(next); onChange(toHex(next)) }

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          title="No colour"
          aria-label="No colour"
          onClick={() => onChange(null)}
          className={cn(
            'text-muted-foreground flex size-6 items-center justify-center rounded-full border hover:ring-1 hover:ring-foreground/40',
            !value && 'ring-foreground ring-2 ring-offset-1 ring-offset-(--color-background)',
          )}
        >
          <Ban className="size-3" />
        </button>

        {PRESETS.map((c) => (
          <button
            key={c}
            type="button"
            title={c}
            aria-label={c}
            onClick={() => onChange(c)}
            style={{ backgroundColor: c }}
            className={cn(
              'flex size-6 items-center justify-center rounded-full hover:ring-1 hover:ring-foreground/40',
              value === c && 'ring-foreground ring-2 ring-offset-1 ring-offset-(--color-background)',
            )}
          >
            {value === c && <Check className="size-3 text-white" />}
          </button>
        ))}

        {/* the wheel is the way out of the eight: everything else lives behind it */}
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Pick a colour"
              title="Custom"
              className={cn(
                'size-6 shrink-0 rounded-full bg-[conic-gradient(#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)]',
                value && !PRESETS.includes(value)
                  && 'ring-foreground ring-2 ring-offset-1 ring-offset-(--color-background)',
              )}
            />
          </PopoverTrigger>
          <PopoverContent align="start" className="w-60 space-y-3">
            <div
              {...dragging((x, y) => pick({ ...hsv, s: x, v: 1 - y }))}
              style={{ backgroundColor: `hsl(${hsv.h} 100% 50%)` }}
              className="relative h-36 w-full cursor-crosshair touch-none rounded-md"
            >
              {/* white across, black down: the two gradients over a pure hue are the square */}
              <div className="absolute inset-0 rounded-md bg-[linear-gradient(to_right,#fff,transparent)]" />
              <div className="absolute inset-0 rounded-md bg-[linear-gradient(to_top,#000,transparent)]" />
              <span
                className={grip}
                style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, backgroundColor: toHex(hsv) }}
              />
            </div>

            <div
              {...dragging((x) => pick({ ...hsv, h: x * 360 }))}
              className="relative h-4 w-full cursor-ew-resize touch-none rounded-full bg-[linear-gradient(to_right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)]"
            >
              <span
                className={cn(grip, 'bg-white')}
                style={{ left: `${(hsv.h / 360) * 100}%`, top: '50%' }}
              />
            </div>

            {/* the dot is the answer to "which one is that", right beside the digits that say it */}
            <div className="focus-within:border-ring flex items-center gap-2 rounded-md border px-2 py-1.5">
              <span
                className="size-5 shrink-0 rounded-full border"
                style={{ backgroundColor: value ?? 'transparent' }}
              />
              <Input
                value={text}
                spellCheck={false}
                placeholder="#3b82f6"
                aria-label="Hex colour"
                onChange={(e) => {
                  setText(e.target.value)
                  const hex = readHex(e.target.value)
                  if (hex) onChange(hex)
                  else if (!e.target.value.trim()) onChange(null)
                }}
                // half a hex is not a colour, so what is stored is what comes back when you leave
                onBlur={() => setText(value ?? '')}
                // rounded-none: the wrapper does the corners, and the input's own were clipping
                // the selection highlight into a rounded stub at the start of the hex
                className="h-auto rounded-none border-0 bg-transparent p-0 font-mono uppercase shadow-none focus-visible:ring-0 dark:bg-transparent"
              />
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  )
}

