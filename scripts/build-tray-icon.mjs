// Render the NibGlyph brand mark to a macOS template tray icon.
//
// Source of truth: `docs/design-references/.../frames.jsx` NibGlyph — a stroked
// pen-nib path on a 24×24 viewBox. The macOS menu bar wants `*Template.png`
// 16×16 plus a 32×32 @2x, all black with alpha (the OS handles light/dark).
//
// We hand-roll the rasterization rather than pulling in a full SVG renderer —
// the shape is just three primitives (a closed path, a small filled circle,
// and a short line) so analytic distance fields + 4× supersampling produce a
// clean result without adding a build dependency.

import { promises as fs } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import pkg from "pngjs"

const { PNG } = pkg

const VIEWBOX = 24
const STROKE = 1.8 // viewBox units; matches the popover brand-tile glyph
const AA_FALLOFF = 0.3 // viewBox units of edge fade
const SSAA = 4
const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, "..", "resources")

function qBez(p0, p1, p2, t) {
  const u = 1 - t
  return [
    u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
    u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
  ]
}

function flattenQuadratic(p0, p1, p2, steps = 24) {
  const segs = []
  let prev = p0
  for (let i = 1; i <= steps; i++) {
    const next = qBez(p0, p1, p2, i / steps)
    segs.push([prev, next])
    prev = next
  }
  return segs
}

// Nib outline (matches `M 5 6 Q 5 3, 8 3 L 16 3 Q 19 3, 19 6 L 19 12 L 12 21.5 L 5 12 Z`).
function nibOutlineSegments() {
  return [
    ...flattenQuadratic([5, 6], [5, 3], [8, 3]),
    [
      [8, 3],
      [16, 3],
    ],
    ...flattenQuadratic([16, 3], [19, 3], [19, 6]),
    [
      [19, 6],
      [19, 12],
    ],
    [
      [19, 12],
      [12, 21.5],
    ],
    [
      [12, 21.5],
      [5, 12],
    ],
    [
      [5, 12],
      [5, 6],
    ],
  ]
}

function distToSegment(px, py, [a, b]) {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  let t = ((px - a[0]) * dx + (py - a[1]) * dy) / Math.max(len2, 1e-9)
  if (t < 0) t = 0
  else if (t > 1) t = 1
  const cx = a[0] + t * dx
  const cy = a[1] + t * dy
  return Math.hypot(px - cx, py - cy)
}

function coverageAt(vx, vy, outline) {
  const half = STROKE / 2
  let alpha = 0

  let minD = Infinity
  for (const seg of outline) {
    const d = distToSegment(vx, vy, seg)
    if (d < minD) minD = d
  }
  if (minD <= half) alpha = 1
  else if (minD < half + AA_FALLOFF) alpha = 1 - (minD - half) / AA_FALLOFF

  // Breather hole (filled circle at (12, 7.5), radius matches NibGlyph default).
  const holeR = 1.33
  const dHole = Math.hypot(vx - 12, vy - 7.5)
  if (dHole <= holeR) alpha = Math.max(alpha, 1)
  else if (dHole < holeR + AA_FALLOFF) {
    alpha = Math.max(alpha, 1 - (dHole - holeR) / AA_FALLOFF)
  }

  // Tine slit (stroked line from (12, 9.7) to (12, 17)).
  const dSlit = distToSegment(vx, vy, [
    [12, 9.7],
    [12, 17],
  ])
  if (dSlit <= half) alpha = Math.max(alpha, 1)
  else if (dSlit < half + AA_FALLOFF) {
    alpha = Math.max(alpha, 1 - (dSlit - half) / AA_FALLOFF)
  }

  return alpha
}

function render(size) {
  const png = new PNG({ width: size, height: size })
  const outline = nibOutlineSegments()
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let acc = 0
      for (let sy = 0; sy < SSAA; sy++) {
        for (let sx = 0; sx < SSAA; sx++) {
          const fx = ((px + (sx + 0.5) / SSAA) / size) * VIEWBOX
          const fy = ((py + (sy + 0.5) / SSAA) / size) * VIEWBOX
          acc += coverageAt(fx, fy, outline)
        }
      }
      const a = Math.round((acc / (SSAA * SSAA)) * 255)
      const idx = (py * size + px) * 4
      png.data[idx + 0] = 0
      png.data[idx + 1] = 0
      png.data[idx + 2] = 0
      png.data[idx + 3] = a
    }
  }
  return PNG.sync.write(png)
}

await fs.mkdir(OUT_DIR, { recursive: true })
await fs.writeFile(join(OUT_DIR, "tray-iconTemplate.png"), render(16))
await fs.writeFile(join(OUT_DIR, "tray-iconTemplate@2x.png"), render(32))
console.log("wrote tray-iconTemplate.png (16) + tray-iconTemplate@2x.png (32)")
