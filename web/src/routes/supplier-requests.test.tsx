import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import type { ReadingListDto, ReadingRowDto, ReplyFilterDto, SentRequestDetailDto } from "../api/contract";
import { ConfirmRereadFailed, type SupplierReplyApi } from "../api/supplier-reply";
import { FILTER_OF_CHIP } from "../components/supplier-request-map";
import { confirmOf, loadList, saveOf, sendOf } from "./supplier-requests";

// #21 A rota "Pedidos ao fornecedor" lê a lista do servidor: o filtro, as quatro contagens e a chave de cada linha; o envio exige a chave. Dados fictícios.

const key = (n: number): string => `${String(n).repeat(43)}7`;

const row = (id: number, over: Partial<ReadingRowDto> = {}): ReadingRowDto => ({
  id,
  invoiceAccessKey: key(id),
  invoiceNumber: `N${id}`,
  supplierId: "F07",
  supplierName: "Limpeza",
  requestType: "return_note",
  totalCents: 1000,
  dueOn: "2026-11-14",
  status: "sent",
  reading: null,
  followUp: { drafted: false, sent: false },
  ...over,
});

const COUNTS: Record<ReplyFilterDto, number> = { awaiting: 2, answered: 1, needs_you: 1, overdue: 3 };
const ZERO: Record<ReplyFilterDto, number> = { awaiting: 0, answered: 0, needs_you: 0, overdue: 0 };

const listOf = (filter: ReplyFilterDto, requests: ReadingRowDto[], counts: Record<ReplyFilterDto, number>): ReadingListDto => ({ filter, requests, counts });

/** #21 Um servidor que devolve uma linha por filtro; as contagens do primeiro pedido são as certas, as dos outros são de propósito zero. */
function server() {
  const rows: Record<ReplyFilterDto, ReadingRowDto[]> = { awaiting: [row(1)], answered: [row(2)], needs_you: [row(3)], overdue: [row(4)] };
  let asked = 0;
  return vi.fn(async (filter: ReplyFilterDto) => {
    asked += 1;
    return listOf(filter, rows[filter], asked === 1 ? COUNTS : ZERO);
  });
}

describe("#21 rota Pedidos ao fornecedor: a carga da lista", () => {
  it("#5/AC-2: 'Ver todos' faz quatro GETs, tira as contagens do primeiro e junta as linhas pela chave de acesso", async () => {
    const list = server();
    const loaded = await loadList("all", new AbortController().signal, { list });
    expect(list).toHaveBeenCalledTimes(4);
    expect(list.mock.calls.map(([filter]) => filter).sort()).toEqual(["answered", "awaiting", "needs_you", "overdue"]);
    expect(loaded.counts).toEqual({ waiting: 2, fulfilled: 1, needsYou: 1, late: 3 });
    expect(loaded.rows.map((r) => r.id).sort()).toEqual(["1", "2", "3", "4"]);
    expect(loaded.accessKeys).toEqual({ "1": key(1), "2": key(2), "3": key(3), "4": key(4) });
    expect(loaded.empty).toBe(false);
  });

  it("#5/AC-2: um chip pede só o filtro dele ao servidor", async () => {
    const list = server();
    const loaded = await loadList("late", new AbortController().signal, { list });
    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0]?.[0]).toBe(FILTER_OF_CHIP.late);
    expect(loaded.rows.map((r) => r.id)).toEqual(["4"]);
    expect(loaded.rows[0]?.status).toBe("late");
  });

  it("#5/AC-2: sem pedido enviado em nenhum filtro, a carga vem vazia", async () => {
    const list = vi.fn(async (filter: ReplyFilterDto) => listOf(filter, [], ZERO));
    expect((await loadList("waiting", new AbortController().signal, { list })).empty).toBe(true);
  });
});

describe("#21 rota Pedidos ao fornecedor: o envio da cobrança", () => {
  it("#5/AC-4: enviar sem a chave de acesso da linha lança, e nada é enviado", async () => {
    const sendFollowUp = vi.fn<SupplierReplyApi["sendFollowUp"]>();
    await expect(sendOf(null, { sendFollowUp })).rejects.toThrow("linha sem chave de acesso");
    expect(sendFollowUp).not.toHaveBeenCalled();
  });

  it("#5/AC-4: com a chave, envia por ela e devolve o pedido como o servidor o deixou", async () => {
    const detail = { followUp: { sent: false } } as SentRequestDetailDto;
    const sendFollowUp = vi.fn<SupplierReplyApi["sendFollowUp"]>(async () => detail);
    await expect(sendOf(key(1), { sendFollowUp })).resolves.toBe(detail);
    expect(sendFollowUp).toHaveBeenCalledWith(key(1));
  });
});

// #59 O salvamento da edição pela rota: a chave da linha, o resultado fechado e o pedido relido que vai à gaveta.
describe("#59 rota Pedidos ao fornecedor: salvar a edição da cobrança", () => {
  const detail = { followUp: { sent: false } } as SentRequestDetailDto;

  it("#59/AC-2: sem a chave de acesso da linha, nada é salvo e o resultado é a falha fechada 'unknown'", async () => {
    const saveFollowUp = vi.fn<SupplierReplyApi["saveFollowUp"]>();
    await expect(saveOf(null, "x", { saveFollowUp })).resolves.toEqual({ result: { ok: false, failure: "unknown" }, reread: null });
    expect(saveFollowUp).not.toHaveBeenCalled();
  });

  it("#59/AC-2: salvo, o resultado é 'ok' e o pedido que o servidor devolveu vai à gaveta", async () => {
    const saveFollowUp = vi.fn<SupplierReplyApi["saveFollowUp"]>(async () => ({ kind: "saved", detail }));
    await expect(saveOf(key(1), "Texto {{cobranca.prazo}}", { saveFollowUp })).resolves.toEqual({ result: { ok: true }, reread: detail });
    expect(saveFollowUp).toHaveBeenCalledWith(key(1), "Texto {{cobranca.prazo}}");
  });

  it("#59/AC-2: o 422 vira a falha 'invalid' sem pedido relido (o texto anterior fica no servidor)", async () => {
    const saveFollowUp = vi.fn<SupplierReplyApi["saveFollowUp"]>(async () => {
      throw new ApiError(422, "invalid", "number_mismatch com dados do banco");
    });
    const outcome = await saveOf(key(1), "263,62", { saveFollowUp });
    expect(outcome).toEqual({ result: { ok: false, failure: "invalid" }, reread: null });
    expect(JSON.stringify(outcome)).not.toContain("banco");
  });

  it("#59: o conflito (409) devolve a falha 'conflict' com o pedido relido, para a gaveta mostrar o estado atual", async () => {
    const saveFollowUp = vi.fn<SupplierReplyApi["saveFollowUp"]>(async () => ({ kind: "conflict", detail }));
    await expect(saveOf(key(1), "x", { saveFollowUp })).resolves.toEqual({ result: { ok: false, failure: "conflict" }, reread: detail });
  });
});

describe("#64 rota Pedidos ao fornecedor: confirmar o documento citado", () => {
  const confirmation = { document: "NF-D 881", by: "ana@example.test", at: "2026-11-17T13:05:00.000Z" };
  const confirmed = { documentConfirmation: confirmation } as SentRequestDetailDto;
  const pending = { documentConfirmation: null } as SentRequestDetailDto;

  it("#64/AC-2: sem chave de acesso não há o que confirmar: o motivo fechado é 'unknown' e nada é chamado", async () => {
    const confirmDocument = vi.fn<SupplierReplyApi["confirmDocument"]>();
    await expect(confirmOf(null, { confirmDocument })).resolves.toEqual({ result: { ok: false, failure: "unknown" }, reread: null });
    expect(confirmDocument).not.toHaveBeenCalled();
  });

  it("#64/AC-3: confirmado, o resultado é ok e o pedido que o servidor devolveu (com quem e quando) é o que a gaveta passa a mostrar", async () => {
    const confirmDocument = vi.fn<SupplierReplyApi["confirmDocument"]>(async () => ({ kind: "confirmed", detail: confirmed }));
    await expect(confirmOf(key(1), { confirmDocument })).resolves.toEqual({ result: { ok: true }, reread: confirmed });
    expect(confirmDocument).toHaveBeenCalledWith(key(1));
  });

  it("#64/AC-3: um 409 em que o servidor já tem a confirmação (já confirmado) vale como confirmado: a primeira confirmação é a que aparece", async () => {
    const confirmDocument = vi.fn<SupplierReplyApi["confirmDocument"]>(async () => ({ kind: "conflict", detail: confirmed }));
    await expect(confirmOf(key(1), { confirmDocument })).resolves.toEqual({ result: { ok: true }, reread: confirmed });
  });

  it("#64/AC-2: um 409 em que o pedido ainda não consta confirmado (mudou) falha como 'conflict' e traz o pedido relido, para a tela mostrar o estado atual", async () => {
    const confirmDocument = vi.fn<SupplierReplyApi["confirmDocument"]>(async () => ({ kind: "conflict", detail: pending }));
    await expect(confirmOf(key(1), { confirmDocument })).resolves.toEqual({ result: { ok: false, failure: "conflict" }, reread: pending });
  });

  it.each([
    [403, "unauthorized"],
    [404, "not_found"],
    [502, "unavailable"],
    [0, "unavailable"],
    [500, "unknown"],
  ] as const)("#64/AC-2: o status %i vira o motivo fechado '%s', sem o texto da API", async (status, failure) => {
    const confirmDocument = vi.fn<SupplierReplyApi["confirmDocument"]>(async () => {
      throw new ApiError(status, "x", "texto cru da dependência");
    });
    const outcome = await confirmOf(key(1), { confirmDocument });
    expect(outcome).toEqual({ result: { ok: false, failure }, reread: null });
    expect(JSON.stringify(outcome)).not.toContain("texto cru");
  });

  it("#64/AC-2: um erro que não é da API (rede, código) também vira 'unknown'", async () => {
    const confirmDocument = vi.fn<SupplierReplyApi["confirmDocument"]>(async () => {
      throw new TypeError("texto cru");
    });
    await expect(confirmOf(key(1), { confirmDocument })).resolves.toEqual({ result: { ok: false, failure: "unknown" }, reread: null });
  });

  it("#64: um 409 já confirmado cuja releitura falhou vira 'alreadyConfirmed': o servidor disse que já está confirmado", async () => {
    const confirmDocument = vi.fn<SupplierReplyApi["confirmDocument"]>(async () => {
      throw new ConfirmRereadFailed("already_confirmed");
    });
    await expect(confirmOf(key(1), { confirmDocument })).resolves.toEqual({ result: { ok: false, failure: "alreadyConfirmed" }, reread: null });
  });

  it("#64: um 409 de outro motivo cuja releitura falhou vira 'conflictUnread': a tela não afirma o resultado", async () => {
    const confirmDocument = vi.fn<SupplierReplyApi["confirmDocument"]>(async () => {
      throw new ConfirmRereadFailed("other");
    });
    await expect(confirmOf(key(1), { confirmDocument })).resolves.toEqual({ result: { ok: false, failure: "conflictUnread" }, reread: null });
  });
});
