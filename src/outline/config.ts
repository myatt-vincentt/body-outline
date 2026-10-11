// Every tunable for the rainbow body outline.

export const BACKGROUND = {
  /** Multiplies the camera background (darker = more contrast for the outline). */
  tint: "#44444c",
};

export const OUTLINE = {
  /** Outline width at rest and at full movement (screen px at 1280 tall). */
  width: 7,
  widthMoving: 18,
  /** Brightness at rest and at full movement. */
  glow: 1.0,
  glowMoving: 1.8,
  /** Rainbow drift around the body (turns per second). */
  hueDrift: 0.05,
  /** Height (px) of the distance-field and echo buffers; width follows the aspect.
   *  Low on purpose: the outline is a glow, and it upsamples smoothly. */
  fieldHeight: 512,
  /** Echo fade time (s, to ~37 %). */
  echoFade: 0.45,
};

export const MOTION = {
  /** Coarse occupancy grid used to measure movement and find edges. */
  columns: 48,
  /** Share of the silhouette changing per second that counts as full movement. */
  full: 1.2,
  /** Pulse attack / release rates (1/s): quick to react, slow to calm down. */
  attack: 8,
  release: 2,
};

export const SPARKLES = {
  max: 320,
  /** Spawn rate (per second) at rest and at full movement. */
  rate: 5,
  rateMoving: 90,
  /** Speed (units/s), lifetime (s), size (px at 1280 tall). */
  speed: [0.15, 0.55] as [number, number],
  life: [0.5, 1.2] as [number, number],
  size: [5, 12] as [number, number],
};

export const MASK = {
  /** CPU mask readback for movement + sparkles (the GPU mask texture is separate). */
  maxUpdateFps: 24,
};
