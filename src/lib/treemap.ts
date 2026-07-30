// Squarified treemap (Bruls, Huizing, van Wijk 2000): tile a rectangle so each cell's area is
// proportional to its value while keeping every cell as close to square as it can — the layout that
// makes "where it goes" legible instead of a row of slivers. Pure geometry, no dependency, testable.

export interface Tile<T> {
  item: T
  x: number
  y: number
  w: number
  h: number
}

export function treemap<T>(items: T[], value: (t: T) => number, width: number, height: number): Tile<T>[] {
  const data = items
    .map((item) => ({ item, v: Math.max(value(item), 0) }))
    .filter((d) => d.v > 0)
  const total = data.reduce((s, d) => s + d.v, 0)
  if (!total || width <= 0 || height <= 0) return []

  // scale values into pixel² so a row's area and the frame's area are the same currency
  const areas = data.map((d) => ({ item: d.item, area: (d.v / total) * width * height }))

  const out: Tile<T>[] = []
  // the free rectangle still to be filled, shrinking as rows are laid down
  let x = 0, y = 0, w = width, h = height

  // worst (largest) aspect ratio in a row laid along the shorter side of length `len`
  const worst = (row: { area: number }[], len: number) => {
    const s = row.reduce((a, d) => a + d.area, 0)
    const max = Math.max(...row.map((d) => d.area))
    const min = Math.min(...row.map((d) => d.area))
    return Math.max((len * len * max) / (s * s), (s * s) / (len * len * min))
  }

  const place = (row: { item: T; area: number }[]) => {
    const s = row.reduce((a, d) => a + d.area, 0)
    if (w >= h) {
      const rw = s / h            // a column down the left of the free box
      let cy = y
      for (const d of row) {
        const rh = d.area / rw
        out.push({ item: d.item, x, y: cy, w: rw, h: rh })
        cy += rh
      }
      x += rw; w -= rw
    } else {
      const rh = s / w            // a row across the top of the free box
      let cx = x
      for (const d of row) {
        const rw = d.area / rh
        out.push({ item: d.item, x: cx, y, w: rw, h: rh })
        cx += rw
      }
      y += rh; h -= rh
    }
  }

  let row: { item: T; area: number }[] = []
  for (const d of areas) {
    const len = Math.min(w, h)
    // keep adding to the current row while it makes the squares better; commit it the moment it doesn't
    if (row.length && worst(row, len) <= worst([...row, d], len)) {
      place(row)
      row = [d]
    } else {
      row.push(d)
    }
  }
  if (row.length) place(row)
  return out
}
