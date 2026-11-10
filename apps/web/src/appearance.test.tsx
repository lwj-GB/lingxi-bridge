import { COLOR_THEMES } from "./appearance";
import { useEffect, useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyAppearance,
  DEFAULT_PREFERENCES,
  loadPreferences,
  savePreferences,
  SettingsCenter,
  type AppPreferences,
} from "./ControlCenter";

function SettingsHarness() {
  const [preferences, setPreferences] = useState<AppPreferences>(loadPreferences);
  useEffect(() => {
    savePreferences(preferences);
    applyAppearance(preferences, false);
  }, [preferences]);
  return <SettingsCenter
    preferences={preferences} executors={[]} openedPath="" activeTab="general"
    onTabChange={() => {}} onChange={setPreferences} onStartGuide={() => {}}
    onUseTemplate={() => {}} onUseDefaultWorkspace={() => {}}
    onChooseWorkspace={() => {}} workspaceBusy={false}
  />;
}

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  document.documentElement.removeAttribute("style");
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.accent;
  delete document.documentElement.dataset.colorTheme;
});

describe("professional color themes", () => {
  it("changes palette and typography through settings and restores them on reload", async () => {
    const user = userEvent.setup();
    const first = render(<SettingsHarness />);
    await user.click(screen.getByRole("button", { name: "Monokai 深色" }));
    await user.selectOptions(screen.getByLabelText("界面字体"), "mono");
    await user.selectOptions(screen.getByLabelText("界面字号"), "16");

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--paper")).toBe("#272822");
    expect(document.documentElement.style.getPropertyValue("--ui-font-size")).toBe("16px");
    expect(document.documentElement.style.getPropertyValue("--ui-font")).toContain("Menlo");
    first.unmount();
    render(<SettingsHarness />);
    expect(screen.getByRole("button", { name: "Monokai 深色" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("界面字号")).toHaveValue("16");
    expect(loadPreferences()).toMatchObject({ colorTheme: "monokai-dark", theme: "dark", fontFamily: "mono", fontSize: 16 });
  });

  it("keeps legacy light/dark and accent controls working after selecting a preset", async () => {
    const user = userEvent.setup();
    render(<SettingsHarness />);
    await user.click(screen.getByRole("button", { name: "VS Code 现代深色" }));
    await user.click(screen.getByRole("button", { name: "浅色" }));
    await user.click(screen.getByRole("button", { name: "翡翠" }));
    expect(loadPreferences()).toMatchObject({ theme: "light", accent: "green" });
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.accent).toBe("green");
    expect(document.documentElement.style.getPropertyValue("--paper")).toBe("#ffffff");
    expect(document.documentElement.style.getPropertyValue("--clay")).toBe("#28785b");
    expect(document.documentElement.style.getPropertyValue("--workbench-rail")).toBe("#28785b");
    const soft = document.documentElement.style.getPropertyValue("--blue-soft");
    for (const token of ["--sage-soft", "--rose-soft", "--gold-soft"]) {
      expect(document.documentElement.style.getPropertyValue(token)).toBe(soft);
    }
  });

  it("applies every complete palette through settings without mixing a blue rail into red", async () => {
    const user = userEvent.setup();
    render(<SettingsHarness />);
    expect(COLOR_THEMES).toHaveLength(12);
    for (const theme of COLOR_THEMES) {
      await user.click(screen.getByRole("button", { name: theme.name }));
      expect(document.documentElement.dataset.colorTheme).toBe(theme.id);
      expect(loadPreferences()).toMatchObject({ colorTheme: theme.id, accent: theme.accent, theme: theme.mode });
      const root = document.documentElement.style;
      expect(root.getPropertyValue("--sage")).toBe(root.getPropertyValue("--clay-dark"));
      expect(root.getPropertyValue("--gold-soft")).toBe(root.getPropertyValue("--blue-soft"));
    }
    await user.click(screen.getByRole("button", { name: "胭脂红白" }));
    expect(document.documentElement.style.getPropertyValue("--workbench-rail")).toBe("#ac3e4b");
    expect(document.documentElement.style.getPropertyValue("--clay")).toBe("#ac3e4b");
  });

  it("migrates old preferences and rejects unsupported appearance values", () => {
    window.localStorage.setItem("lingxi.preferences.v1", JSON.stringify({ theme: "dark", accent: "orange", fontSize: 90, fontFamily: "downloaded", colorTheme: "unknown" }));
    const legacy = loadPreferences();
    expect(legacy).toMatchObject({ theme: "dark", accent: "orange", fontFamily: "system", fontSize: 14 });
    expect(legacy.colorTheme).toBeUndefined();
    applyAppearance(legacy, false);
    expect(document.documentElement.dataset.colorTheme).toBe("vscode-dark");
    applyAppearance({ ...DEFAULT_PREFERENCES, theme: "system", colorTheme: undefined }, true);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
