import { createSignal } from "solid-js";
import { getBundledTheme } from "../../src/theme/bundled";
import { applyResolved } from "../../src/theme/resolver";
import { buildRoles } from "../../src/theme/roles";

export type Theme = "dark" | "light";

const THEME_KEY = "tori.mobile.theme";
const WHEEL_KEY = "tori.mobile.wheel";
const SPACE_KEY = "tori.mobile.space";

const [theme, setThemeSignal] = createSignal<Theme>(localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark");
const [showWheel, setShowWheelSignal] = createSignal(localStorage.getItem(WHEEL_KEY) !== "off");
const [spaceName, setSpaceNameSignal] = createSignal(localStorage.getItem(SPACE_KEY));

export { theme, showWheel, spaceName };

type Bars = { paint: (color: string, light: boolean) => void };

export function paintTheme(value: Theme) {
  const bundled = getBundledTheme(value === "light" ? "tori-light" : "tori-dark");
  if (!bundled) return;
  applyResolved(buildRoles(bundled.palette), bundled.appearance);
  const canvas = getComputedStyle(document.documentElement).getPropertyValue("--canvas-default").trim();
  (window as { toriBars?: Bars }).toriBars?.paint(canvas, value === "light");
}

export function setTheme(value: Theme) {
  localStorage.setItem(THEME_KEY, value);
  setThemeSignal(value);
  paintTheme(value);
}

export function setShowWheel(on: boolean) {
  localStorage.setItem(WHEEL_KEY, on ? "on" : "off");
  setShowWheelSignal(on);
}

export function setSpaceName(name: string) {
  localStorage.setItem(SPACE_KEY, name);
  setSpaceNameSignal(name);
}
