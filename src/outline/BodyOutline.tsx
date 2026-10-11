// The body outline, composed the SDK's way for portrait segmentation (see the
// SDK's docs/api/person-cutout.mdx): one ScreenSpaceUI with full-screen layers.
//
//   renderOrder 0    background — the camera, tinted dark (ScreenImage)
//   renderOrder 100  person     — PersonCutout, full brightness
//   renderOrder 150  outline    — custom shader plane in a full-screen ScreenTransform
//   renderOrder 160  sparkles   — points on the stage, spawned on the mask edge
//
// The outline comes from a cheap distance field of the person mask (feed space =
// screen UV), built at a low fixed resolution in two separable passes:
//   field X: nearest person pixel along the row, with a linear falloff
//   field Y: the same down the column, over field X
// A pixel outside the person with field > 0 is outline (≈ 2·(2R+1) samples per
// texel instead of a 48-tap ring). The live outline is written into an echo
// buffer each frame,
//   echo = max(echo × fade, live outline)
// so standing still leaves the echo under the live line and moving leaves
// fading rainbow trails. The outline plane is a custom mesh rather than a
// ScreenImage because ScreenImage shows render-target textures blank.
import { Suspense, useEffect, useMemo, useRef } from "react";
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  HalfFloatType,
  LinearFilter,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderTarget,
} from "three";
import { useFrame, useThree } from "@react-three/fiber";
import {
  FULL_SCREEN_ANCHORS,
  PersonCutout,
  ScreenImage,
  ScreenSpaceUI,
  ScreenTransform,
  usePersonMaskTexture,
} from "@vincentt-xr/sdk";
import { useXRCameraTexture } from "@vincentt-xr/sdk/low-level";
import { usePersonMask } from "@vincentt-xr/sdk/tracking";

import { BACKGROUND, MASK, MOTION, OUTLINE, SPARKLES } from "./config";
import { createMotion, updateMotion } from "./motion";

/** Read-only view for the prompt and status. */
export const outlineState = { maskReady: false, active: 0 };

// ─── Shaders ─────────────────────────────────────────────────────────────────

const quadVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const MAX_R = 14;

/** Distance field, horizontal: strongest (person × falloff) along the row. */
const fieldXFrag = /* glsl */ `
uniform sampler2D uMask;
uniform vec2 uTexel;    // 1 / field size
uniform float uRadius;  // outline width in field texels
varying vec2 vUv;
void main() {
  float v = 0.0;
  for (int k = -${MAX_R}; k <= ${MAX_R}; k++) {
    float fk = abs(float(k));
    float w = clamp(1.0 - fk / (uRadius + 1.0), 0.0, 1.0);
    if (w <= 0.0) continue;
    v = max(v, texture2D(uMask, vUv + vec2(float(k) * uTexel.x, 0.0)).g * w);
  }
  gl_FragColor = vec4(v, texture2D(uMask, vUv).g, 0.0, 1.0);
}
`;

/** Distance field, vertical: the same down the column over field X. */
const fieldYFrag = /* glsl */ `
uniform sampler2D uFieldX;
uniform vec2 uTexel;
uniform float uRadius;
varying vec2 vUv;
void main() {
  float v = 0.0;
  for (int k = -${MAX_R}; k <= ${MAX_R}; k++) {
    float fk = abs(float(k));
    float w = clamp(1.0 - fk / (uRadius + 1.0), 0.0, 1.0);
    if (w <= 0.0) continue;
    v = max(v, texture2D(uFieldX, vUv + vec2(0.0, float(k) * uTexel.y)).r * w);
  }
  gl_FragColor = vec4(v, texture2D(uFieldX, vUv).g, 0.0, 1.0);
}
`;

/** Echo pass: the live rainbow outline from the field, kept as a fading memory. */
const echoFrag = /* glsl */ `
uniform sampler2D uPrev;
uniform sampler2D uField;
uniform float uFade;       // multiplier per frame
uniform float uAspect;     // width / height
uniform vec2 uCentre;      // body centre, UV (bottom-left origin)
uniform float uHue;        // rainbow rotation (turns)
uniform float uHasMask;
varying vec2 vUv;

vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

void main() {
  vec4 prev = texture2D(uPrev, vUv);
  vec2 f = texture2D(uField, vUv).rg;
  // Outside the person only; the field's falloff gives a bright edge and soft glow.
  float live = uHasMask > 0.5 ? clamp(f.r * 1.15, 0.0, 1.0) * (1.0 - smoothstep(0.35, 0.65, f.g)) : 0.0;
  vec2 d = (vUv - uCentre) * vec2(uAspect, 1.0);
  float hue = fract(atan(d.y, d.x) / 6.2831853 + uHue);
  vec3 col = hsv2rgb(vec3(hue, 0.85, 1.0)) * live;
  vec3 echo = max(prev.rgb * uFade, col);
  gl_FragColor = vec4(echo, live);
}
`;

const displayVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

/** Display: the echo (trails) plus a brighter live line, added over the scene —
 *  but never over the person themself, so trails pass behind the body. */
const displayFrag = /* glsl */ `
uniform sampler2D uEcho;
uniform sampler2D uMask;
uniform float uHasMask;
uniform float uGlow;
uniform vec3 uFoot;       // feet x, y (UV, bottom-left origin), stance width (UV)
uniform float uFootOn;    // 0..1, eased in/out
uniform float uPulse;
uniform float uHue;
uniform float uAspect;
varying vec2 vUv;

vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

void main() {
  vec4 e = texture2D(uEcho, vUv);
  vec3 col = e.rgb * (0.55 + 0.45 * e.a) * uGlow + e.rgb * e.a * 0.6 * uGlow;

  // Floor glow: a flat rainbow pool of light under the feet.
  if (uFootOn > 0.001) {
    float w = max(uFoot.z, 0.12) * 0.85 + 0.1 * uPulse;
    float h = (0.022 + 0.018 * uPulse) * uAspect * 1.6;
    // At the frame edge (feet just out of view), lift it so the pool stays visible.
    float cy = max(uFoot.y, h * 0.55);
    vec2 q = vec2((vUv.x - uFoot.x) / w, (vUv.y - cy) / h);
    float pool = exp(-dot(q, q) * 2.0);
    float hue = fract((vUv.x - uFoot.x) / w * 0.35 + uHue);
    col += hsv2rgb(vec3(hue, 0.75, 1.0)) * pool * uFootOn * (0.5 + 0.6 * uPulse);
  }

  float person = uHasMask > 0.5 ? smoothstep(0.35, 0.65, texture2D(uMask, vUv).g) : 0.0;
  gl_FragColor = vec4(col * (1.0 - person), 1.0);
}
`;

const sparkVert = /* glsl */ `
attribute vec3 color;
attribute float size;
attribute float alpha;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vColor = color;
  vAlpha = alpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = size;
  gl_Position = projectionMatrix * mv;
}
`;

const sparkFrag = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  // A small four-point twinkle: a round core plus a soft cross.
  float core = smoothstep(0.5, 0.0, length(p));
  float cross = max(smoothstep(0.08, 0.0, abs(p.x)) * smoothstep(0.5, 0.1, abs(p.y)),
                    smoothstep(0.08, 0.0, abs(p.y)) * smoothstep(0.5, 0.1, abs(p.x)));
  float a = max(core * core, cross) * vAlpha;
  gl_FragColor = vec4(vColor * 1.5, a);
}
`;

// ─── Component ───────────────────────────────────────────────────────────────

const makeTarget = (w: number, h: number) =>
  new WebGLRenderTarget(w, h, {
    type: HalfFloatType,
    format: RGBAFormat,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });

export const BodyOutline = () => {
  const { gl, size, viewport, camera: cam3d } = useThree();
  const cameraTexture = useXRCameraTexture();
  const { texture: maskTexture, status } = usePersonMaskTexture();
  const mask = usePersonMask({ maxUpdateFps: MASK.maxUpdateFps });

  // Movement grid.
  const rows = Math.max(
    1,
    Math.round((MOTION.columns * size.height) / Math.max(1, size.width)),
  );
  const motion = useMemo(() => createMotion(MOTION.columns, rows), [rows]);
  const lastMask = useRef({ version: -1, at: 0 });

  // Field + echo buffers, all at a low fixed resolution (soft glow upsamples well).
  const fieldH = OUTLINE.fieldHeight;
  const fieldW = Math.max(
    2,
    Math.round((fieldH * size.width) / Math.max(1, size.height)),
  );
  const targets = useMemo(
    () => [makeTarget(fieldW, fieldH), makeTarget(fieldW, fieldH)],
    [fieldW, fieldH],
  );
  const fieldTargets = useMemo(
    () => [makeTarget(fieldW, fieldH), makeTarget(fieldW, fieldH)],
    [fieldW, fieldH],
  );
  useEffect(
    () => () => fieldTargets.forEach((t) => t.dispose()),
    [fieldTargets],
  );
  const read = useRef(0);
  const pass = useMemo(() => {
    const quadPass = (
      fragmentShader: string,
      uniforms: Record<string, { value: unknown }>,
    ) => {
      const material = new ShaderMaterial({
        vertexShader: quadVert,
        fragmentShader,
        uniforms,
        depthTest: false,
        depthWrite: false,
      });
      const scene = new Scene();
      const quad = new Mesh(new PlaneGeometry(2, 2), material);
      quad.frustumCulled = false;
      scene.add(quad);
      return { material, scene };
    };
    const fieldX = quadPass(fieldXFrag, {
      uMask: { value: null },
      uTexel: { value: new Vector2() },
      uRadius: { value: 4 },
    });
    const fieldY = quadPass(fieldYFrag, {
      uFieldX: { value: null },
      uTexel: { value: new Vector2() },
      uRadius: { value: 4 },
    });
    const echo = quadPass(echoFrag, {
      uPrev: { value: null },
      uField: { value: null },
      uFade: { value: 0.9 },
      uAspect: { value: 1 },
      uCentre: { value: new Vector2(0.5, 0.5) },
      uHue: { value: 0 },
      uHasMask: { value: 0 },
    });
    return {
      fieldX,
      fieldY,
      echo,
      cam: new OrthographicCamera(-1, 1, 1, -1, 0, 1),
    };
  }, []);
  const display = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: displayVert,
        fragmentShader: displayFrag,
        uniforms: {
          uEcho: { value: null },
          uMask: { value: null },
          uHasMask: { value: 0 },
          uGlow: { value: 1 },
          uFoot: { value: new Vector3() },
          uFootOn: { value: 0 },
          uPulse: { value: 0 },
          uHue: { value: 0 },
          uAspect: { value: 1 },
        },
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    [],
  );

  // Clear fresh targets; release on change.
  useEffect(() => {
    const prev = gl.getRenderTarget();
    targets.forEach((t) => {
      gl.setRenderTarget(t);
      gl.setClearColor(0x000000, 0);
      gl.clear(true, false, false);
    });
    gl.setRenderTarget(prev);
    return () => targets.forEach((t) => t.dispose());
  }, [gl, targets]);

  // Sparkles: a pooled point cloud on the z=0 stage.
  const sparks = useMemo(() => {
    const n = SPARKLES.max;
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute("color", new BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute("size", new BufferAttribute(new Float32Array(n), 1));
    g.setAttribute("alpha", new BufferAttribute(new Float32Array(n), 1));
    const m = new ShaderMaterial({
      vertexShader: sparkVert,
      fragmentShader: sparkFrag,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    return {
      geometry: g,
      material: m,
      vel: new Float32Array(n * 2),
      life: new Float32Array(n),
      max: new Float32Array(n),
      base: new Float32Array(n),
      cursor: 0,
      debt: 0,
    };
  }, []);
  const color = useMemo(() => new Color(), []);

  if (process.env.NODE_ENV !== "production") {
    (window as unknown as { __outline: unknown }).__outline = {
      motion,
      mask,
      targets,
      fieldTargets,
      read,
      pass,
      gl,
      display,
    };
  }

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 1 / 20);
    const t = state.clock.elapsedTime;

    // ── Movement from the CPU mask (only when a new one arrives) ──
    const personIndex = mask.labels.indexOf("person");
    if (
      mask.version > 0 &&
      mask.version !== lastMask.current.version &&
      personIndex >= 0
    ) {
      const now = performance.now();
      const since =
        lastMask.current.version < 0 ? 0 : (now - lastMask.current.at) / 1000;
      lastMask.current = { version: mask.version, at: now };
      updateMotion(motion, mask, personIndex, Math.min(since, 0.5));
    }
    outlineState.maskReady = status === "ready";
    outlineState.active = motion.active;
    const p = motion.pulse;

    // ── Distance field (two separable passes) → echo pass ──
    const aspect = size.width / Math.max(1, size.height);
    const hasMask = maskTexture && status === "ready" ? 1 : 0;
    const widthPx = OUTLINE.width + (OUTLINE.widthMoving - OUTLINE.width) * p;
    const radius = Math.min(14, (widthPx / 1280) * fieldH);
    const texel = [1 / fieldW, 1 / fieldH] as const;
    const fx = pass.fieldX.material.uniforms;
    fx.uMask.value = maskTexture;
    fx.uTexel.value.set(texel[0], texel[1]);
    fx.uRadius.value = radius;
    const fy = pass.fieldY.material.uniforms;
    fy.uFieldX.value = fieldTargets[0].texture;
    fy.uTexel.value.set(texel[0], texel[1]);
    fy.uRadius.value = radius;
    const u = pass.echo.material.uniforms;
    u.uPrev.value = targets[read.current].texture;
    u.uField.value = fieldTargets[1].texture;
    u.uHasMask.value = hasMask;
    u.uFade.value = Math.exp(-dt / OUTLINE.echoFade);
    u.uAspect.value = aspect;
    if (motion.centre)
      u.uCentre.value.set(motion.centre[0], 1 - motion.centre[1]);
    u.uHue.value = t * OUTLINE.hueDrift;
    const prevTarget = gl.getRenderTarget();
    if (hasMask) {
      gl.setRenderTarget(fieldTargets[0]);
      gl.render(pass.fieldX.scene, pass.cam);
      gl.setRenderTarget(fieldTargets[1]);
      gl.render(pass.fieldY.scene, pass.cam);
    }
    gl.setRenderTarget(targets[1 - read.current]);
    gl.render(pass.echo.scene, pass.cam);
    gl.setRenderTarget(prevTarget);
    read.current = 1 - read.current;

    // ── Display (echo + floor glow) ──
    const du = display.uniforms;
    du.uEcho.value = targets[read.current].texture;
    du.uMask.value = maskTexture;
    du.uHasMask.value = hasMask;
    du.uGlow.value = OUTLINE.glow + (OUTLINE.glowMoving - OUTLINE.glow) * p;
    du.uPulse.value = p;
    du.uHue.value = t * OUTLINE.hueDrift;
    du.uAspect.value = aspect;
    if (motion.foot)
      du.uFoot.value.set(motion.foot.x, 1 - motion.foot.y, motion.foot.width);
    const footTarget = motion.foot ? 1 : 0;
    du.uFootOn.value += (footTarget - du.uFootOn.value) * Math.min(1, dt * 4);

    // ── Sparkles: spawn on edge cells, more when moving ──
    const { width: vw, height: vh } = viewport.getCurrentViewport(
      cam3d,
      [0, 0, 0],
    );
    const pos = sparks.geometry.getAttribute("position") as BufferAttribute;
    const col = sparks.geometry.getAttribute("color") as BufferAttribute;
    const sizeAttr = sparks.geometry.getAttribute("size") as BufferAttribute;
    const alpha = sparks.geometry.getAttribute("alpha") as BufferAttribute;
    const pxScale = (size.height * gl.getPixelRatio()) / 1280;
    if (motion.edgeCount > 0 && motion.centre) {
      sparks.debt +=
        dt * (SPARKLES.rate + (SPARKLES.rateMoving - SPARKLES.rate) * p);
      while (sparks.debt >= 1) {
        sparks.debt -= 1;
        const cell = motion.edges[Math.floor(Math.random() * motion.edgeCount)];
        const cx = ((cell % motion.cols) + Math.random()) / motion.cols; // 0..1, x right
        const cy =
          (Math.floor(cell / motion.cols) + Math.random()) / motion.rows; // 0..1, y down
        const x = (cx - 0.5) * vw;
        const y = (0.5 - cy) * vh;
        const dx = (cx - motion.centre[0]) * aspect;
        const dy = -(cy - motion.centre[1]);
        const d = Math.hypot(dx, dy) || 1;
        const sp =
          SPARKLES.speed[0] +
          Math.random() * (SPARKLES.speed[1] - SPARKLES.speed[0]);
        const i = sparks.cursor;
        sparks.cursor = (sparks.cursor + 1) % SPARKLES.max;
        pos.setXYZ(i, x, y, 0.1);
        sparks.vel[i * 2] = (dx / d) * sp;
        sparks.vel[i * 2 + 1] = (dy / d) * sp + 0.12;
        const hue =
          (((Math.atan2(dy, dx) / (2 * Math.PI) + t * OUTLINE.hueDrift) % 1) +
            1) %
          1;
        color.setHSL(hue, 0.9, 0.65);
        col.setXYZ(i, color.r, color.g, color.b);
        const life =
          SPARKLES.life[0] +
          Math.random() * (SPARKLES.life[1] - SPARKLES.life[0]);
        sparks.life[i] = life;
        sparks.max[i] = life;
        sparks.base[i] =
          (SPARKLES.size[0] +
            Math.random() * (SPARKLES.size[1] - SPARKLES.size[0])) *
          pxScale;
      }
    }
    for (let i = 0; i < SPARKLES.max; i++) {
      if (sparks.life[i] <= 0) {
        alpha.setX(i, 0);
        continue;
      }
      sparks.life[i] -= dt;
      pos.setXYZ(
        i,
        pos.getX(i) + sparks.vel[i * 2] * dt,
        pos.getY(i) + sparks.vel[i * 2 + 1] * dt,
        0.1,
      );
      const k = Math.max(0, sparks.life[i] / sparks.max[i]);
      const tw = 0.6 + 0.4 * Math.sin(t * 18 + i);
      alpha.setX(i, k * tw);
      sizeAttr.setX(i, sparks.base[i] * (0.5 + 0.5 * k));
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    sizeAttr.needsUpdate = true;
    alpha.needsUpdate = true;
  }, -0.5);

  return (
    <>
      {/* ScreenImage (and PersonCutout, which is one) loads its default image through
          a suspending loader even when given a texture; it mounts here mid-session,
          so it needs its own Suspense boundary or the whole canvas goes down. */}
      <Suspense fallback={null}>
        <ScreenSpaceUI>
          {cameraTexture ? (
            <ScreenImage
              name="bodyOutlineBackground"
              source={{ kind: "texture", texture: cameraTexture }}
              anchors={FULL_SCREEN_ANCHORS}
              fit="stretch"
              color={BACKGROUND.tint}
              renderOrder={0}
            />
          ) : null}
          {/* No erode: the cut-out reaches the mask edge so it meets the outline with no
              dark gap (the outline covers any background fringe). */}
          <PersonCutout
            name="bodyOutlinePerson"
            renderOrder={100}
            maskErode={0}
            maskFeather={2}
          />
          <ScreenTransform anchors={FULL_SCREEN_ANCHORS}>
            <mesh material={display} renderOrder={150} frustumCulled={false}>
              <planeGeometry args={[1, 1]} />
            </mesh>
          </ScreenTransform>
        </ScreenSpaceUI>
      </Suspense>
      <points
        geometry={sparks.geometry}
        material={sparks.material}
        renderOrder={160}
        frustumCulled={false}
      />
    </>
  );
};
