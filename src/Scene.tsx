// Scene.tsx — Body Outline: you, on a dimmed camera background, traced by a
// rainbow outline that leaves echoes, pulses and sparkles when you move.
// See PLAN.md.
import { lazy, Suspense } from "react";

import { BodyOutline } from "./outline/BodyOutline";
import { ExperienceStatus } from "./outline/ExperienceStatus";
import { Prompt } from "./outline/Prompt";

// Dev-only media switcher (SDK sample videos / images / webcam) for previewing
// without a camera. Lazy and behind a constant esbuild folds to false in
// production. Two rules: `process.env.NODE_ENV`, not `import.meta.env.DEV`
// (vincentt-xr/v2-template#112); and write the check INSIDE the ternary —
// hoisted into a `const`, esbuild keeps the dead branch.
const DevMediaSwitcher =
  process.env.NODE_ENV !== "production" ? lazy(() => import("./DevMediaSwitcher")) : null;

export const Scene = () => (
  <>
    <ExperienceStatus />
    <BodyOutline />
    <Prompt />
    {DevMediaSwitcher ? (
      <Suspense fallback={null}>
        <DevMediaSwitcher />
      </Suspense>
    ) : null}
  </>
);
