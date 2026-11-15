import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";

const env: Env = {};
const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {},
} as unknown as ExecutionContext;

function fetchWorker(path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(`https://worker.test${path}`, init), env, ctx);
}

describe("GET /health", () => {
  it("#57/AC-2 responde 200 com status ok em JSON", async () => {
    const response = await fetchWorker("/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("responde 405 a um método que não é GET", async () => {
    const response = await fetchWorker("/health", { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });

  it("responde 405 a um método com nome de propriedade herdada", async () => {
    const response = await fetchWorker("/health", { method: "constructor" });
    expect(response.status).toBe(405);
  });
});

// O 404 de rota desconhecida, com token válido, está em access.test.ts (#54).
describe("rota desconhecida sem token", () => {
  it("#54 responde 401 antes de procurar a rota, mesmo sem o Access configurado", async () => {
    const response = await fetchWorker("/nao-existe");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
  });

  it("responde 401 num caminho com nome de propriedade herdada", async () => {
    const response = await fetchWorker("/constructor");
    expect(response.status).toBe(401);
  });
});

describe("scheduled", () => {
  it("roda sem erro e registra uma linha", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const controller = {
      cron: "*/15 * * * *",
      scheduledTime: Date.now(),
      noRetry: () => {},
    } as ScheduledController;
    await expect(worker.scheduled(controller, env, ctx)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });
});
