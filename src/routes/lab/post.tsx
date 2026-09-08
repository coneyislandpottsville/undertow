import { createFileRoute } from "@tanstack/react-router";
import { LabView } from "@/components/lab-view";

export const Route = createFileRoute("/lab/post")({ component: Page });

function Page() {
  return (
    <LabView
      title="Bloom and radial blur"
      node={() => import("@/lab/scenes/post")}
      gl={() => import("@/lab/scenes/post-gl")}
      notes={[
        "?bloom=1 ?blur=1 toggle passes. ?mrt=1 blooms the emissive channel only (node path); glsl uses UnrealBloomPass thresholding.",
        "?strength=0.8 ?radius=0.4 ?threshold=0.85 bloom; ?zoom=0.08 blur length.",
      ]}
    />
  );
}
