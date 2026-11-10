import { useState } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { api, type DirectModelSettings } from "./api";
import { DEFAULT_PREFERENCES, loadPreferences, savePreferences, SettingsCenter, type AppPreferences } from "./ControlCenter";

const empty: DirectModelSettings = { base_url: "", model: "", key_env: "", has_key: false, configured: false, key_storage: "none" };
const ready: DirectModelSettings = { base_url: "https://model.example/v1", model: "test-model", key_env: "", has_key: true, configured: true, key_storage: "session" };

function Harness() {
  const [preferences, setPreferences] = useState<AppPreferences>(DEFAULT_PREFERENCES);
  return <SettingsCenter preferences={preferences} executors={[]} openedPath="" activeTab="models"
    onTabChange={() => {}} onChange={(next) => { savePreferences(next); setPreferences(next); }}
    onStartGuide={() => {}} onUseTemplate={() => {}} onUseDefaultWorkspace={() => {}}
    onChooseWorkspace={() => {}} workspaceBusy={false} />;
}

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(api, "getDirectModelSettings").mockResolvedValue(empty);
  vi.spyOn(api, "configureDirectModel").mockResolvedValue(ready);
  vi.spyOn(api, "testDirectModel").mockResolvedValue({ ok: true, model: "test-model" });
});
afterEach(() => vi.restoreAllMocks());

describe("direct API model settings", () => {
  it("saves to the local service without persisting the key or activating the engine", async () => {
    const user = userEvent.setup();
    const notification = vi.fn();
    window.addEventListener("lingxi:model-settings-changed", notification);
    const view = render(<Harness />);
    const form = screen.getByRole("form", { name: "API 直连配置" });
    await waitFor(() => expect(within(form).getByLabelText("API 地址")).toBeEnabled());
    await user.type(within(form).getByLabelText("API 地址"), ready.base_url);
    await user.type(within(form).getByLabelText("模型名称"), ready.model);
    await user.type(within(form).getByLabelText("API Key"), "not-a-real-test-secret");
    await user.click(within(form).getByRole("button", { name: "保存 API 配置" }));

    await waitFor(() => expect(api.configureDirectModel).toHaveBeenCalledWith({ base_url: ready.base_url, model: ready.model, api_key: "not-a-real-test-secret", key_env: "" }));
    expect(within(form).getByLabelText("API Key")).toHaveValue("");
    expect(loadPreferences().textEngine).toBe("local_demo");
    expect(JSON.stringify(window.localStorage)).not.toContain("not-a-real-test-secret");
    expect(window.localStorage.getItem("lingxi.direct-model.preferences.v1")).toContain(ready.base_url);
    expect(screen.getByText("配置已保存，尚未测试连接；默认执行器未切换。")).toBeVisible();
    expect(api.testDirectModel).not.toHaveBeenCalled();
    expect(notification).toHaveBeenCalledTimes(1);

    await user.selectOptions(screen.getByLabelText("文本分析主模型"), "api");
    expect(loadPreferences().textEngine).toBe("api");
    view.unmount();
    render(<Harness />);
    await waitFor(() => expect(screen.getByLabelText("API 地址")).toHaveValue(ready.base_url));
    expect(screen.getByLabelText("API Key")).toHaveValue("");
    window.removeEventListener("lingxi:model-settings-changed", notification);
  });

  it("shows a successful connection only after a real test response and surfaces failures", async () => {
    vi.mocked(api.getDirectModelSettings).mockResolvedValue(ready);
    const user = userEvent.setup();
    render(<Harness />);
    const button = screen.getByRole("button", { name: "测试已保存配置" });
    await waitFor(() => expect(button).toBeEnabled());
    vi.mocked(api.testDirectModel).mockRejectedValueOnce(new Error("连接测试失败，请核对地址、模型与凭据。"));
    await user.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("连接测试失败，请核对地址、模型与凭据。");
    expect(screen.queryByText("连接测试通过：test-model")).not.toBeInTheDocument();
    await user.click(button);
    expect(await screen.findByRole("status")).toHaveTextContent("连接测试通过：test-model");
  });

  it("uses an environment reference and disables testing unsaved changes", async () => {
    const user = userEvent.setup();
    vi.mocked(api.configureDirectModel).mockResolvedValue({ ...ready, key_env: "LINGXI_MODEL_API_KEY", key_storage: "environment" });
    render(<Harness />);
    await waitFor(() => expect(screen.getByLabelText("API 地址")).toBeEnabled());
    await user.type(screen.getByLabelText("API 地址"), ready.base_url);
    await user.type(screen.getByLabelText("模型名称"), ready.model);
    await user.selectOptions(screen.getByLabelText("凭据来源"), "environment");
    await user.type(screen.getByLabelText("环境变量名称"), "LINGXI_MODEL_API_KEY");
    await user.click(screen.getByRole("button", { name: "保存 API 配置" }));
    await waitFor(() => expect(api.configureDirectModel).toHaveBeenCalledWith({ base_url: ready.base_url, model: ready.model, key_env: "LINGXI_MODEL_API_KEY" }));
    expect(screen.getByRole("button", { name: "测试已保存配置" })).toBeEnabled();
    await user.type(screen.getByLabelText("模型名称"), "-changed");
    expect(screen.getByRole("button", { name: "测试已保存配置" })).toBeDisabled();
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
  });
});
