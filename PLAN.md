# Plan — Body Outline

What (from the user, 2026-10-12; there is no Brief.md): like My Emoji Shadow, but the **person is
shown**, with a **rainbow outline** around their body, lively enough for dancing.

## Decisions (confirmed 2026-10-12)

- **Background:** the real camera, **dimmed**; the person at full brightness on top.
- **Outline:** rainbow, with **motion echoes** (fading copies trail behind movement), a **pulse
  with movement** (thicker and brighter the faster you move) and **sparkles** drifting off the
  edge.
- **Preview:** the user's dance clip (`dev-media/dancing-woman.mp4`, 1080×1920, 22 s) is the
  default in the dev media switcher, listed alongside the SDK samples. It lives outside `public/`
  (and `src/`), so it never ships, and is git-ignored (licence not cleared for a public repo).

## Composition (SDK portrait segmentation, `docs/api/person-cutout.mdx`)

One `ScreenSpaceUI`, full-screen layers by `renderOrder`:

| Layer | Order | Implementation |
|---|---|---|
| Background | 0 | `ScreenImage` of the session camera texture, tinted dark (`color`) |
| Person | 100 | `PersonCutout` (camera × person mask), full brightness |
| Outline | 150 | custom shader plane in `<ScreenTransform anchors={FULL_SCREEN_ANCHORS}>`, masked off the person so trails pass behind the body |
| Sparkles | 160 | pooled points on the stage, spawned on the mask edge |

The outline layer is a custom plane, not a `ScreenImage`, because it reads GPU render targets
(the echo buffer), and `ScreenImage` shows render-target textures blank (found in my-emoji-shadow).

## Outline pipeline (`src/outline/`)

1. **Edge (distance field):** from `usePersonMaskTexture()` (feed space = screen UV), two
   separable passes at 512 px tall: nearest person pixel along the row, then down the column, each
   with a linear falloff. Outside the person, field > 0 is outline (bright at the edge, soft glow
   outward). Radius and brightness scale with the movement pulse. This replaced a 48-tap ring
   search per pixel at half resolution, and is several times cheaper.
2. **Rainbow:** hue from the angle around the body's centre, drifting slowly.
3. **Echoes:** a half-resolution ping-pong buffer: `echo = max(echo × decay, outline)`. Still →
   the echo sits under the live outline; moving → fading rainbow trails.
4. **Movement** (`motion.ts`, pure, tested): the share of a coarse mask grid that changed per
   second, smoothed → pulse 0..1. It also gives the body centre and edge points for sparkles.
5. **Floor glow:** a flat rainbow pool under the feet (the bottom of the silhouette from
   `motion.ts`). If the body runs off the frame bottom, the glow stays at the edge while it's
   leg-width there, and is off for a torso (waist-up framing). It brightens with movement and is
   masked off the person.
6. **Sparkles:** emitted on random edge points; the rate grows with movement; they drift outward
   and up, twinkling in rainbow colours.

## Notes from building it

- `ScreenImage` (and `PersonCutout`) load their default image through a suspending loader even
  when given a texture. Mounted mid-session (the camera texture appears after start), they need
  their own `<Suspense>` boundary or the whole canvas unmounts.
- `PersonCutout` uses `maskErode={0}` and `maskFeather={2}`, so the person meets the outline with no
  dark gap. The defaults (erode 0.7) shrink the person inside the mask edge.

## Dev preview

`DevMediaSwitcher.tsx` (adapted from my-emoji-shadow; dev-only, stripped from production) starts on
the dance clip when there is no webcam, and also lists every SDK sample video and image plus the
webcam.

## Production

- Title and share-preview metadata are in `index.html` (a platform file: re-apply after a template
  upgrade). New `src/` files are in the manifest's `creator` list.
- Dev-only pieces (`DevMediaSwitcher.tsx`, the `__outline` hook, `dev-media/`) are not in
  production builds.
- Not yet: git remote, commit, tag, publish.
