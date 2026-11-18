import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import type { Env } from "../../src/env";
import {
  installCorrelationConsole,
  isValidCorrelationId,
  withCorrelationId,
  type ConsoleLike,
} from "../../src/http/correlation";

const env: Env = {};
// #293 fake de teste: o ExecutionContext do Worker não tem construtor público.
const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {},
} as unknown as ExecutionContext;

const HEADER = "X-Correlation-Id";
const FORMAT = /^[A-Za-z0-9_-]{8,64}$/;

function fetchWorker(path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(`https://worker.test${path}`, init), env, ctx);
}

/** #293 Um console de mentira que guarda cada linha, para o teste não depender do console global. */
function recordingConsole(): ConsoleLike & { lines: unknown[][] } {
  const lines: unknown[][] = [];
  const record = (...args: unknown[]) => void lines.push(args);
  return { log: record, info: record, warn: record, error: record, lines };
}

function request(headers?: Record<string, string>): Request {
  return new Request("https://worker.test/x", { headers });
}

describe("X-Correlation-Id: o valor recebido", () => {
  it("#293/AC-1 devolve o mesmo valor quando é válido, num UUID", async () => {
    const id = "3f2b8c1e-5d4a-4e7b-9c10-a1b2c3d4e5f6";
    const response = await fetchWorker("/health", { headers: { [HEADER]: id } });
    expect(response.status).toBe(200);
    expect(response.headers.get(HEADER)).toBe(id);
  });

  it("#293/AC-1 devolve o mesmo valor nos limites de tamanho, 8 e 64 caracteres", async () => {
    for (const id of ["abcd_123", "A".repeat(64)]) {
      const response = await fetchWorker("/health", { headers: { [HEADER]: id } });
      expect(response.headers.get(HEADER)).toBe(id);
    }
  });

  it("#293/AC-1 devolve o id também no 401, no 405 e no 404 da API", async () => {
    const id = "corr-id-0001";
    const unauthenticated = await fetchWorker("/nao-existe", { headers: { [HEADER]: id } });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get(HEADER)).toBe(id);
    const notAllowed = await fetchWorker("/health", { method: "POST", headers: { [HEADER]: id } });
    expect(notAllowed.status).toBe(405);
    expect(notAllowed.headers.get(HEADER)).toBe(id);
  });

  it("#293/AC-1 devolve o id numa resposta de cabeçalhos imutáveis, como a dos assets", async () => {
    const immutable = Response.redirect("https://worker.test/outro", 302);
    expect(() => immutable.headers.set("x-teste", "1")).toThrow();
    const response = await withCorrelationId(request({ [HEADER]: "imutavel-001" }), async () => immutable);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://worker.test/outro");
    expect(response.headers.get(HEADER)).toBe("imutavel-001");
  });

  it("#293/AC-1 mantém status, texto de status, cabeçalhos e corpo da resposta", async () => {
    const original = new Response("corpo", { status: 418, statusText: "Bule", headers: { "x-a": "b" } });
    const response = await withCorrelationId(request({ [HEADER]: "mantem-0001" }), async () => original);
    expect(response.status).toBe(418);
    expect(response.statusText).toBe("Bule");
    expect(response.headers.get("x-a")).toBe("b");
    expect(await response.text()).toBe("corpo");
  });
});

describe("X-Correlation-Id: sem o cabeçalho", () => {
  it("#293/AC-2 devolve um id gerado, em formato válido, e outro a cada requisição", async () => {
    const first = await fetchWorker("/health");
    const second = await fetchWorker("/health");
    const a = first.headers.get(HEADER) ?? "";
    const b = second.headers.get(HEADER) ?? "";
    expect(a).toMatch(FORMAT);
    expect(b).toMatch(FORMAT);
    expect(a).not.toBe(b);
  });
});

describe("X-Correlation-Id: valor malformado", () => {
  const refused = [
    "curto",
    "A".repeat(65),
    "tem espaco no meio",
    "acento-ção-123",
    "ponto.e.virgula;",
    "<script>alert(1)</script>",
  ];

  it("#293/AC-3 troca o valor recusado por um id gerado, que não o contém, nem truncado", async () => {
    for (const bad of refused) {
      const response = await fetchWorker("/health", { headers: { [HEADER]: bad } });
      const id = response.headers.get(HEADER) ?? "";
      expect(id).toMatch(FORMAT);
      expect(id).not.toBe(bad);
      expect(JSON.stringify([...response.headers])).not.toContain(bad.slice(0, 8));
      expect(await response.text()).not.toContain(bad.slice(0, 8));
    }
  });

  it("#293/AC-3 o valor recusado não aparece em nenhuma linha de log, nem truncado", async () => {
    const fake = recordingConsole();
    installCorrelationConsole(fake);
    for (const bad of refused) {
      await withCorrelationId(request({ [HEADER]: bad }), async () => {
        fake.log("dentro", { rota: "/x" });
        return new Response("ok");
      });
    }
    expect(fake.lines).toHaveLength(refused.length);
    const logged = JSON.stringify(fake.lines);
    for (const bad of refused) expect(logged).not.toContain(bad.slice(0, 8));
  });

  it("#293/AC-3 decide o formato: só [A-Za-z0-9_-], de 8 a 64 caracteres", () => {
    expect(isValidCorrelationId("abcdefgh")).toBe(true);
    expect(isValidCorrelationId("a-b_C9z0")).toBe(true);
    expect(isValidCorrelationId("A".repeat(64))).toBe(true);
    for (const bad of ["", "abcdefg", "A".repeat(65), "abcdefg\r", "abcdefgh\nX-Evil: 1", "abcd efgh", "abcdefg!", null, undefined]) {
      expect(isValidCorrelationId(bad)).toBe(false);
    }
  });
});

describe("X-Correlation-Id: as linhas de log da requisição", () => {
  it("#293/AC-4 toda linha de log traz o id, inclusive a emitida depois de um await", async () => {
    const fake = recordingConsole();
    installCorrelationConsole(fake);
    const response = await withCorrelationId(request({ [HEADER]: "linha-0001" }), async () => {
      fake.log("antes", { a: 1 });
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 5));
      fake.warn("depois do await");
      fake.error("erro");
      fake.info("info");
      return new Response("ok");
    });
    expect(response.headers.get(HEADER)).toBe("linha-0001");
    expect(fake.lines).toHaveLength(4);
    for (const line of fake.lines) expect(line.at(-1)).toEqual({ correlationId: "linha-0001" });
    expect(fake.lines[0]).toEqual(["antes", { a: 1 }, { correlationId: "linha-0001" }]);
  });

  it("#293/AC-4 duas requisições concorrentes não trocam de id entre si", async () => {
    const fake = recordingConsole();
    installCorrelationConsole(fake);
    const run = (id: string, delay: number) =>
      withCorrelationId(request({ [HEADER]: id }), async () => {
        fake.log("inicio", id);
        await new Promise((resolve) => setTimeout(resolve, delay));
        fake.log("fim", id);
        return new Response(id);
      });
    const [a, b] = await Promise.all([run("requisicao-A1", 20), run("requisicao-B2", 5)]);
    expect(a.headers.get(HEADER)).toBe("requisicao-A1");
    expect(b.headers.get(HEADER)).toBe("requisicao-B2");
    expect(fake.lines).toHaveLength(4);
    for (const line of fake.lines) expect(line.at(-1)).toEqual({ correlationId: line[1] });
  });

  it("#293/AC-4 fora de uma requisição, como no Cron, a linha sai como foi escrita", () => {
    const fake = recordingConsole();
    installCorrelationConsole(fake);
    fake.log("cron", { a: 1 });
    expect(fake.lines).toEqual([["cron", { a: 1 }]]);
  });

  it("#293/AC-4 instalar de novo não empilha o id duas vezes", async () => {
    const fake = recordingConsole();
    installCorrelationConsole(fake);
    installCorrelationConsole(fake);
    await withCorrelationId(request({ [HEADER]: "idempot-001" }), async () => {
      fake.log("uma vez");
      return new Response("ok");
    });
    expect(fake.lines).toEqual([["uma vez", { correlationId: "idempot-001" }]]);
  });
});

describe("X-Correlation-Id: exceção que escapa da rota", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("#293/AC-1 o 500 leva o id, corpo genérico sem o texto da exceção, e o log leva o id", async () => {
    const fake = recordingConsole();
    installCorrelationConsole(fake);
    vi.stubGlobal("console", fake);
    const response = await withCorrelationId(request({ [HEADER]: "excecao-001" }), async () => {
      throw new Error("senha=segredo-do-banco");
    });
    expect(response.status).toBe(500);
    expect(response.headers.get(HEADER)).toBe("excecao-001");
    expect(await response.json()).toEqual({ error: "internal_error", correlationId: "excecao-001" });
    expect(fake.lines).toEqual([
      ["#293 exceção fora da rota", { errorName: "Error" }, { correlationId: "excecao-001" }],
    ]);
    expect(JSON.stringify(fake.lines)).not.toContain("segredo-do-banco");
  });

  it("#293/AC-2 sem o cabeçalho, o 500 leva um id gerado, o mesmo do corpo", async () => {
    const response = await withCorrelationId(request(), async () => {
      throw new TypeError("x");
    });
    const id = response.headers.get(HEADER) ?? "";
    expect(response.status).toBe(500);
    expect(id).toMatch(FORMAT);
    expect(await response.json()).toEqual({ error: "internal_error", correlationId: id });
  });
});
