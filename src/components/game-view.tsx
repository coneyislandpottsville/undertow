import { Maximize2, Minimize2 } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Game } from "@/game/game";
import { useHud, type RideMode } from "@/game/hud-state";

const MODE_LABEL: Record<RideMode, string> = {
  slide: "Slide",
  whirl: "Whirlpool",
  paddle: "Paddle",
};

export function GameView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<{
    dispose: () => void;
    setTouch: (code: string, held: boolean) => void;
    toggleFullscreen: () => void;
    unlockAndFocus: () => void;
  } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const hud = useHud();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let instance: Game | null = null;
    let cancelled = false;
    const id = requestAnimationFrame(() => {
      if (cancelled) return;
      try {
        instance = new Game(canvas);
        instance.start();
        gameRef.current = instance;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Failed to start renderer";
        setFailed(message);
      }
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(id);
      instance?.dispose();
      gameRef.current = null;
    };
  }, []);

  const hold = (code: string) => (e: PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    gameRef.current?.setTouch(code, true);
  };
  const release = (code: string) => (e: PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    gameRef.current?.setTouch(code, false);
  };

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-bg text-fg">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full touch-none"
        aria-label="Undertow waterslide"
      />

      {failed && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-bg px-6 text-center">
          <p className="max-w-md text-sm text-danger">{failed}</p>
        </div>
      )}

      {!hud.focused && !failed && (
        <button
          type="button"
          className="absolute inset-0 z-20 flex items-center justify-center bg-bg/35"
          onClick={() => gameRef.current?.unlockAndFocus()}
        >
          <span className="rounded-xl border border-border bg-surface/90 px-6 py-3 text-sm font-medium tracking-wide text-fg">
            Click to ride
          </span>
        </button>
      )}

      <div className="pointer-events-none absolute inset-0 z-10 flex flex-col justify-between p-4 sm:p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="rounded-lg border border-border bg-surface/80 px-3 py-2">
            <p className="text-[0.65rem] font-medium uppercase tracking-[0.16em] text-subtle">
              Drop {hud.drop}
            </p>
            <p className="mt-0.5 font-medium tabular-nums text-fg">
              <span className="text-xl leading-none">{Math.round(Math.abs(hud.speed) * 3.6)}</span>
              <span className="ml-1.5 text-[0.7rem] text-muted">km/h</span>
            </p>
          </div>
          <div className="flex items-start gap-2">
            <div className="rounded-lg border border-border bg-surface/80 px-3 py-2 text-right">
              <p className="text-[0.65rem] font-medium uppercase tracking-[0.16em] text-subtle">
                {MODE_LABEL[hud.mode]}
              </p>
              <p className="mt-0.5 text-sm tabular-nums text-fg">
                {hud.mode === "paddle"
                  ? `${hud.exits} exits`
                  : hud.mode === "whirl"
                    ? "Hold on"
                    : `${Math.max(-2, Math.min(7, hud.g)).toFixed(1)} g`}
              </p>
            </div>
            <button
              type="button"
              className="pointer-events-auto hidden h-11 w-11 items-center justify-center rounded-lg border border-border bg-surface/80 text-fg sm:flex"
              aria-label={hud.fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              onClick={() => gameRef.current?.toggleFullscreen()}
            >
              {hud.fullscreen ? (
                <Minimize2 className="size-4" strokeWidth={1.75} />
              ) : (
                <Maximize2 className="size-4" strokeWidth={1.75} />
              )}
            </button>
          </div>
        </div>

        <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-end sm:justify-between">
          <p className="order-2 max-w-md text-center text-xs leading-relaxed text-muted sm:order-1 sm:max-w-xs sm:text-left sm:text-[0.7rem]">
            {hud.hint}
          </p>
          <div className="pointer-events-auto order-1 grid grid-cols-4 gap-2 sm:hidden">
            <TouchKey label="L" onDown={hold("KeyA")} onUp={release("KeyA")} />
            <TouchKey label="Paddle" onDown={hold("KeyW")} onUp={release("KeyW")} primary />
            <TouchKey label="Brake" onDown={hold("KeyS")} onUp={release("KeyS")} />
            <TouchKey label="R" onDown={hold("KeyD")} onUp={release("KeyD")} />
          </div>
          <p className="order-3 hidden text-[0.7rem] text-subtle sm:block">F fullscreen</p>
        </div>
      </div>
    </main>
  );
}

function TouchKey({
  label,
  onDown,
  onUp,
  primary = false,
}: {
  label: string;
  onDown: (e: PointerEvent<HTMLButtonElement>) => void;
  onUp: (e: PointerEvent<HTMLButtonElement>) => void;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      className={
        "h-11 min-w-11 rounded-md border px-3 text-xs font-medium " +
        (primary
          ? "border-accent/40 bg-accent text-bg"
          : "border-border bg-surface/90 text-fg")
      }
      onPointerDown={onDown}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      {label}
    </button>
  );
}
