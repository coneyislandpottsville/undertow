import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/lab/")({ component: LabIndex });

const ROUTES = [
  {
    to: "/lab/whirlpool",
    name: "Whirlpool funnel",
    what: "Displaced vortex surface, foam lip, energy-driven throat.",
  },
  {
    to: "/lab/pool",
    name: "Pool surface",
    what: "Planar reflection, refraction, absorption; ?sim=compute for the height field.",
  },
  {
    to: "/lab/film",
    name: "Tube water film",
    what: "Flow-mapped normals, anisotropic streaks, wet roughness at 40 m/s.",
  },
  {
    to: "/lab/spray",
    name: "Spray and mist",
    what: "GPU particles with soft depth fade, lit by the rider light.",
  },
  {
    to: "/lab/post",
    name: "Bloom and radial blur",
    what: "Post stack on a representative tube with exit rings.",
  },
] as const;

/** Unlisted research index; nothing in the ride links here. */
function LabIndex() {
  return (
    <main className="min-h-dvh bg-bg p-6 text-fg">
      <h1 className="text-lg font-medium">Undertow lab</h1>
      <p className="mt-1 max-w-xl text-sm text-muted">
        Water prototypes for docs/research/water-and-renderer.md. Query knobs: ?backend=webgpu|webgl|glsl,
        ?res=2560x1080, ?palette=lagoon|abyss|kelp|slate, ?msaa=0.
      </p>
      <ul className="mt-5 space-y-2">
        {ROUTES.map((r) => (
          <li key={r.to} className="rounded-lg border border-border bg-surface/80 px-4 py-3">
            <Link to={r.to} className="font-medium text-accent">
              {r.name}
            </Link>
            <p className="text-xs text-muted">{r.what}</p>
          </li>
        ))}
      </ul>
    </main>
  );
}
