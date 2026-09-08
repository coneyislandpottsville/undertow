import { createFileRoute } from "@tanstack/react-router";
import { LabView } from "@/components/lab-view";

export const Route = createFileRoute("/lab/whirlpool")({ component: Page });

function Page() {
  return (
    <LabView
      title="Whirlpool funnel"
      node={() => import("@/lab/scenes/whirlpool")}
      notes={[
        "?energy=0..1 fixes the vortex; by default it breathes between 0.15 and 1.",
        "?depth=6 throat depth in metres at full energy. ?drop=0 keeps the camera at the rim.",
      ]}
    />
  );
}
