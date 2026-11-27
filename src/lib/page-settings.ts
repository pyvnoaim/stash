/**
 * How the page reads and sounds, from the quiet editor's settings list. A thing about this machine
 * and how you like to write, so it lives in this device's storage, never in the synced document —
 * a laptop that clicks as you type should not make the phone click too.
 */
import { useEffect, useState } from 'react'

export type PageFont = 'geist' | 'system' | 'serif' | 'mono'
export type PageSize = 's' | 'm' | 'l'
export type PageSound = 'off' | 'soft' | 'crisp' | 'typewriter'

export interface PageSettings {
  font: PageFont
  size: PageSize
  focus: boolean
  typewriter: boolean
  sound: PageSound
  /** the info line at the foot: Saved, words, read time */
  info: boolean
}

const KEY = 'stash.page'
const DEFAULTS: PageSettings = { font: 'geist', size: 'm', focus: true, typewriter: false, sound: 'off', info: true }

/** Every face is already on a Mac or in the app: nothing is fetched to change how a page looks. */
export const FONTS: Record<PageFont, { label: string, stack: string }> = {
  geist: { label: 'Geist', stack: "'Geist Variable', system-ui, sans-serif" },
  system: { label: 'System', stack: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif" },
  serif: { label: 'Serif', stack: "ui-serif, 'New York', Georgia, serif" },
  mono: { label: 'Mono', stack: "'Geist Mono', ui-monospace, monospace" },
}
/** body px, title px */
export const SIZES: Record<PageSize, [number, number]> = { s: [16, 40], m: [18, 44], l: [20, 48] }

/** Anything stored that is not a setting this build knows is dropped back to its default. */
function read(): PageSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<PageSettings>
    return {
      font: raw.font && raw.font in FONTS ? raw.font : DEFAULTS.font,
      size: raw.size && raw.size in SIZES ? raw.size : DEFAULTS.size,
      focus: typeof raw.focus === 'boolean' ? raw.focus : DEFAULTS.focus,
      typewriter: typeof raw.typewriter === 'boolean' ? raw.typewriter : DEFAULTS.typewriter,
      sound: (['off', 'soft', 'crisp', 'typewriter'] as const).includes(raw.sound as PageSound) ? raw.sound as PageSound : DEFAULTS.sound,
      info: typeof raw.info === 'boolean' ? raw.info : DEFAULTS.info,
    }
  } catch {
    return DEFAULTS
  }
}

export function usePageSettings() {
  const [s, setS] = useState(read)
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(s)) } catch { /* private mode: this session only */ } }, [s])
  const set = <K extends keyof PageSettings>(k: K, v: PageSettings[K]) => setS((p) => ({ ...p, [k]: v }))
  return [s, set] as const
}

/* ---------- key sounds: the quiet editor's, built from a short tick and a low thump ---------- */

let ac: AudioContext | undefined
let noise: AudioBuffer | undefined
let out: GainNode | undefined

function audio() {
  if (!ac) {
    ac = new AudioContext()
    const len = Math.floor(ac.sampleRate * 0.05)
    noise = ac.createBuffer(1, len, ac.sampleRate)
    const d = noise.getChannelData(0)
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
    // a gentle low-pass on the way out, so nothing reads as hiss
    out = ac.createGain()
    out.gain.value = 0.5
    const tone = ac.createBiquadFilter()
    tone.type = 'lowpass'
    tone.frequency.value = 6000
    out.connect(tone).connect(ac.destination)
  }
  return ac
}

/** One key's sound. Space sits a little lower; every press varies a few percent, like real keys. */
export function click(kind: PageSound, space = false) {
  if (kind === 'off') return
  try {
    const ctx = audio()
    if (ctx.state !== 'running') void ctx.resume()
    const t = ctx.currentTime + 0.01
    const vary = 0.94 + Math.random() * 0.12
    const tick = (vol: number, type: BiquadFilterType, freq: number, dur: number, at = t) => {
      const src = ctx.createBufferSource(); src.buffer = noise!
      const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq * vary; f.Q.value = 0.7
      const g = ctx.createGain()
      g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(vol, at + 0.001); g.gain.exponentialRampToValueAtTime(0.0001, at + dur)
      src.connect(f).connect(g).connect(out!); src.start(at); src.stop(at + dur + 0.01)
    }
    const thump = (vol: number, from: number, to: number, dur: number) => {
      const o = ctx.createOscillator(); o.type = 'sine'
      o.frequency.setValueAtTime(from * vary, t); o.frequency.exponentialRampToValueAtTime(to, t + dur)
      const g = ctx.createGain()
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
      o.connect(g).connect(out!); o.start(t); o.stop(t + dur + 0.01)
    }
    const low = space ? 0.75 : 1
    if (kind === 'soft') { thump(0.22, 210 * low, 110 * low, 0.05); tick(0.025, 'lowpass', 1400, 0.012) }
    if (kind === 'crisp') { tick(0.05, 'highpass', 2600, 0.008); thump(0.12, 380 * low, 180 * low, 0.03); tick(0.02, 'highpass', 3200, 0.006, t + 0.028) }
    if (kind === 'typewriter') { tick(0.07, 'bandpass', 1900, 0.022); thump(0.2, 150 * low, 80 * low, 0.07) }
  } catch { /* no audio here: the page types on in silence */ }
}
