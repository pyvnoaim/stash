/**
 * The service worker registration, kept where a button can reach it. main.tsx does the registering
 * — that has to happen once, at boot, whether or not anyone opens Settings — and hands the
 * registration here so About can go and look on demand.
 */
let reg: ServiceWorkerRegistration | undefined

export const holdRegistration = (r?: ServiceWorkerRegistration) => { reg = r }

/**
 * Ask the server for a new worker now. True when one is waiting afterwards — either it just
 * arrived or it was already there, and in both cases the prompt is what offers the reload.
 * False in dev, where there is no worker at all, which reads as "nothing newer" and is honest.
 */
export async function checkUpdate() {
  if (!reg) return false
  try { await reg.update() } catch { /* offline: nothing newer that we can see */ }
  return !!(reg.waiting ?? reg.installing)
}
