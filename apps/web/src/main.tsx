import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "./ControlCenter.css";

if (window.__TAURI__?.core.invoke) {
  window.lingxiDesktop = {
    selectWorkspace: () =>
      window.__TAURI__!.core.invoke<string | null>("choose_workspace"),
    defaultWorkspace: () =>
      window.__TAURI__!.core.invoke<string>("default_workspace"),
  };
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
