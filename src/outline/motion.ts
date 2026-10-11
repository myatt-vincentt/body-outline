// Movement from the person mask — pure, unit-tested (motion.test.ts).
// A coarse occupancy grid: how much of it changes per second drives the
// outline pulse and the sparkle rate; its centre and edge cells place the
// rainbow and the sparkles. Grid row 0 = top of the screen (feed space).
import { MOTION } from "./config";

export type Motion = {
  cols: number;
  rows: number;
  occ: Uint8Array;
  /** 0..1, smoothed movement. */
  pulse: number;
  /** Body centre, 0..1 (x right, y down); null when nobody is in view. */
  centre: [number, number] | null;
  /** Edge cell indices (person cells touching background) and their count. */
  edges: Int32Array;
  edgeCount: number;
  /** Where the feet are (0..1, x right, y down) and how wide the stance is;
   *  null when nobody is in view or the body runs off the bottom of the frame. */
  foot: { x: number; y: number; width: number } | null;
  active: number;
  primed: boolean;
};

export const createMotion = (cols: number, rows: number): Motion => ({
  cols,
  rows,
  occ: new Uint8Array(cols * rows),
  pulse: 0,
  centre: null,
  edges: new Int32Array(cols * rows),
  edgeCount: 0,
  foot: null,
  active: 0,
  primed: false,
});

/** Rows at the bottom of the silhouette that count as "feet" for the floor glow. */
const FOOT_ROWS = 3;
/** If the body runs off the bottom of the frame, it still gets a floor glow at
 *  the bottom edge when it's leg-width there (≤ this share of the frame);
 *  a wider run-off is a torso (waist-up framing) with no floor in view. */
const LEG_WIDTH = 0.35;

export type MaskLike = { width: number; height: number; indices: Uint8Array };

/** Feed a new mask; `dt` = seconds since the previous mask. */
export const updateMotion = (m: Motion, mask: MaskLike, personIndex: number, dt: number) => {
  const { cols, rows, occ, edges } = m;
  let changed = 0;
  let active = 0;
  let sx = 0;
  let sy = 0;
  for (let r = 0; r < rows; r++) {
    const y = Math.min(mask.height - 1, Math.floor(((r + 0.5) / rows) * mask.height));
    for (let c = 0; c < cols; c++) {
      const x = Math.min(mask.width - 1, Math.floor(((c + 0.5) / cols) * mask.width));
      const v = mask.indices[y * mask.width + x] === personIndex ? 1 : 0;
      const i = r * cols + c;
      if (v !== occ[i]) changed++;
      occ[i] = v;
      if (v) {
        active++;
        sx += c + 0.5;
        sy += r + 0.5;
      }
    }
  }
  // Edge cells: on, with an off 4-neighbour (or on the frame border).
  let e = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (!occ[i]) continue;
      const off =
        c === 0 || !occ[i - 1] || c === cols - 1 || !occ[i + 1] || r === 0 || !occ[i - cols] || r === rows - 1 || !occ[i + cols];
      if (off) edges[e++] = i;
    }
  }
  m.edgeCount = e;
  m.active = active;

  // Feet: the lowest occupied rows. If the body runs off the frame bottom, the
  // feet may be just out of view: legs (narrow) still get a glow at the edge,
  // a torso (wide) doesn't.
  let bottom = -1;
  for (let r = rows - 1; r >= 0 && bottom < 0; r--) {
    for (let c = 0; c < cols; c++) {
      if (occ[r * cols + c]) {
        bottom = r;
        break;
      }
    }
  }
  if (bottom >= 0) {
    let minC = cols;
    let maxC = -1;
    for (let r = Math.max(0, bottom - FOOT_ROWS + 1); r <= bottom; r++) {
      for (let c = 0; c < cols; c++) {
        if (occ[r * cols + c]) {
          if (c < minC) minC = c;
          if (c > maxC) maxC = c;
        }
      }
    }
    const width = (maxC - minC + 1) / cols;
    const runsOff = bottom === rows - 1;
    m.foot = runsOff && width > LEG_WIDTH ? null : { x: (minC + maxC + 1) / 2 / cols, y: (bottom + 1) / rows, width };
  } else {
    m.foot = null;
  }
  m.centre = active > 0 ? [sx / active / cols, sy / active / rows] : null;

  // Movement: share of the silhouette that changed, per second (first frame primes only).
  if (m.primed && dt > 0 && active > 0) {
    const speed = changed / active / dt;
    const target = Math.min(1, speed / MOTION.full);
    const rate = target > m.pulse ? MOTION.attack : MOTION.release;
    m.pulse += (target - m.pulse) * Math.min(1, dt * rate);
  } else if (active === 0) {
    m.pulse = Math.max(0, m.pulse - dt * MOTION.release);
  }
  m.primed = true;
};
