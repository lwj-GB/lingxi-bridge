import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => {
  const demoWorkspace =
    mode === "development"
      ? decodeURIComponent(
          new URL("../../examples/vault-v0.1", import.meta.url).pathname,
        ).replace(/\/$/, "")
      : undefined;

  return {
    plugins: [react()],
    define: demoWorkspace
      ? {
          "import.meta.env.VITE_DEMO_VAULT_PATH":
            JSON.stringify(demoWorkspace),
        }
      : undefined,
    server: {
      port: 5173,
      strictPort: true,
    },
    test: {
      environment: "jsdom",
      setupFiles: "./src/setupTests.ts",
      css: true,
      restoreMocks: true,
    },
  };
});
