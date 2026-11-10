/// <reference types="vite/client" />

interface Window {
  __TAURI__?: {
    core: {
      invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
    };
  };
  lingxiDesktop?: {
    selectWorkspace(): Promise<string | null>;
    defaultWorkspace?(): Promise<string>;
  };
}
