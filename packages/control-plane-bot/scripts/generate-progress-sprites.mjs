// Progress-bar sprite generator.
//
// WHY this exists: the bot renders slim connected progress bars out of Discord APPLICATION
// emojis (bot-owned custom emojis that work in DMs with no server). Those emojis are just
// small PNGs uploaded once via the Discord API, so the *source of truth* for how a bar looks
// has to be a committed, reproducible asset — not a hand-drawn file nobody can regenerate.
// This script draws all 19 sprite pieces deterministically and writes them next door under
// assets/progress-bar/. Re-run it to change the look; commit the regenerated PNGs.
//
// WHY no image library: the bot package guards a zero-new-runtime-dependency rule, and even a
// build-only image dep is avoidable here — a progress-bar cell is just a rounded rectangle.
// So we draw into a raw RGBA buffer (per-pixel distance test + 4x supersampling for smooth
// edges) and hand-roll a minimal PNG encoder on node:zlib (deflate) with manual chunks + CRC.
//
// Run: `node packages/control-plane-bot/scripts/generate-progress-sprites.mjs`

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// --- Geometry ---------------------------------------------------------------------------
// 28x28 is the size Discord itself uses for custom-emoji source art; anything larger is
// downscaled on upload, so we draw at native size to keep the edges crisp.
const SIZE = 28;
const SS = 4; // 4x4 supersampling: 16 sub-samples per pixel → anti-aliased rounded caps.
// The bar band is a horizontal pill centred vertically. Height 14 with radius 7 makes the
// cap a PERFECT semicircle (radius === half-height), which is what gives clean rounded caps
// that still tile seamlessly with the square-sided middle pieces.
const TOP = 7;
const BOT = 21;
const R = 7;
const CY = 14; // vertical centre of the band
const HALF_X = SIZE / 2; // split point for the half-filled middle sprite

// --- Palette ----------------------------------------------------------------------------
// Fill colours are the severity-zone colours shared with richFormat.ts (g/y/o/r). The empty
// track is a dark neutral (#2b2d31, Discord's own surface colour) shaded subtly lighter
// toward the centre so an empty cell reads as a recessed tube rather than a flat block.
const FILL = {
  g: [0x2e, 0xcc, 0x71], // ok
  y: [0xf1, 0xc4, 0x0f], // warn
  o: [0xe6, 0x7e, 0x22], // high
  r: [0xe7, 0x4c, 0x3c], // critical
};
const EMPTY_EDGE = [0x2b, 0x2d, 0x31]; // track colour at the rim
const EMPTY_MID = [0x3a, 0x3c, 0x42]; // subtle lighter "inner emptiness" at the centre

// --- Sprite catalogue -------------------------------------------------------------------
// cap: which end is rounded ('l' left, 'r' right, 'm' none/square both sides so middles
//      connect seamlessly).
// filledAt(x): is column x part of the FILLED portion of this sprite? (empty pieces: never;
//      half-middle: only the left half; solid fills: always).
const EMPTY_PIECES = [
  { name: 'pb_le', cap: 'l', filledAt: () => false },
  { name: 'pb_me', cap: 'm', filledAt: () => false },
  { name: 'pb_re', cap: 'r', filledAt: () => false },
];
const COLOR_PIECES = Object.keys(FILL).flatMap((c) => [
  { name: `pb_lf_${c}`, cap: 'l', color: c, filledAt: () => true }, // filled left cap
  { name: `pb_mf_${c}`, cap: 'm', color: c, filledAt: () => true }, // filled middle
  { name: `pb_mh_${c}`, cap: 'm', color: c, filledAt: (x) => x < HALF_X }, // half middle
  { name: `pb_rf_${c}`, cap: 'r', color: c, filledAt: () => true }, // filled right cap
]);
const PIECES = [...EMPTY_PIECES, ...COLOR_PIECES];

// --- Drawing ----------------------------------------------------------------------------

/** Is the sub-sample point (px, py) inside the rounded-rect track for this cap style?
 *  Outside the band vertically → never. Within the flat span → yes. In a rounded end →
 *  inside iff within radius R of that end's semicircle centre. */
function insideTrack(cap, px, py) {
  if (py < TOP || py > BOT) return false;
  if (px < 0 || px > SIZE) return false;
  // Left cap: everything left of x=R is bounded by the semicircle centred at (R, CY).
  if (cap === 'l' && px < R) return (px - R) ** 2 + (py - CY) ** 2 <= R * R;
  // Right cap: everything right of x=SIZE-R is bounded by the semicircle at (SIZE-R, CY).
  if (cap === 'r' && px > SIZE - R) return (px - (SIZE - R)) ** 2 + (py - CY) ** 2 <= R * R;
  return true;
}

/** Colour (RGB triple) of an in-track sub-sample. Filled columns take the solid zone colour;
 *  empty columns take the track colour shaded lighter toward the vertical centre. */
function sampleColor(piece, px, py) {
  if (piece.filledAt(px)) return FILL[piece.color];
  // Subtle vertical shading: t=1 at the centre line, 0 at the rim → recessed-tube look.
  const t = 1 - Math.min(1, Math.abs(py - CY) / R);
  return [
    Math.round(EMPTY_EDGE[0] + (EMPTY_MID[0] - EMPTY_EDGE[0]) * t),
    Math.round(EMPTY_EDGE[1] + (EMPTY_MID[1] - EMPTY_EDGE[1]) * t),
    Math.round(EMPTY_EDGE[2] + (EMPTY_MID[2] - EMPTY_EDGE[2]) * t),
  ];
}

/** Render one sprite to a raw RGBA buffer (SIZE*SIZE*4), transparent outside the track. */
function renderPiece(piece) {
  const buf = Buffer.alloc(SIZE * SIZE * 4); // zero-filled → fully transparent by default
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let inside = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      // Supersample: average colour over covered sub-samples, alpha = coverage fraction.
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (!insideTrack(piece.cap, px, py)) continue;
          const [cr, cg, cb] = sampleColor(piece, px, py);
          r += cr;
          g += cg;
          b += cb;
          inside++;
        }
      }
      const i = (y * SIZE + x) * 4;
      if (inside === 0) continue; // leave transparent
      buf[i] = Math.round(r / inside);
      buf[i + 1] = Math.round(g / inside);
      buf[i + 2] = Math.round(b / inside);
      buf[i + 3] = Math.round((inside / (SS * SS)) * 255);
    }
  }
  return buf;
}

// --- Minimal PNG encoder ----------------------------------------------------------------
// PNG = 8-byte signature + a sequence of length-prefixed, CRC-checked chunks. We emit exactly
// IHDR (8-bit RGBA, no interlace), one IDAT (zlib deflate of filtered scanlines), and IEND.

// Precomputed CRC-32 table (IEEE polynomial 0xEDB88320) — PNG chunks are CRC'd over type+data.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length(4) + type(4) + data + crc(4-over-type+data). */
function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0); // width
  ihdr.writeUInt32BE(SIZE, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type 6 = truecolour + alpha (RGBA)
  ihdr[10] = 0; // compression (deflate)
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // no interlace
  // Filtered raw data: each scanline is prefixed with a filter-type byte (0 = none).
  const stride = SIZE * 4;
  const raw = Buffer.alloc(SIZE * (stride + 1));
  for (let y = 0; y < SIZE; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Main -------------------------------------------------------------------------------
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'progress-bar');
mkdirSync(outDir, { recursive: true });
for (const piece of PIECES) {
  const png = encodePng(renderPiece(piece));
  writeFileSync(join(outDir, `${piece.name}.png`), png);
}
console.log(`Wrote ${PIECES.length} sprites to ${outDir}`);
