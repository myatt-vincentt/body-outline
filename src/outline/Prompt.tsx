// One quiet line at the bottom: while the segmentation model loads, and when
// nobody is in view. Otherwise there is no UI.
import { useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { ScreenSpaceUI, ScreenText } from "@vincentt-xr/sdk";
import { useXRReady } from "@vincentt-xr/sdk/low-level";

import { outlineState } from "./BodyOutline";

/** Fewer active grid cells than this for this long → "Step into the frame". */
const MIN_CELLS = 30;
const AFTER = 1.2;

export const Prompt = () => {
  const cameraReady = useXRReady();
  const [text, setText] = useState("");
  const empty = useRef(0);

  useFrame((_s, dt) => {
    empty.current = outlineState.active < MIN_CELLS ? empty.current + dt : 0;
    let next = "";
    if (cameraReady && !outlineState.maskReady) next = "Finding you…";
    else if (cameraReady && empty.current > AFTER) next = "Step into the frame";
    if (next !== text) setText(next);
  });

  if (!text) return null;
  return (
    <ScreenSpaceUI>
      <ScreenText
        name="bodyOutlinePrompt"
        text={text}
        screenTransform={{ position: { x: 0, y: -560 }, size: { width: 640, height: 70 }, renderOrder: 200, overlay: true }}
        textAlign="center"
        verticalAlign="center"
        fontFamily='system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
        fontWeight={600}
        fontSize={30}
        resolution={150}
        letterSpacing={0.04}
        color="rgba(240,242,248,0.85)"
        bgColor="transparent"
      />
    </ScreenSpaceUI>
  );
};
