import { createFileRoute } from "@tanstack/react-router";
import { LabView } from "@/components/lab-view";

export const Route = createFileRoute("/lab/pool")({ component: Page });

function Page() {
  return (
    <LabView
      title="Pool surface"
      node={() => import("@/lab/scenes/pool")}
      notes={[
        "?sim=analytic (default) perturbs normals procedurally; ?sim=compute runs a shallow-water height field in compute.",
        "?grid=192 sim cells per side. ?reflect=0.5 reflection resolution scale (0 = off). ?refract=0 skips the screen copy.",
      ]}
    />
  );
}
