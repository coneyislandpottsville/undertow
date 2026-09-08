import { createFileRoute } from "@tanstack/react-router";
import { LabView } from "@/components/lab-view";

export const Route = createFileRoute("/lab/film")({ component: Page });

function Page() {
  return (
    <LabView
      title="Tube water film"
      node={() => import("@/lab/scenes/film")}
      gl={() => import("@/lab/scenes/film-gl")}
      notes={[
        "?speed=40 rider speed in m/s. ?flow=6 film speed. ?aniso=0.9 streak strength. ?refract=0.06 wall refraction.",
        "glsl = MeshPhysicalMaterial with onBeforeCompile flow mapping, the same look on the classic renderer.",
      ]}
    />
  );
}
