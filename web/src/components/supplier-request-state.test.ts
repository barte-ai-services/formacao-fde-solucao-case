import { describe, expect, it } from "vitest";
import {
  applyCharges,
  asFulfilled,
  countByChip,
  INITIAL_STATE,
  screenReducer,
  visibleRows,
  type ScreenAction,
  type ScreenState,
} from "./supplier-request-state";
import type { SupplierRequestRow, SupplierRowStatus } from "./supplier-request-view";

// #157 O estado puro da lista "Pedidos ao fornecedor" (história #157): chips, contagens, ordem, gaveta e fluxo da cobrança. Dados fictícios.

function row(id: string, status: SupplierRowStatus, dueOn: string): SupplierRequestRow {
  const base = { id, invoiceNumber: id, supplier: "F07 Limpeza", request: "Nota de devolução", amountCents: 1000, dueOn };
  return status === "fulfilledToConfirm" ? { ...base, status, document: "ND 881" } : { ...base, status };
}

const ALL_STATUSES: SupplierRowStatus[] = ["waiting", "late", "fulfilledToConfirm", "fulfilledToAnswer", "fulfilledToFollowUp", "fulfilled", "partiallyFulfilled", "needsInformation", "refused"];
const rows = ALL_STATUSES.map((status, index) => row(`r-${status}`, status, `2026-11-${String(20 - index).padStart(2, "0")}`));

function run(actions: ScreenAction[], from: ScreenState = INITIAL_STATE): ScreenState {
  return actions.reduce(screenReducer, from);
}

describe("#157 chips, contagens e linhas", () => {
  it("#157: o estado começa no chip Aguardando, sem gaveta e sem cobrança feita (Q3)", () => {
    expect(INITIAL_STATE).toEqual({ filter: "waiting", drawer: null, charged: {}, sending: [], confirm: {} });
  });

  it("#157: a contagem de cada chip segue o mapa de situação para chip (Q2): precisam de você junta confirmar, responder, cobrar, parcial, informação e recusa (#157)", () => {
    expect(countByChip(rows)).toEqual({ waiting: 1, late: 1, fulfilled: 1, needsYou: 6 });
  });

  it("#157: cada solicitação cai em um só chip: a soma das contagens é o total", () => {
    const counts = countByChip(rows);
    expect(counts.waiting + counts.late + counts.fulfilled + counts.needsYou).toBe(rows.length);
  });

  it("#157: sem linhas, as quatro contagens são zero", () => {
    expect(countByChip([])).toEqual({ waiting: 0, late: 0, fulfilled: 0, needsYou: 0 });
  });

  it("#157: o chip filtra pelas situações dele, com atendeu a responder e a cobrar em Precisam de você (#157), e 'all' devolve todas, sempre por prazo crescente (Q8)", () => {
    expect(visibleRows(rows, "needsYou").map((r) => r.id)).toEqual([
      "r-refused",
      "r-needsInformation",
      "r-partiallyFulfilled",
      "r-fulfilledToFollowUp",
      "r-fulfilledToAnswer",
      "r-fulfilledToConfirm",
    ]);
    expect(visibleRows(rows, "all").map((r) => r.dueOn)).toEqual([...rows.map((r) => r.dueOn)].sort());
  });

  it("#157: prazos iguais mantêm a ordem recebida, e a lista de entrada não é alterada", () => {
    const input = [row("b", "late", "2026-11-14"), row("a", "late", "2026-11-14"), row("c", "late", "2026-11-12")];
    expect(visibleRows(input, "late").map((r) => r.id)).toEqual(["c", "b", "a"]);
    expect(input.map((r) => r.id)).toEqual(["b", "a", "c"]);
  });

  it("#157: escolher um chip e 'Ver todos' mudam só o filtro", () => {
    expect(run([{ type: "filter", filter: "late" }]).filter).toBe("late");
    expect(run([{ type: "filter", filter: "late" }, { type: "filter", filter: "all" }])).toEqual({ ...INITIAL_STATE, filter: "all" });
  });
});

describe("#157 gaveta", () => {
  it("#157: clicar na linha abre a gaveta daquele pedido, no bloco do pedido, sem rascunho", () => {
    expect(run([{ type: "openRow", id: "r-late" }]).drawer).toEqual({ requestId: "r-late", block: "supplierRequest", followUp: null });
  });

  it("#157: 'Cobrar' abre a gaveta no mesmo bloco com o rascunho para revisar, sem editar e sem enviar", () => {
    expect(run([{ type: "openFollowUp", id: "r-late" }]).drawer).toEqual({
      requestId: "r-late",
      block: "supplierRequest",
      followUp: { phase: { phase: "review" }, editing: false, body: null },
    });
  });

  it("#157: clicar de novo na linha aberta mantém o rascunho; clicar em outra troca o pedido e o descarta", () => {
    const open = run([{ type: "openFollowUp", id: "r-late" }, { type: "edit" }, { type: "changeBody", body: "novo" }]);
    expect(run([{ type: "openRow", id: "r-late" }], open)).toEqual(open);
    expect(run([{ type: "openRow", id: "other" }], open).drawer).toEqual({ requestId: "other", block: "supplierRequest", followUp: null });
  });

  it("#157: fechar a gaveta a deixa sem pedido", () => {
    expect(run([{ type: "openRow", id: "r-late" }, { type: "close" }]).drawer).toBeNull();
  });
});

describe("#157 fluxo da cobrança", () => {
  const review = run([{ type: "openFollowUp", id: "r-late" }]);

  it("#157: editar libera só o texto: troca o corpo e deixa a fase e o resto como estão", () => {
    const edited = run([{ type: "edit" }, { type: "changeBody", body: "Texto novo" }], review);
    expect(edited.drawer?.followUp).toEqual({ phase: { phase: "review" }, editing: true, body: "Texto novo" });
    expect(edited.charged).toEqual({});
    expect(edited.filter).toBe("waiting");
  });

  it("#157: o texto só muda depois de 'Editar'", () => {
    expect(run([{ type: "changeBody", body: "x" }], review)).toEqual(review);
  });

  it("#157: enviar vai de revisar a enviando, e um segundo envio durante o envio não muda nada", () => {
    const sending = run([{ type: "sendStarted", id: "r-late" }], review);
    expect(sending.drawer?.followUp?.phase).toEqual({ phase: "sending" });
    expect(run([{ type: "sendStarted", id: "r-late" }], sending)).toEqual(sending);
  });

  it("#157: enviando trava a edição e o descarte", () => {
    const sending = run([{ type: "sendStarted", id: "r-late" }], review);
    expect(run([{ type: "changeBody", body: "x" }, { type: "discard" }, { type: "edit" }], sending)).toEqual(sending);
  });

  it("#157: envio feito vai a enviado e a linha muda de situação com o novo prazo (estado 9 do wireframe)", () => {
    const sent = run([{ type: "sendStarted", id: "r-late" }, { type: "sendSucceeded", id: "r-late", dueOn: "2026-11-20", sentOn: "2026-11-15", sentTime: "10:12" }], review);
    expect(sent.drawer?.followUp?.phase).toEqual({ phase: "sent", sentOn: "2026-11-15", sentTime: "10:12" });
    expect(sent.charged).toEqual({ "r-late": { dueOn: "2026-11-20", sentOn: "2026-11-15", sentTime: "10:12" } });
  });

  it("#157: envio feito sem horário não inventa um", () => {
    const sent = run([{ type: "sendStarted", id: "r-late" }, { type: "sendSucceeded", id: "r-late", dueOn: "2026-11-20", sentOn: "2026-11-15" }], review);
    expect(sent.drawer?.followUp?.phase).toEqual({ phase: "sent", sentOn: "2026-11-15" });
  });

  it("#157: se a gaveta já tinha sido fechada, o envio que termina ainda marca a cobrança e não abre nada", () => {
    const sent = run([{ type: "sendStarted", id: "r-late" }, { type: "close" }, { type: "sendSucceeded", id: "r-late", dueOn: "2026-11-20", sentOn: "2026-11-15" }], review);
    expect(sent.drawer).toBeNull();
    expect(Object.keys(sent.charged)).toEqual(["r-late"]);
  });

  it("#157: envio falho guarda o motivo, mantém o rascunho e a situação, e tentar de novo volta a enviando", () => {
    const failed = run([{ type: "sendStarted", id: "r-late" }, { type: "sendFailed", id: "r-late", failure: "mailRefused" }], review);
    expect(failed.drawer?.followUp).toEqual({ phase: { phase: "failed", failure: "mailRefused" }, editing: false, body: null });
    expect(failed.charged).toEqual({});
    expect(run([{ type: "sendStarted", id: "r-late" }], failed).drawer?.followUp?.phase).toEqual({ phase: "sending" });
    // #157 Depois da falha a edição segue possível: o texto digitado fica e o envio espera salvar ou cancelar (#157).
    const edited = run([{ type: "edit" }, { type: "changeBody", body: "Texto" }], failed);
    expect(edited.drawer?.followUp).toEqual({ phase: { phase: "failed", failure: "mailRefused" }, editing: true, body: "Texto" });
  });

  it("#157: o resultado de um envio de outro pedido não mexe na fase do que está aberto", () => {
    const sending = run([{ type: "sendStarted", id: "r-late" }], review);
    expect(run([{ type: "sendFailed", id: "other", failure: "unknown" }], sending)).toEqual(sending);
  });

  it("#157: descartar fecha o rascunho e mantém a gaveta no bloco do pedido", () => {
    expect(run([{ type: "edit" }, { type: "discard" }], review).drawer).toEqual({ requestId: "r-late", block: "supplierRequest", followUp: null });
  });

  it("#157: 'Cobrar' de novo com o envio em curso não reinicia o rascunho", () => {
    const sending = run([{ type: "sendStarted", id: "r-late" }], review);
    expect(run([{ type: "openFollowUp", id: "r-late" }], sending)).toEqual(sending);
  });
});

describe("#157 cobrança em envio com a gaveta fechada", () => {
  it("#157: fechar a gaveta durante o envio não libera 'Cobrar': o mesmo id não abre outro rascunho até o envio falhar", () => {
    const closed = run([{ type: "openFollowUp", id: "r-late" }, { type: "sendStarted", id: "r-late" }, { type: "close" }]);
    expect(closed.sending).toEqual(["r-late"]);
    expect(run([{ type: "openFollowUp", id: "r-late" }], closed)).toEqual(closed);

    const failed = run([{ type: "sendFailed", id: "r-late", failure: "mailRefused" }], closed);
    expect(failed.sending).toEqual([]);
    expect(failed.drawer).toBeNull();
    expect(run([{ type: "openFollowUp", id: "r-late" }], failed).drawer?.followUp?.phase).toEqual({ phase: "review" });
  });

  it("#157: o envio que termina bem tira o id de 'em envio' e o move para cobrados, com a gaveta aberta ou não", () => {
    const sent = run([{ type: "openFollowUp", id: "r-late" }, { type: "sendStarted", id: "r-late" }, { type: "close" }, { type: "sendSucceeded", id: "r-late", dueOn: "2026-11-20", sentOn: "2026-11-15" }]);
    expect(sent.sending).toEqual([]);
    expect(Object.keys(sent.charged)).toEqual(["r-late"]);
  });
});

describe("#157 a linha depois da cobrança", () => {
  it("#157: um pedido já cobrado não abre o rascunho de novo na sessão", () => {
    const sent = run([{ type: "openFollowUp", id: "r-late" }, { type: "sendStarted", id: "r-late" }, { type: "sendSucceeded", id: "r-late", dueOn: "2026-11-20", sentOn: "2026-11-15" }]);
    const closed = run([{ type: "close" }], sent);
    expect(run([{ type: "openFollowUp", id: "r-late" }], closed)).toEqual(closed);
  });

  it("#157: a atrasada cobrada nesta sessão segue atrasada, com o prazo que veio, marcada como cobrada, e as contagens não mudam (#157)", () => {
    const input = [row("a", "late", "2026-11-12"), row("b", "late", "2026-11-14"), row("c", "waiting", "2026-11-20")];
    const after = applyCharges(input, { a: { dueOn: "2026-11-20", sentOn: "2026-11-15" } });
    expect(after[0]).toEqual({ ...input[0], alreadyCharged: true });
    expect(after[0]?.dueOn).toBe("2026-11-12");
    expect(countByChip(after)).toEqual(countByChip(input));
    expect(after[1]).toBe(input[1]);
    expect(after[2]).toBe(input[2]);
  });

  it("#157: sem cobrança feita a lista volta como veio", () => {
    expect(applyCharges(rows, {})).toBe(rows);
  });
});

describe("#157 cobranças que o servidor já fez", () => {
  const lateCharged: SupplierRequestRow = { ...row("r-late", "late", "2026-11-14"), alreadyCharged: true };

  it("#157: a linha que o servidor já cobrou fica no chip dele: sem cobrança da sessão, nem a linha nem as contagens mudam", () => {
    expect(applyCharges([lateCharged], {})).toEqual([lateCharged]);
    expect(applyCharges([lateCharged], {})[0]?.status).toBe("late");
    expect(visibleRows([lateCharged], "late")).toEqual([lateCharged]);
  });

  it("#157: a cobrança desta sessão de outra linha não mexe na que o servidor cobrou", () => {
    const other = row("r-other", "late", "2026-11-12");
    const session = { "r-other": { dueOn: "2026-11-19", sentOn: "2026-11-16" } };
    expect(applyCharges([lateCharged, other], session)[0]).toEqual(lateCharged);
    expect(applyCharges([lateCharged, other], session)[1]).toEqual({ ...other, alreadyCharged: true });
  });

  it("#157: o envio feito leva quem enviou à fase enviado", () => {
    const opened = run([{ type: "openRow", id: "r-late" }, { type: "openFollowUp", id: "r-late" }, { type: "sendStarted", id: "r-late" }]);
    const done = screenReducer(opened, { type: "sendSucceeded", id: "r-late", dueOn: "2026-11-19", sentOn: "2026-11-16", sentBy: "beto@example.test" });
    expect(done.drawer?.followUp?.phase).toEqual({ phase: "sent", sentOn: "2026-11-16", sentBy: "beto@example.test" });
  });
});

// #157 A edição do rascunho da cobrança: salvar pelo PATCH, cancelar, e o envio travado enquanto se edita.
describe("#157 edição do rascunho da cobrança", () => {
  const review = run([{ type: "openFollowUp", id: "r-late" }]);
  const editing = run([{ type: "edit" }, { type: "changeBody", body: "Texto com {{nota.numero}}" }], review);

  it("#157: enquanto se edita, o envio não começa: a fase continua revisar e nenhum id entra em envio", () => {
    const refused = run([{ type: "sendStarted", id: "r-late" }], editing);
    expect(refused).toEqual(editing);
    expect(refused.sending).toEqual([]);
  });

  it("#157: salvar vai a 'salvando' e um segundo salvar durante o salvamento não muda nada", () => {
    const saving = run([{ type: "saveStarted", id: "r-late" }], editing);
    expect(saving.drawer?.followUp).toMatchObject({ editing: true, saving: true, body: "Texto com {{nota.numero}}" });
    expect(run([{ type: "saveStarted", id: "r-late" }], saving)).toEqual(saving);
  });

  it("#157: salvar só começa em edição aberta", () => {
    expect(run([{ type: "saveStarted", id: "r-late" }], review)).toEqual(review);
  });

  it("#157: salvo, a edição fecha e o texto editado deixa de valer: o do servidor volta a ser o rascunho", () => {
    const saved = run([{ type: "saveStarted", id: "r-late" }, { type: "saveSucceeded", id: "r-late" }], editing);
    expect(saved.drawer?.followUp).toEqual({ phase: { phase: "review" }, editing: false, body: null });
  });

  it("#157: o 422 mantém a edição aberta, com o texto digitado e o motivo fechado", () => {
    const failed = run([{ type: "saveStarted", id: "r-late" }, { type: "saveFailed", id: "r-late", failure: "invalid" }], editing);
    expect(failed.drawer?.followUp).toMatchObject({ editing: true, body: "Texto com {{nota.numero}}", saveFailure: "invalid" });
    expect(failed.drawer?.followUp?.saving).toBeFalsy();
  });

  it("#157: salvar de novo limpa o motivo da falha anterior", () => {
    const failed = run([{ type: "saveStarted", id: "r-late" }, { type: "saveFailed", id: "r-late", failure: "invalid" }], editing);
    expect(run([{ type: "saveStarted", id: "r-late" }], failed).drawer?.followUp?.saveFailure).toBeUndefined();
  });

  it("#157: cancelar fecha a edição e joga fora o texto digitado, sem salvar; durante o salvamento não cancela", () => {
    expect(run([{ type: "cancelEdit" }], editing).drawer?.followUp).toEqual({ phase: { phase: "review" }, editing: false, body: null });
    const saving = run([{ type: "saveStarted", id: "r-late" }], editing);
    expect(run([{ type: "cancelEdit" }], saving)).toEqual(saving);
  });
});

describe("#157 a confirmação do documento citado", () => {
  const start = (id: string) => ({ type: "confirmStarted", id }) as const;

  it("#157: confirmar começa parado em 'confirmando' e um segundo clique não muda nada (o POST não se repete)", () => {
    const once = run([start("a")]);
    expect(once.confirm).toEqual({ a: { phase: "confirming" } });
    expect(screenReducer(once, start("a"))).toBe(once);
  });

  it("#157: confirmado, o estado guarda 'confirmado' e já não aceita outra confirmação", () => {
    const done = run([start("a"), { type: "confirmSucceeded", id: "a" }]);
    expect(done.confirm).toEqual({ a: { phase: "confirmed" } });
    expect(screenReducer(done, start("a"))).toBe(done);
  });

  it("#157: o erro guarda só o motivo fechado e libera o botão para tentar de novo, apagando o motivo anterior", () => {
    const failed = run([start("a"), { type: "confirmFailed", id: "a", failure: "unavailable" }]);
    expect(failed.confirm).toEqual({ a: { phase: "failed", failure: "unavailable" } });
    expect(run([start("a")], failed).confirm).toEqual({ a: { phase: "confirming" } });
  });

  it("#157: o resultado só vale para quem estava confirmando; um resultado solto não inventa estado", () => {
    expect(run([{ type: "confirmSucceeded", id: "a" }]).confirm).toEqual({});
    expect(run([{ type: "confirmFailed", id: "a", failure: "unknown" }]).confirm).toEqual({});
  });

  it("#157: a confirmação de um pedido não toca a de outro, nem a gaveta, nem a cobrança", () => {
    const state = run([{ type: "openRow", id: "a" }, start("a"), start("b"), { type: "confirmFailed", id: "b", failure: "conflict" }]);
    expect(state.confirm).toEqual({ a: { phase: "confirming" }, b: { phase: "failed", failure: "conflict" } });
    expect(state.drawer?.requestId).toBe("a");
    expect(state.charged).toEqual({});
  });

  it("#157: fechar a gaveta com a confirmação em curso não a cancela: o resultado ainda chega ao estado", () => {
    const state = run([{ type: "openRow", id: "a" }, start("a"), { type: "close" }, { type: "confirmSucceeded", id: "a" }]);
    expect(state.confirm).toEqual({ a: { phase: "confirmed" } });
  });

  it("#157: a linha confirmada vale como 'Atendeu': sai de 'Precisam de você' e conta em 'Atendidos', sem o documento a confirmar", () => {
    const confirmed = asFulfilled(row("a", "fulfilledToConfirm", "2026-11-10"));
    expect(confirmed).toEqual({ id: "a", invoiceNumber: "a", supplier: "F07 Limpeza", request: "Nota de devolução", amountCents: 1000, dueOn: "2026-11-10", status: "fulfilled" });
    expect(countByChip([confirmed])).toEqual({ waiting: 0, fulfilled: 1, needsYou: 0, late: 0 });
  });
});
