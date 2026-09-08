import { create } from "zustand";

export type RideMode = "slide" | "whirl" | "paddle";

export type HudState = {
  ready: boolean;
  focused: boolean;
  speed: number;
  mode: RideMode;
  drop: number;
  depth: number;
  hint: string;
  exits: number;
  seed: string;
  fullscreen: boolean;
  patch: (partial: Partial<Omit<HudState, "patch">>) => void;
};

export const useHud = create<HudState>((set) => ({
  ready: false,
  focused: false,
  speed: 0,
  mode: "slide",
  drop: 1,
  depth: 0,
  hint: "W paddle · S brake · A/D lean",
  exits: 0,
  seed: "",
  fullscreen: false,
  patch: (partial) => set(partial),
}));
