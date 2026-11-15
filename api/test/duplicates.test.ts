import { describe, expect, it } from "vitest";
import type { AccessVerifier } from "../src/http/access";
import { toDuplicateEntry, type DuplicateEntry, type DuplicatesReader } from "../src/http/duplicates";
import { createWorker } from "../src/index";
import type { Env } from "../src/env";
import { Invoice, Money, Quantity, type PostedInvoice } from "../src/domain/index.js";
import { emptyContext } from "./domain/fixtures.js";

const env: Env = { ACCESS_AUD: "aud", ACCESS_TEAM_DOMAIN: "time.cloudflareaccess.com" };
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;

/** Verificador falso: aceita só o token "bom", sem rede nem chave. */
const fakeVerifier: AccessVerifier = {
  async verify(token) {
    return token === "bom" ? { ok: true, identity: { email: "analista@jachegou.test" } } : { ok: false, reason: "invalid" };
  },
};

// NF-012 do kit, cobrando de novo a ordem OC-2026-42812 já lançada pela nota 89410.
const posted89410: PostedInvoice = {
  accessKey: "35261194433432000143550010000894101464288543",
  number: "89410",
  supplierId: "F03",
  purchaseOrderRef: "OC-2026-42812",
  total: Money.ofCents(120960),
  status: "lançada",
};

function nf012(): Invoice {
  const line = (code: string, sku: string, description: string, qty: number, cents: number) => ({
    supplierCode: code,
    sku,
    description,
    quantity: Quantity.of(qty, "UN"),
    unitPrice: Money.ofCents(cents),
    total: Money.ofCents(qty * cents),
  });
  return Invoice.receive({
    accessKey: "35261194433432000143550010000894281178831290",
    number: "89428",
    series: "1",
    supplierId: "F03",
    store: "LJ-030",
    issuedOn: "2026-11-11",
    purchaseOrderRef: "OC-2026-42812",
    entryChannel: "SEFAZ",
    items: [
      line("F03-002", "SKU-1010", "Tomate italiano kg", 44, 850),
      line("F03-001", "SKU-1009", "Banana prata kg", 60, 690),
      line("F03-003", "SKU-1011", "Alface crespa unidade", 124, 340),
    ],
    total: Money.ofCents(120960),
  });
}

function nf012Entry(): DuplicateEntry {
  const invoice = nf012();
  invoice.check(emptyContext({ postedInvoices: [posted89410] }));
  return toDuplicateEntry(invoice, [posted89410], "bloqueado");
}

async function call(path: string, options: { token?: string; method?: string; reader?: DuplicatesReader } = {}) {
  const headers = new Headers();
  if (options.token !== undefined) headers.set("Cf-Access-Jwt-Assertion", options.token);
  const reader = options.reader;
  const worker = createWorker({ verifier: fakeVerifier, ...(reader ? { duplicates: () => reader } : {}) });
  return worker.fetch(new Request(`https://worker.test${path}`, { method: options.method ?? "GET", headers }), env, ctx);
}

describe("GET /api/duplicates", () => {
  it("#31/AC-7: sem token, recebe 401", async () => {
    const response = await call("/api/duplicates");
    expect(response.status).toBe(401);
  });

  it("#31/AC-6: com token, lista a duplicada, o original e o valor barrado (NF-012 do kit)", async () => {
    const reader: DuplicatesReader = { list: async () => [nf012Entry()] };
    const response = await call("/api/duplicates", { token: "bom", reader });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      duplicates: [
        {
          duplicate: {
            accessKey: "35261194433432000143550010000894281178831290",
            number: "89428",
            supplierId: "F03",
            issuedOn: "2026-11-11",
            totalCents: 120960,
            total: "R$ 1.209,60",
          },
          original: {
            accessKey: "35261194433432000143550010000894101464288543",
            number: "89410",
            status: "lançada",
          },
          reason: "titulo_lancado",
          blockedAmountCents: 120960,
          blockedAmount: "R$ 1.209,60",
          titleState: "bloqueado",
        },
      ],
      count: 1,
    });
  });

  it("#31/AC-6: sem credenciais do Supabase, o leitor padrão devolve a lista vazia", async () => {
    const response = await call("/api/duplicates", { token: "bom" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ duplicates: [], count: 0 });
  });

  it("#31/AC-6: ordem sem saldo não tem título original", () => {
    const invoice = nf012();
    invoice.check(
      emptyContext({
        purchaseOrders: [
          {
            id: "OC-2026-42812",
            supplierId: "F03",
            store: "LJ-030",
            issuedOn: "2026-10-30",
            status: "atendida",
            statusReason: "",
            items: [
              {
                sku: "SKU-1010",
                supplierCode: "F03-002",
                description: "Tomate italiano kg",
                quantity: Quantity.of(44, "UN"),
                unitPrice: Money.ofCents(850),
                balance: Quantity.of(0, "UN"),
              },
            ],
            total: Money.ofCents(120960),
          },
        ],
      }),
    );
    const entry = toDuplicateEntry(invoice, []);
    expect(entry.original).toBeNull();
    expect(entry.reason).toBe("ordem_sem_saldo");
    expect(entry.blockedAmount.cents).toBe(120960);
    expect(entry.titleState).toBeNull();
  });

  it("#31/AC-5 #31/AC-6: sem título gravado, titleState vai null no JSON", async () => {
    const invoice = nf012();
    invoice.check(emptyContext({ postedInvoices: [posted89410] }));
    const reader: DuplicatesReader = { list: async () => [toDuplicateEntry(invoice, [posted89410])] };
    const body = (await (await call("/api/duplicates", { token: "bom", reader })).json()) as {
      duplicates: { titleState: unknown }[];
    };
    expect(body.duplicates[0]?.titleState).toBeNull();
  });

  it("#31/AC-6: registro sem divergência E6 não vira entrada", () => {
    const record = { ...nf012(), divergences: [] };
    expect(() => toDuplicateEntry(record, [])).toThrow();
  });

  it("#31/AC-6: POST na rota recebe 405", async () => {
    const response = await call("/api/duplicates", { token: "bom", method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
  });

  it("#31/AC-6: /duplicates sem o prefixo /api não é a API; sem ASSETS, dá 404", async () => {
    const response = await call("/duplicates", { token: "bom", reader: { list: async () => [nf012Entry()] } });
    expect(response.status).toBe(404);
  });

  it("#31/AC-6: a rota antiga em português não existe mais", async () => {
    const response = await call("/duplicidades", { token: "bom" });
    expect(response.status).toBe(404);
  });
});
