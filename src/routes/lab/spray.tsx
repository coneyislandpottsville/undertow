import { createFileRoute } from "@tanstack/react-router";
import { LabView } from "@/components/lab-view";

export const Route = createFileRoute("/lab/spray")({ component: Page });

function Page() {
  return (
    <LabView
      title="Spray and mist"
      node={() => import("@/lab/scenes/spray")}
      gl={() => import("@/lab/scenes/spray-gl")}
      notes={[
        "?n=50000 particles (compute on webgpu, transform feedback on webgl, CPU on glsl). ?mist=48 mist billboards.",
        "?soft=0.35 depth-fade distance in metres. ?size=0.09 particle size in metres.",
      ]}
    />
  );
}
