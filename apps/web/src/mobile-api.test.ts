import { afterEach, expect, it, vi } from "vitest";
import { mobileApi } from "./mobile-api";

afterEach(() => vi.unstubAllGlobals());

it("中文和空格工作区路径可安全传入三个写请求的HTTP头", async () => {
  const fetch = vi.fn().mockResolvedValue({ok: true, json: async () => ({active: false})});
  vi.stubGlobal("fetch", fetch);
  const path = "/workspace/example/手机记录 2026";
  await mobileApi.startReceiver(path);
  await mobileApi.stopReceiver(path);
  await mobileApi.importArchive("{}", path);
  expect(fetch).toHaveBeenCalledTimes(3);
  for (const [, init] of fetch.mock.calls as [string, RequestInit][]) {
    const encoded = new Headers(init.headers).get("X-Lingxi-Workspace");
    expect(encoded).toBe(encodeURIComponent(path));
    expect(decodeURIComponent(encoded!)).toBe(path);
  }
});
