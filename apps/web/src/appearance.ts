export type ColorTheme =
  | "positron-light"
  | "vscode-light"
  | "vscode-dark"
  | "github-light"
  | "solarized-light"
  | "monokai-dark"
  | "carmine-light"
  | "forest-light"
  | "iris-light"
  | "amber-light"
  | "graphite-light"
  | "teal-dark";
export type InterfaceFont = "system" | "sans" | "serif" | "mono";

type Accent = "orange" | "blue" | "green" | "purple" | "rose" | "neutral";
type Mode = "light" | "dark";

interface Palette {
  mode: Mode;
  paper: string;
  surface: string;
  ink: string;
  muted: string;
  line: string;
  rail: string;
  railInk: string;
  accent: string;
}

export const COLOR_THEMES: Array<{
  id: ColorTheme;
  name: string;
  mode: Mode;
  accent: Accent;
}> = [
  { id: "positron-light", name: "Positron 浅色", mode: "light", accent: "blue" },
  { id: "vscode-light", name: "VS Code 现代浅色", mode: "light", accent: "blue" },
  { id: "vscode-dark", name: "VS Code 现代深色", mode: "dark", accent: "blue" },
  { id: "github-light", name: "GitHub 浅色", mode: "light", accent: "blue" },
  { id: "solarized-light", name: "Solarized 浅色", mode: "light", accent: "green" },
  { id: "monokai-dark", name: "Monokai 深色", mode: "dark", accent: "rose" },
  { id: "carmine-light", name: "胭脂红白", mode: "light", accent: "rose" },
  { id: "forest-light", name: "松林绿白", mode: "light", accent: "green" },
  { id: "iris-light", name: "鸢尾紫白", mode: "light", accent: "purple" },
  { id: "amber-light", name: "琥珀暖白", mode: "light", accent: "orange" },
  { id: "graphite-light", name: "石墨灰白", mode: "light", accent: "neutral" },
  { id: "teal-dark", name: "青墨深色", mode: "dark", accent: "green" },
];

const PALETTES: Record<ColorTheme, Palette> = {
  "positron-light": { mode: "light", paper: "#ffffff", surface: "#f8f8f8", ink: "#30343b", muted: "#68717c", line: "#dcdcdc", rail: "#326fa5", railInk: "#ffffff", accent: "#337ab7" },
  "vscode-light": { mode: "light", paper: "#ffffff", surface: "#f3f3f3", ink: "#1f1f1f", muted: "#616161", line: "#dedede", rail: "#f3f3f3", railInk: "#454545", accent: "#0078d4" },
  "vscode-dark": { mode: "dark", paper: "#1f1f1f", surface: "#181818", ink: "#cccccc", muted: "#a6a6a6", line: "#383838", rail: "#181818", railInk: "#cccccc", accent: "#4daafc" },
  "github-light": { mode: "light", paper: "#ffffff", surface: "#f6f8fa", ink: "#1f2328", muted: "#59636e", line: "#d1d9e0", rail: "#f6f8fa", railInk: "#59636e", accent: "#0969da" },
  "solarized-light": { mode: "light", paper: "#fdf6e3", surface: "#eee8d5", ink: "#586e75", muted: "#586e75", line: "#d9d2c2", rail: "#eee8d5", railInk: "#4e656c", accent: "#268079" },
  "carmine-light": { mode: "light", paper: "#ffffff", surface: "#faf6f6", ink: "#352e30", muted: "#74666a", line: "#e5d9dc", rail: "#ac3e4b", railInk: "#ffffff", accent: "#ac3e4b" },
  "forest-light": { mode: "light", paper: "#ffffff", surface: "#f5f8f6", ink: "#2d3731", muted: "#637369", line: "#d7e2db", rail: "#2f7054", railInk: "#ffffff", accent: "#2f7054" },
  "iris-light": { mode: "light", paper: "#ffffff", surface: "#f7f5fa", ink: "#342e3d", muted: "#71677e", line: "#dfd9e8", rail: "#70549c", railInk: "#ffffff", accent: "#70549c" },
  "amber-light": { mode: "light", paper: "#fffefa", surface: "#f8f4eb", ink: "#39342b", muted: "#766c5b", line: "#e3dcca", rail: "#94611c", railInk: "#ffffff", accent: "#94611c" },
  "graphite-light": { mode: "light", paper: "#ffffff", surface: "#f5f6f7", ink: "#2e343b", muted: "#68717c", line: "#dce0e4", rail: "#525c68", railInk: "#ffffff", accent: "#525c68" },
  "teal-dark": { mode: "dark", paper: "#172421", surface: "#111c19", ink: "#dfebe7", muted: "#a1b8b0", line: "#344b43", rail: "#111c19", railInk: "#dfebe7", accent: "#73c9b5" },
  "monokai-dark": { mode: "dark", paper: "#272822", surface: "#20211b", ink: "#f8f8f2", muted: "#b5b5a7", line: "#494a40", rail: "#20211b", railInk: "#f8f8f2", accent: "#ed6f9d" },
};

export function colorThemePreview(id: ColorTheme): string {
  const palette = PALETTES[id];
  return `linear-gradient(90deg, ${palette.rail} 0 24%, ${palette.paper} 24% 76%, ${palette.accent} 76% 100%)`;
}

const FONTS: Record<InterfaceFont, string> = {
  system: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif',
  sans: '"Noto Sans CJK SC", "Source Han Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
  serif: '"Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", SimSun, serif',
  mono: '"SFMono-Regular", Menlo, Consolas, "PingFang SC", monospace',
};

const ACCENTS: Record<Accent, [string, string]> = {
  orange: ["#a9563a", "#e9a286"],
  blue: ["#337ab7", "#72b4ee"],
  green: ["#28785b", "#80c6a6"],
  purple: ["#7056a0", "#bc9ee7"],
  rose: ["#a64c6b", "#e9a1bb"],
  neutral: ["#555f6b", "#b5bec9"],
};

export function isColorTheme(value: unknown): value is ColorTheme {
  return COLOR_THEMES.some((theme) => theme.id === value);
}

export function isInterfaceFont(value: unknown): value is InterfaceFont {
  return typeof value === "string" && Object.hasOwn(FONTS, value);
}

export function applyAppearance(
  preferences: {
    theme: Mode | "system";
    accent: Accent;
    colorTheme?: ColorTheme;
    fontFamily?: InterfaceFont;
    fontSize?: number;
  },
  prefersDark: boolean,
) {
  const mode = preferences.theme === "system"
    ? (prefersDark ? "dark" : "light")
    : preferences.theme;
  const preset = COLOR_THEMES.find((item) => item.id === preferences.colorTheme);
  // A manual light/dark change keeps the legacy mode controls effective.
  const id = preset?.mode === mode
    ? preset.id
    : mode === "dark" ? "vscode-dark" : "positron-light";
  const palette = PALETTES[id];
  const accent = preset?.id === id && preset.accent === preferences.accent
    ? palette.accent
    : ACCENTS[preferences.accent][mode === "dark" ? 1 : 0];
  // A custom accent recolors a colored rail too; neutral rails remain neutral.
  const rail = palette.rail === palette.surface ? palette.rail
    : preset?.id === id && preset.accent === preferences.accent ? palette.rail : accent;
  const soft = `color-mix(in srgb, ${palette.paper} 92%, ${accent})`;
  const root = document.documentElement;
  root.dataset.theme = mode;
  root.dataset.accent = preferences.accent;
  root.dataset.colorTheme = id;
  root.style.colorScheme = mode;
  const font = isInterfaceFont(preferences.fontFamily) ? preferences.fontFamily : "system";
  const fontSize = [12, 13, 14, 15, 16].includes(preferences.fontSize ?? 0) ? preferences.fontSize! : 14;
  const variables: Record<string, string> = {
    "--paper": palette.paper,
    "--paper-warm": palette.surface,
    "--ink": palette.ink,
    "--muted": palette.muted,
    "--line": palette.line,
    "--clay": mode === "dark" ? `color-mix(in srgb, ${accent} 62%, #000000)` : accent,
    "--clay-dark": accent,
    "--sage": accent,
    "--sage-soft": soft,
    "--rose-soft": soft,
    "--gold-soft": soft,
    "--blue-soft": soft,
    "--shadow": "none",
    "--workbench-rail": rail,
    "--workbench-rail-ink": palette.railInk,
    "--ui-font": FONTS[font],
    "--ui-font-size": `${fontSize}px`,
    "--error-ink": mode === "dark" ? "#ffb4ab" : "#b13b3b",
  };
  Object.entries(variables).forEach(([key, value]) => root.style.setProperty(key, value));
}
