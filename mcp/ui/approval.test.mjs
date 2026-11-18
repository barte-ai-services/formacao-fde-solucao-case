// A tela do MCP App da fila (#274), exercitada como o Claude a exercitaria: um host falso fala por postMessage.
// Cada teste leva o critério da #274 que cobre.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  ITEM_BLOCKED, ITEM_E3, KEY, OTHER_KEY, SESSION_EXPIRED, decisionOutput, fail, ok, proposalOutput, queueItem,
  queueOutput,
} from "./fixtures.mjs";
import { openScreen } from "./host.mjs";

const DEADLINE_MS = 200;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const GENERIC = "Não foi possível concluir agora. Tente de novo em instantes.";

let screen = null;
afterEach(() => screen?.close());

/** Abre a tela com as rotas dadas e a fila pedida pelo Claude. (#274) */
async function openQueue(routes = {}, view = { view: "queue", invoice_access_key: null }) {
  screen = openScreen({ list_approval_queue: () => ok(queueOutput()), ...routes });
  await screen.openApp(view);
  return screen;
}

/** Abre a proposta de `KEY` pela fila, clicando na linha. (#274) */
async function openProposal(proposal = proposalOutput(), routes = {}) {
  await openQueue({ get_proposal: () => ok(proposal), ...routes });
  await screen.click(screen.$(`tr[data-key="${KEY}"]`));
  return screen;
}

const headers = () => screen.$$("table[data-table=queue] th").map((th) => screen.text(th));
const cells = (row) => screen.$$("td", row).map((td) => screen.text(td));

describe("respostas atrasadas (#274)", () => {
  const later = () => {
    let release = () => {};
    const promise = new Promise((resolve) => { release = resolve; });
    return { promise, release };
  };

  test("voltar à Fila antes de get_proposal responder não deixa a proposta cobrir a fila", async () => {
    const slow = later();
    await openQueue({ get_proposal: () => slow.promise });
    await screen.click(screen.$(`tr[data-key="${KEY}"]`));
    await screen.click(screen.$("button[data-action=back]"));
    slow.release(ok(proposalOutput()));
    await screen.flush();
    assert.notEqual(screen.$("[data-screen=queue]"), null);
    assert.equal(screen.$("[data-screen=proposal]"), null);
  });

  test("um tool-result que chega com a proposta carregando vence a resposta antiga", async () => {
    const slow = later();
    await openQueue({ get_proposal: () => slow.promise });
    await screen.click(screen.$(`tr[data-key="${KEY}"]`));
    await screen.openApp({ view: "queue", invoice_access_key: null });
    slow.release(ok(proposalOutput()));
    await screen.flush();
    assert.notEqual(screen.$("[data-screen=queue]"), null);
    assert.equal(screen.$("[data-screen=proposal]"), null);
  });
});

describe("o protocolo do MCP App", () => {
  test("AC-1: inicia com ui/initialize, avisa que iniciou e só chama tool depois do resultado de open_approval_app", async () => {
    screen = openScreen({ list_approval_queue: () => ok(queueOutput()) });
    await screen.flush();
    const [first, second] = screen.sent;
    assert.equal(first.method, "ui/initialize");
    assert.equal(first.params.appInfo.name.length > 0, true);
    assert.equal(second.method, "ui/notifications/initialized");
    assert.deepEqual(screen.calls, []);
    await screen.openApp();
    assert.deepEqual(screen.callsOf("list_approval_queue"), [{ scope: "mine" }]);
  });

  test("AC-1: ignora mensagem que não vem do host (a janela de cima)", async () => {
    screen = openScreen({ list_approval_queue: () => ok(queueOutput()) });
    await screen.flush();
    screen.deliver(
      { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { view: "queue", invoice_access_key: null } } },
      null,
    );
    await screen.flush();
    assert.deepEqual(screen.calls, []);
  });

  test("AC-1: responde ao teardown do host", async () => {
    screen = await openQueue();
    screen.deliver({ jsonrpc: "2.0", id: 99, method: "ui/resource-teardown", params: { reason: "fim" } });
    await screen.flush();
    assert.deepEqual(screen.sent.find((m) => m.id === 99), { jsonrpc: "2.0", id: 99, result: {} });
  });

  test("AC-1: a visão proposal abre direto a proposta da chave, sem passar pela fila", async () => {
    screen = openScreen({ get_proposal: () => ok(proposalOutput()) });
    await screen.openApp({ view: "proposal", invoice_access_key: KEY });
    assert.deepEqual(screen.callsOf("get_proposal"), [{ invoice_access_key: KEY }]);
    assert.deepEqual(screen.callsOf("list_approval_queue"), []);
    assert.match(screen.text(), /Nota 43894/);
  });

  test("AC-4: a visão report diz que o relatório do motor chega na #138 e não chama tool", async () => {
    screen = openScreen({});
    await screen.openApp({ view: "report", invoice_access_key: null });
    assert.match(screen.text(), /relatório do motor chega na #138/);
    assert.deepEqual(screen.calls, []);
  });

  test("AC-4: o resultado de open_approval_app com erro mostra a mensagem da tool", async () => {
    screen = openScreen({});
    await screen.flush();
    screen.deliver({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: { isError: true, structuredContent: { error: "invalid_input", message: "view deve ser queue, proposal ou report." } },
    });
    await screen.flush();
    assert.match(screen.text(), /view deve ser queue, proposal ou report\./);
  });
});

describe("1. Fila", () => {
  test("AC-4: carregando mostra o esqueleto de 3 linhas cinza, sem spinner", async () => {
    let release;
    const pending = new Promise((resolve) => (release = resolve));
    screen = openScreen({ list_approval_queue: () => pending });
    await screen.openApp();
    assert.equal(screen.$$("[data-skeleton] .skeleton-row").length, 3);
    assert.equal(screen.$("[data-skeleton]").getAttribute("aria-busy"), "true");
    assert.equal(screen.$("[role=progressbar], .spinner, [class*=spin]"), null);
    assert.doesNotMatch(screen.window.document.querySelector("style").textContent, /@keyframes|animation/);
    release(ok(queueOutput()));
    await screen.flush();
    assert.equal(screen.$("[data-skeleton]"), null);
  });

  test("AC-2: título, quem está logado e o nível, a contagem e o valor em risco vêm da tool", async () => {
    await openQueue();
    assert.equal(screen.text(screen.$("h1")), "Fila de aprovação");
    assert.equal(screen.text(screen.$("[data-field=approver]")), "ana@exemplo.com · Analista");
    assert.equal(screen.text(screen.$("[data-field=summary]")), "12 propostas esperando você · R$ 84.310,20 em risco");
  });

  test("AC-2: o singular e o zero também vêm da contagem da tool", async () => {
    await openQueue({
      list_approval_queue: () => ok(queueOutput([], { waiting_for_you: { count: 1, amount_at_risk: { cents: 5, text: "R$ 0,05" } } })),
    });
    assert.equal(screen.text(screen.$("[data-field=summary]")), "1 proposta esperando você · R$ 0,05 em risco");
  });

  test("AC-2: Minhas está marcada, Todas e os filtros de exceção e de nível existem, e as colunas são as do wireframe", async () => {
    await openQueue();
    assert.equal(screen.$("button[data-scope=mine]").getAttribute("aria-pressed"), "true");
    assert.equal(screen.$("button[data-scope=all]").getAttribute("aria-pressed"), "false");
    assert.equal(screen.text(screen.$("button[data-scope=mine]")), "Minhas");
    assert.equal(screen.text(screen.$("button[data-scope=all]")), "Todas");
    const classification = screen.$$("select[data-filter=classification] option").map((o) => o.value);
    assert.deepEqual(classification, ["", "E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "NAO_CATALOGADA"]);
    assert.equal(screen.text(screen.$("select[data-filter=classification] option:checked")), "Todas");
    assert.match(screen.text(screen.$("select[data-filter=classification] option[value=E4]")), /^E4 Unidade de medida$/);
    const level = screen.$$("select[data-filter=level] option").map((o) => o.value);
    assert.deepEqual(level, ["", "analista", "coordenacao", "diretoria", "bloqueio"]);
    assert.equal(screen.text(screen.$("select[data-filter=level] option:checked")), "Todos");
    assert.deepEqual(headers(), ["Nota", "Fornecedor", "Exceção", "Em risco", "Ação", "Motor"]);
  });

  test("AC-2: cada linha traz a nota, o fornecedor, a exceção, o valor da tool, a ação e o motor", async () => {
    await openQueue();
    assert.deepEqual(cells(screen.$(`tr[data-key="${KEY}"]`)), ["43894", "F02", "E4 Unidade de medida", "R$ 1.418,56", "Receber", "—"]);
    assert.deepEqual(cells(screen.$(`tr[data-key="${OTHER_KEY}"]`)), [
      "59738", "F07", "E3 Quantidade menor", "R$ 263,62", "Receber parcial", "✓ 0,94",
    ]);
  });

  test("AC-2: a coluna Motor mostra ✕ quando o motor recusaria e — sem avaliação", async () => {
    const refusing = queueItem({ engine: { outcome: "refuse", confidence: 0.81, mode: "shadow" } });
    await openQueue({ list_approval_queue: () => ok(queueOutput([refusing])) });
    assert.equal(cells(screen.$(`tr[data-key="${KEY}"]`))[5], "✕ 0,81");
  });

  test("AC-2: Todas pede scope all à tool, e a linha sem can_decide fica em cinza com o nível na coluna Ação", async () => {
    await openQueue({ list_approval_queue: (args) => ok(queueOutput(args.scope === "all" ? [queueItem(), ITEM_BLOCKED] : [queueItem()])) });
    assert.equal(screen.$(`tr[data-key="${THIRD()}"]`), null);
    await screen.click(screen.$("button[data-scope=all]"));
    assert.deepEqual(screen.callsOf("list_approval_queue").at(-1), { scope: "all" });
    assert.equal(screen.$("button[data-scope=all]").getAttribute("aria-pressed"), "true");
    const blocked = screen.$(`tr[data-key="${THIRD()}"]`);
    assert.equal(blocked.classList.contains("row-blocked"), true);
    assert.equal(cells(blocked)[4], "Coordenação");
    assert.equal(screen.$(`tr[data-key="${KEY}"]`).classList.contains("row-blocked"), false);
  });

  test("AC-2: os filtros de exceção e de nível vão como lista para a tool, junto com o escopo", async () => {
    await openQueue();
    await screen.choose(screen.$("select[data-filter=classification]"), "E4");
    assert.deepEqual(screen.callsOf("list_approval_queue").at(-1), { scope: "mine", classification: ["E4"] });
    await screen.choose(screen.$("select[data-filter=level]"), "diretoria");
    assert.deepEqual(screen.callsOf("list_approval_queue").at(-1), { scope: "mine", classification: ["E4"], level: ["diretoria"] });
    await screen.click(screen.$("button[data-scope=all]"));
    assert.deepEqual(screen.callsOf("list_approval_queue").at(-1), { scope: "all", classification: ["E4"], level: ["diretoria"] });
    await screen.choose(screen.$("select[data-filter=classification]"), "");
    assert.deepEqual(screen.callsOf("list_approval_queue").at(-1), { scope: "all", level: ["diretoria"] });
  });

  test("AC-2: Delegar ao motor está desabilitado e diz que chega na #138", async () => {
    await openQueue();
    const button = screen.$("button[data-action=delegate]");
    assert.equal(button.disabled, true);
    assert.match(screen.text(button), /Delegar ao motor/);
    assert.match(screen.text(screen.$("[data-field=delegate-note]")), /Na #138/);
    await screen.click(button);
    assert.deepEqual(screen.calls.map((c) => c.name), ["list_approval_queue"]);
  });

  test("AC-4: fila vazia diz o que fazer e Ver todas abre as de todos", async () => {
    await openQueue({ list_approval_queue: (args) => ok(queueOutput(args.scope === "all" ? [ITEM_BLOCKED] : [])) });
    assert.equal(
      screen.text(screen.$("[data-state=empty]")),
      "Nada esperando você. As próximas notas chegam com a captura das 10h. Ver todas",
    );
    assert.equal(screen.$("table[data-table=queue] tbody tr"), null);
    await screen.click(screen.$("[data-state=empty] button"));
    assert.deepEqual(screen.callsOf("list_approval_queue").at(-1), { scope: "all" });
    assert.equal(screen.$("[data-state=empty]"), null);
    assert.equal(screen.$$("table[data-table=queue] tbody tr").length, 1);
  });

  test("AC-4: fila vazia com filtro diz que nenhuma proposta tem esses filtros", async () => {
    await openQueue({ list_approval_queue: (args) => ok(queueOutput(args.classification ? [] : [queueItem()])) });
    await screen.choose(screen.$("select[data-filter=classification]"), "E7");
    assert.match(screen.text(screen.$("[data-state=empty]")), /Nenhuma proposta com esses filtros\./);
  });

  test("AC-4: sem nível para decidir a fila diz isso no lugar do nível", async () => {
    await openQueue({ list_approval_queue: () => ok(queueOutput([ITEM_BLOCKED], { approver: { email: "bia@exemplo.com", level: null } })) });
    assert.equal(screen.text(screen.$("[data-field=approver]")), "bia@exemplo.com · Sem nível para decidir");
  });

  test("AC-4: sessão do Access expirada mostra o aviso e o botão Entrar, que tenta de novo", async () => {
    let expired = true;
    await openQueue({ list_approval_queue: () => (expired ? fail("session_expired", SESSION_EXPIRED) : ok(queueOutput())) });
    assert.equal(screen.text(screen.$("[data-state=session-expired]")), `${SESSION_EXPIRED} Entrar`);
    assert.equal(screen.$("table[data-table=queue]"), null);
    expired = false;
    await screen.click(screen.$("[data-action=sign-in]"));
    assert.equal(screen.$("[data-state=session-expired]"), null);
    assert.equal(screen.callsOf("list_approval_queue").length, 2);
    assert.match(screen.text(screen.$("[data-field=summary]")), /12 propostas/);
  });

  test("AC-4: falha da tool mostra a mensagem dela e um Tentar de novo, sem o identificador de correlação", async () => {
    let failing = true;
    await openQueue({
      list_approval_queue: () =>
        failing ? fail("unavailable", "Não foi possível concluir agora. Tente de novo em instantes.", { correlation_id: "abc123def456" }) : ok(queueOutput()),
    });
    assert.match(screen.text(screen.$("[data-state=error]")), /Não foi possível concluir agora\. Tente de novo em instantes\./);
    assert.doesNotMatch(screen.text(), /abc123def456/);
    failing = false;
    await screen.click(screen.$("[data-state=error] button"));
    assert.equal(screen.$("[data-state=error]"), null);
  });

  test("AC-4: erro de transporte do host cai na mensagem genérica, sem o texto do erro", async () => {
    await openQueue({ list_approval_queue: () => { throw new Error("segredo-do-host"); } });
    assert.match(screen.text(screen.$("[data-state=error]")), /Não foi possível concluir agora\. Tente de novo em instantes\./);
    assert.doesNotMatch(screen.text(), /segredo-do-host|-32603|falha do host/);
  });
});

const THIRD = () => ITEM_BLOCKED.invoice_access_key;

describe("2. Proposta", () => {
  test("AC-3: clicar na linha chama get_proposal com a chave e mostra o esqueleto enquanto espera", async () => {
    let release;
    const pending = new Promise((resolve) => (release = resolve));
    await openQueue({ get_proposal: () => pending });
    await screen.click(screen.$(`tr[data-key="${KEY}"]`));
    assert.deepEqual(screen.callsOf("get_proposal"), [{ invoice_access_key: KEY }]);
    assert.equal(screen.$$("[data-skeleton] .skeleton-row").length, 3);
    release(ok(proposalOutput()));
    await screen.flush();
    assert.equal(screen.$("[data-skeleton]"), null);
  });

  test("AC-3: o teclado abre a linha (Enter), porque a linha é focável", async () => {
    await openQueue({ get_proposal: () => ok(proposalOutput()) });
    const row = screen.$(`tr[data-key="${KEY}"]`);
    assert.equal(row.getAttribute("tabindex"), "0");
    row.dispatchEvent(new screen.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await screen.flush();
    assert.deepEqual(screen.callsOf("get_proposal"), [{ invoice_access_key: KEY }]);
  });

  test("AC-3: o cabeçalho traz ← Fila, a nota, o fornecedor, a loja, a exceção e o nível", async () => {
    await openProposal();
    const header = screen.$("[data-block=header]");
    assert.equal(screen.text(screen.$("button[data-action=back]", header)), "← Fila");
    assert.equal(screen.text(screen.$("[data-field=title]", header)), "Nota 43894 · F02 · LJ-012");
    assert.deepEqual(screen.$$("[data-badge]", header).map((b) => screen.text(b)), ["E4", "Analista"]);
  });

  test("AC-3: ação proposta, valores, por que este nível e a chave de acesso agrupada", async () => {
    await openProposal();
    assert.equal(screen.text(screen.$("[data-field=dock-action]")), "Receber");
    assert.equal(screen.text(screen.$("[data-field=amount-at-risk]")), "R$ 1.418,56");
    assert.equal(screen.text(screen.$("[data-field=invoice-total]")), "R$ 1.418,56");
    assert.equal(screen.text(screen.$("[data-field=reason]")), "Linha 5 da régua: E1 a E4 em nota de até R$ 20 mil");
    assert.equal(screen.text(screen.$("[data-field=access-key]")), "3526 1174 0554 8900 0148 5500 1000 0438 9411 7451 2643");
    const labels = screen.$$("[data-block=summary] dt").map((dt) => screen.text(dt));
    assert.deepEqual(labels, ["Ação na doca proposta", "Valor em risco", "Valor da nota", "Por que este nível", "Chave de acesso"]);
  });

  test("AC-3: a evidência por divergência traz a exceção, os SKUs e o que a evidência diz", async () => {
    await openProposal();
    const block = screen.$("[data-block=evidence]");
    assert.equal(screen.text(screen.$("h2", block)), "Evidência por divergência");
    assert.equal(screen.text(block).includes("E4 Unidade de medida"), true);
    assert.equal(screen.text(block).includes("SKU-1006"), true);
    assert.equal(screen.text(block).includes("Ordem: 6 CX · Nota: 72 UN · fator de caixa 12 → bate"), true);
  });

  test("AC-3: o motor mostra o veredito, a confiança, a versão, o porquê e os casos parecidos", async () => {
    await openProposal();
    const block = screen.$("[data-block=engine]");
    assert.equal(screen.text(screen.$("h2", block)), "Motor de decisão");
    assert.equal(screen.text(screen.$("[data-field=engine-verdict]", block)), "Aprovaria · confiança 0,99 · clef-v1");
    assert.equal(screen.text(screen.$("[data-field=engine-reason]", block)), "“A conversão pelo fator de caixa do cadastro fecha a conta.”");
    assert.equal(screen.text(screen.$("[data-field=engine-similar]", block)), "Casos parecidos: 3");
  });

  test("AC-3: o motor que recusaria diz Recusaria", async () => {
    const engine = { ...proposalOutput().engine, outcome: "refuse", confidence: 0.71 };
    await openProposal(proposalOutput({ engine }));
    assert.equal(screen.text(screen.$("[data-field=engine-verdict]")), "Recusaria · confiança 0,71 · clef-v1");
  });

  test("AC-3: o agente auditor que concorda diz com o quê", async () => {
    await openProposal();
    const block = screen.$("[data-block=audit]");
    assert.equal(screen.text(screen.$("h2", block)), "Agente auditor");
    assert.equal(screen.text(screen.$("[data-field=audit-verdict]", block)), "Concorda com a regra: E4 · Receber · Analista");
  });

  test("AC-3: o agente auditor que diverge diz em quê, com a proposta dele", async () => {
    const audit = {
      ...proposalOutput().audit, classification: "E2", dock_action: { kind: "recusar" }, routing: "coordenacao",
      agreement: { agrees: false, differs: ["classification", "dockAction"] },
    };
    await openProposal(proposalOutput({ audit }));
    assert.equal(
      screen.text(screen.$("[data-field=audit-verdict]")),
      "Diverge da regra em: exceção, ação na doca. Propõe: E2 · Recusar · Coordenação",
    );
  });

  test("AC-3: o dossiê pronto mostra o resumo, o que diverge e as evidências", async () => {
    await openProposal();
    const block = screen.$("[data-block=dossier]");
    assert.equal(screen.text(screen.$("h2", block)), "Dossiê do Claude");
    for (const part of ["A nota cobra 72 UN e a ordem pediu 6 CX.", "A unidade da nota difere da ordem.", "Fator de caixa", "12 UN por CX"]) {
      assert.equal(screen.text(block).includes(part), true, part);
    }
  });

  test("AC-4: motor, auditor e dossiê sem dado mostram — e o motivo em uma linha, nunca somem", async () => {
    await openProposal(
      proposalOutput({
        engine: null,
        audit: null,
        dossier: { status: "unavailable", reason: "pending", notice: "Ainda não avaliado", generated_at: null },
        dossier_status: "unavailable",
      }),
    );
    for (const [block, reason] of [["engine", "Ainda não avaliado"], ["audit", "Ainda não auditada"], ["dossier", "Ainda não avaliado"]]) {
      const text = screen.text(screen.$(`[data-block=${block}] [data-field=empty]`));
      assert.equal(text, `— ${reason}`, block);
    }
  });

  test("AC-4: auditoria que não rodou e dossiê em geração dizem o motivo", async () => {
    await openProposal(
      proposalOutput({
        audit: { status: "nao_auditada", reason: "claude_falhou", refusals: [] },
        dossier: { status: "generating", trigger: "pessoa", requested_at: "2026-11-18T12:00:00Z" },
      }),
    );
    assert.equal(screen.text(screen.$("[data-block=audit] [data-field=empty]")), "— A auditoria não rodou: o Claude falhou.");
    assert.equal(screen.text(screen.$("[data-block=dossier] [data-field=empty]")), "— O Claude está escrevendo o dossiê.");
  });

  test("AC-4: dossiê sem registro nenhum diz que não há dossiê", async () => {
    await openProposal(proposalOutput({ dossier: { status: "none" }, dossier_status: "none" }));
    assert.equal(screen.text(screen.$("[data-block=dossier] [data-field=empty]")), "— Esta nota ainda não tem dossiê.");
  });

  test("AC-3: ← Fila volta à fila, que a tool devolve de novo", async () => {
    await openProposal();
    await screen.click(screen.$("button[data-action=back]"));
    assert.equal(screen.callsOf("list_approval_queue").length, 2);
    assert.equal(screen.text(screen.$("h1")), "Fila de aprovação");
  });
});

describe("Sua decisão", () => {
  const decision = () => screen.$("[data-block=decision]");
  const choice = (value) => screen.$(`input[name=choice][value=${value}]`);
  const register = () => screen.$("button[data-action=register]");
  const decideCalls = () => screen.callsOf("decide_proposal");

  test("AC-3: oferece aprovar, alterar para receber parcial e alterar para recusar, com Cancelar e Registrar", async () => {
    await openProposal();
    assert.equal(screen.text(screen.$("h2", decision())), "Sua decisão");
    const labels = screen.$$("label[data-choice]", decision()).map((l) => screen.text(l));
    assert.deepEqual(labels, ["Aprovar: receber", "Alterar para receber parcial", "Alterar para recusar"]);
    assert.equal(choice("approve").checked, true);
    assert.equal(screen.text(screen.$("button[data-action=cancel]")), "Cancelar");
    assert.equal(screen.text(register()), "Registrar");
    assert.equal(screen.$("table[data-table=partial]"), null);
  });

  test("AC-3: as alternativas são as ações que a proposta não é", async () => {
    await openProposal(proposalOutput({ dock_action: { kind: "recusar" } }));
    const labels = screen.$$("label[data-choice]", decision()).map((l) => screen.text(l));
    assert.deepEqual(labels, ["Aprovar: recusar", "Alterar para receber", "Alterar para receber parcial"]);
  });

  test("AC-3: as evidências que pesaram vêm das evidências e do dossiê da proposta", async () => {
    await openProposal();
    const options = screen.$$("input[data-evidence]", decision()).map((i) => i.value);
    assert.deepEqual(options, ["Ordem: 6 CX · Nota: 72 UN · fator de caixa 12 → bate", "Fator de caixa"]);
    assert.equal(screen.text(decision()).includes("Evidências que pesaram"), true);
    assert.equal(screen.text(decision()).includes("Justificativa"), true);
  });

  test("AC-5: decide_proposal só sai no clique em Registrar, e não ao abrir, escolher, digitar ou cancelar", async () => {
    await openProposal();
    await screen.check(choice("receber_parcial"));
    await screen.type(screen.$("textarea[data-field=justification]"), "Só 60 UN chegaram");
    await screen.check(choice("recusar"));
    await screen.click(screen.$("button[data-action=cancel]"));
    assert.deepEqual(decideCalls(), []);
    await screen.click(register());
    assert.equal(decideCalls().length, 1);
  });

  test("AC-3: aprovar manda decision approve com a chave e só as evidências marcadas", async () => {
    await openProposal(proposalOutput(), { decide_proposal: () => ok(decisionOutput()) });
    await screen.check(screen.$$("input[data-evidence]")[1]);
    await screen.click(register());
    assert.deepEqual(decideCalls(), [{ invoice_access_key: KEY, decision: "approve", weighed_evidence: ["Fator de caixa"] }]);
  });

  test("AC-3: alterar para recusar manda dock_action recusar e a justificativa", async () => {
    await openProposal(proposalOutput(), { decide_proposal: () => ok(decisionOutput()) });
    await screen.check(choice("recusar"));
    await screen.type(screen.$("textarea[data-field=justification]"), "Produto errado");
    await screen.click(register());
    assert.deepEqual(decideCalls(), [
      { invoice_access_key: KEY, decision: "change", dock_action: { kind: "recusar" }, justification: "Produto errado", weighed_evidence: [] },
    ]);
  });

  test("AC-3: alterar para receber parcial abre a tabela de itens preenchida com a proposta da regra", async () => {
    await openProposal();
    await screen.check(choice("receber_parcial"));
    const table = screen.$("table[data-table=partial]");
    assert.deepEqual(screen.$$("th", table).map((th) => screen.text(th)), ["SKU", "Quantidade", "UN/CX", "Segurar/Devolver"]);
    const row = screen.$("tr[data-sku=SKU-1006]", table);
    assert.equal(screen.text(screen.$("[data-col=sku]", row)), "SKU-1006");
    assert.equal(screen.$("input[data-col=amount]", row).value, "6");
    assert.equal(screen.$("select[data-col=unit]", row).value, "CX");
    assert.equal(screen.$("select[data-col=disposition]", row).value, "segurar");
    await screen.check(choice("approve"));
    assert.equal(screen.$("table[data-table=partial]"), null);
  });

  test("AC-3: o receber parcial manda as linhas como a pessoa as deixou", async () => {
    await openProposal(proposalOutput(), { decide_proposal: () => ok(decisionOutput()) });
    await screen.check(choice("receber_parcial"));
    const row = screen.$("tr[data-sku=SKU-1006]");
    await screen.type(screen.$("input[data-col=amount]", row), "4.5");
    await screen.choose(screen.$("select[data-col=unit]", row), "UN");
    await screen.choose(screen.$("select[data-col=disposition]", row), "devolver");
    await screen.type(screen.$("textarea[data-field=justification]"), "Só chegou parte");
    await screen.click(register());
    assert.deepEqual(decideCalls(), [{
      invoice_access_key: KEY,
      decision: "change",
      dock_action: { kind: "receber_parcial", lines: [{ sku: "SKU-1006", quantity: { amount: 4.5, unit: "UN" }, disposition: "devolver" }] },
      justification: "Só chegou parte",
      weighed_evidence: [],
    }]);
  });

  test("AC-3: sem linha proposta pela regra a tabela diz isso e a tool recusa o parcial vazio", async () => {
    await openProposal(proposalOutput({ proposed_partial_lines: [] }), {
      decide_proposal: () => fail("invalid_dock_action", "Receber parcial exige as linhas (lines)."),
    });
    await screen.check(choice("receber_parcial"));
    assert.match(screen.text(screen.$("[data-table=partial-empty]")), /A regra não propõe nenhum item/);
    await screen.type(screen.$("textarea[data-field=justification]"), "x");
    await screen.click(register());
    assert.match(screen.text(screen.$("[data-state=error]")), /Receber parcial exige as linhas \(lines\)\./);
  });

  test("AC-4: sem justificativa ao alterar, o campo fica vermelho, a mensagem aparece e o Registrar não envia", async () => {
    await openProposal();
    await screen.check(choice("recusar"));
    await screen.click(register());
    assert.deepEqual(decideCalls(), []);
    const field = screen.$("textarea[data-field=justification]");
    assert.equal(field.getAttribute("aria-invalid"), "true");
    assert.equal(field.classList.contains("invalid"), true);
    assert.equal(screen.text(screen.$("[data-error=justification]")), "Para alterar, escreva o porquê.");
    await screen.type(field, "   ");
    await screen.click(register());
    assert.deepEqual(decideCalls(), []);
    await screen.type(field, "Produto errado");
    assert.equal(field.getAttribute("aria-invalid"), "false");
    assert.equal(screen.$("[data-error=justification]"), null);
  });

  test("AC-4: aprovar não pede justificativa", async () => {
    await openProposal(proposalOutput(), { decide_proposal: () => ok(decisionOutput()) });
    await screen.click(register());
    assert.equal(decideCalls().length, 1);
    assert.equal(screen.$("[data-error=justification]"), null);
  });

  test("AC-4: a tool que exige a justificativa também deixa o campo vermelho", async () => {
    await openProposal(proposalOutput(), { decide_proposal: () => fail("justification_required", "Para alterar, escreva o porquê.") });
    await screen.check(choice("recusar"));
    await screen.type(screen.$("textarea[data-field=justification]"), "x");
    await screen.click(register());
    assert.equal(decideCalls().length, 1);
    assert.equal(screen.$("textarea[data-field=justification]").getAttribute("aria-invalid"), "true");
    assert.equal(screen.text(screen.$("[data-error=justification]")), "Para alterar, escreva o porquê.");
  });

  test("AC-4: Cancelar volta a escolha para aprovar e limpa o que foi digitado", async () => {
    await openProposal();
    await screen.check(choice("receber_parcial"));
    await screen.type(screen.$("textarea[data-field=justification]"), "texto");
    await screen.click(screen.$("button[data-action=cancel]"));
    assert.equal(choice("approve").checked, true);
    assert.equal(screen.$("textarea[data-field=justification]").value, "");
    assert.equal(screen.$("table[data-table=partial]"), null);
  });

  test("AC-4: decisão registrada mostra o selo verde, o bloco some e a linha sai da fila", async () => {
    let decided = false;
    await openQueue({
      list_approval_queue: () => ok(queueOutput(decided ? [ITEM_E3] : [queueItem(), ITEM_E3])),
      get_proposal: () => ok(proposalOutput()),
      decide_proposal: () => { decided = true; return ok(decisionOutput()); },
    });
    await screen.click(screen.$(`tr[data-key="${KEY}"]`));
    await screen.click(register());
    const seal = screen.$("[data-state=decided]");
    assert.equal(screen.text(seal), "Decidida por você · Receber");
    assert.equal(seal.classList.contains("seal-ok"), true);
    assert.equal(screen.$("[data-block=decision]"), null);
    assert.equal(screen.$("button[data-action=register]"), null);
    await screen.click(screen.$("button[data-action=back]"));
    assert.equal(screen.$(`tr[data-key="${KEY}"]`), null);
    assert.notEqual(screen.$(`tr[data-key="${OTHER_KEY}"]`), null);
  });

  test("AC-4: o selo sem a hora da tool não inventa uma (#274: a API só grava o dia)", async () => {
    await openProposal(proposalOutput(), { decide_proposal: () => ok(decisionOutput()) });
    await screen.click(register());
    assert.equal(screen.text(screen.$("[data-state=decided]")), "Decidida por você · Receber");
  });

  test("AC-4: o selo mostra a hora quando a tool a devolve (#274)", async () => {
    const output = decisionOutput();
    output.approval.decided_hour = "10h12";
    await openProposal(proposalOutput(), { decide_proposal: () => ok(output) });
    await screen.click(register());
    assert.equal(screen.text(screen.$("[data-state=decided]")), "Decidida por você às 10h12 · Receber");
  });

  test("AC-4: a ação do selo é a que a tool gravou, ao alterar", async () => {
    const output = decisionOutput();
    output.approval.dock_action = { kind: "recusar" };
    output.approval.decision = "change";
    await openProposal(proposalOutput(), { decide_proposal: () => ok(output) });
    await screen.check(choice("recusar"));
    await screen.type(screen.$("textarea[data-field=justification]"), "Produto errado");
    await screen.click(register());
    assert.equal(screen.text(screen.$("[data-state=decided]")), "Decidida por você · Recusar");
  });

  test("AC-4: já decidida por outra pessoa mostra o aviso amarelo e recarrega a proposta", async () => {
    let reloaded = false;
    const decidedBy = proposalOutput({
      can_decide: true,
      approval: {
        approver: "fulano@exemplo.com", approver_level: "coordenacao", decided_at: "2026-11-18T13:12:40Z", decided_hour: "10h12",
        decision: "approve", dock_action: { kind: "receber" }, justification: "",
      },
    });
    await openProposal(proposalOutput(), {
      get_proposal: () => { const out = reloaded ? decidedBy : proposalOutput(); reloaded = true; return ok(out); },
      decide_proposal: () => fail("already_decided", "Esta proposta já foi decidida por fulano@exemplo.com às 10h12."),
    });
    await screen.click(register());
    assert.equal(screen.callsOf("get_proposal").length, 2, "a tela recarrega a proposta");
    const warning = screen.$("[data-state=already-decided]");
    assert.equal(screen.text(warning), "Esta proposta já foi decidida por fulano@exemplo.com às 10h12.");
    assert.equal(warning.classList.contains("notice-warning"), true);
    assert.equal(screen.$("button[data-action=register]"), null);
    assert.match(screen.text(screen.$("[data-state=decided-by]")), /Decidida por fulano@exemplo\.com às 10h12 · Receber/);
  });

  test("AC-4: sem nível para decidir, o bloco vira o aviso do nível exigido, sem botões", async () => {
    await openProposal(proposalOutput({ can_decide: false, level: "coordenacao", required_approver_level: "coordenacao" }));
    assert.equal(screen.text(screen.$("[data-state=forbidden]")), "Esta proposta pede o nível Coordenação ou acima.");
    assert.equal(screen.$("button[data-action=register]"), null);
    assert.equal(screen.$("input[name=choice]"), null);
    assert.equal(screen.$("button[data-action=cancel]"), null);
    assert.equal(screen.text(screen.$("[data-block=decision] h2")), "Sua decisão");
  });

  test("AC-4: nível exigido de bloqueio diz que é acima do nível da pessoa", async () => {
    await openProposal(proposalOutput({ can_decide: false, level: "bloqueio", required_approver_level: "bloqueio" }));
    assert.equal(screen.text(screen.$("[data-state=forbidden]")), "Esta proposta pede um nível acima do seu.");
  });

  test("AC-4: a tool que recusa por nível troca o bloco pela mensagem dela", async () => {
    await openProposal(proposalOutput(), { decide_proposal: () => fail("forbidden_level", "Esta proposta pede o nível Coordenação ou acima.") });
    await screen.click(register());
    assert.equal(screen.text(screen.$("[data-state=forbidden]")), "Esta proposta pede o nível Coordenação ou acima.");
    assert.equal(screen.$("button[data-action=register]"), null);
  });

  test("AC-4: sessão expirada ao registrar mostra o aviso; Entrar só limpa o aviso e não chama decide_proposal (#274, #321)", async () => {
    await openProposal(proposalOutput(), { decide_proposal: () => fail("session_expired", SESSION_EXPIRED) });
    await screen.click(register());
    assert.equal(screen.text(screen.$("[data-state=session-expired]")), `${SESSION_EXPIRED} Entrar`);
    assert.equal(decideCalls().length, 1);
    await screen.click(screen.$("[data-action=sign-in]"));
    assert.equal(decideCalls().length, 1, "decide_proposal só sai no clique em Registrar");
    assert.equal(screen.$("[data-state=session-expired]"), null);
    assert.notEqual(screen.$("button[data-action=register]"), null);
  });

  test("AC-4: falha ao registrar mostra a mensagem da tool e mantém o bloco para tentar de novo", async () => {
    await openProposal(proposalOutput(), {
      decide_proposal: () => fail("unavailable", "Não foi possível concluir agora. Tente de novo em instantes.", { correlation_id: "zzz999" }),
    });
    await screen.click(register());
    assert.match(screen.text(screen.$("[data-state=error]")), /Não foi possível concluir agora/);
    assert.doesNotMatch(screen.text(), /zzz999/);
    assert.notEqual(screen.$("button[data-action=register]"), null);
  });

  test("AC-4: uma proposta que já tem decisão abre sem o bloco de decisão", async () => {
    await openProposal(proposalOutput({
      approval: {
        approver: "fulano@exemplo.com", approver_level: "coordenacao", decided_at: "2026-11-18", decided_hour: null, decision: "change",
        dock_action: { kind: "recusar" }, justification: "Produto errado",
      },
    }));
    assert.equal(screen.text(screen.$("[data-state=decided-by]")), "Decidida por fulano@exemplo.com · Recusar");
    assert.equal(screen.$("button[data-action=register]"), null);
  });

  test("AC-4: proposta não encontrada mostra a mensagem da tool e volta à fila", async () => {
    await openQueue({ get_proposal: () => fail("not_found", "Não encontrei uma proposta com essa chave.") });
    await screen.click(screen.$(`tr[data-key="${KEY}"]`));
    assert.match(screen.text(screen.$("[data-state=error]")), /Não encontrei uma proposta com essa chave\./);
    assert.notEqual(screen.$("button[data-action=back]"), null);
  });
});

describe("AC-5: a tela não calcula nem inventa número", () => {
  const digitRuns = (value) => value.match(/\d+/g) ?? [];

  test("todo número da tela, da fila e da proposta, está na saída de uma tool", async () => {
    const proposal = proposalOutput();
    const queue = queueOutput([queueItem(), ITEM_E3, ITEM_BLOCKED]);
    await openQueue({ list_approval_queue: () => ok(queue), get_proposal: () => ok(proposal) });
    // Os filtros de exceção listam E1 a E8, rótulos do glossário e não dado: ficam de fora da conferência (#274).
    const visibleText = () => {
      const copy = screen.document.body.cloneNode(true);
      copy.querySelectorAll("[data-filter], script, style").forEach((filter) => filter.remove());
      copy.querySelectorAll("*").forEach((element) => element.append(" ")); // separa as células, como a vista separa (#274)
      return copy.textContent.replace(/\s+/g, " ");
    };
    const seen = [visibleText()];
    await screen.click(screen.$(`tr[data-key="${KEY}"]`));
    await screen.check(screen.$("input[name=choice][value=receber_parcial]"));
    seen.push(visibleText());
    seen.push(...screen.$$("input, textarea, select").map((field) => field.value));
    const fromTools = new Set(digitRuns(JSON.stringify([queue, proposal])));
    const staticText = new Set(["10", "138"]); // "captura das 10h" e "Na #138": texto fixo da tela, que não é dado
    for (const run of seen.flatMap((s) => s.match(/\d+(?:[ .,]\d+)*/g) ?? [])) {
      const digits = run.replace(/\D/g, "");
      const known = fromTools.has(digits) || staticText.has(digits) || run.split(/[ .,]/).every((part) => fromTools.has(part));
      assert.equal(known, true, `o número "${run}" apareceu na tela sem vir de uma tool`);
    }
  });

  test("a contagem e o valor do cabeçalho não são a soma nem o tamanho da lista", async () => {
    await openQueue();
    const summary = screen.text(screen.$("[data-field=summary]"));
    assert.equal(summary.startsWith("12 propostas"), true);
    assert.equal(screen.$$("table[data-table=queue] tbody tr").length, 2);
    assert.equal(summary.includes("R$ 84.310,20"), true);
  });

  test("o valor da linha é o texto da tool, mesmo quando o texto não bate com os centavos", async () => {
    await openQueue({ list_approval_queue: () => ok(queueOutput([queueItem({ amount_at_risk: { cents: 100, text: "R$ 7,77" } })])) });
    assert.equal(cells(screen.$(`tr[data-key="${KEY}"]`))[3], "R$ 7,77");
  });

  test("a confiança do motor aparece como a tool a devolveu", async () => {
    const engine = { ...proposalOutput().engine, confidence: 0.5 };
    await openProposal(proposalOutput({ engine }));
    assert.match(screen.text(screen.$("[data-field=engine-verdict]")), /confiança 0,5 /);
  });

  test("a quantidade do parcial é a da tool, sem conversão de unidade", async () => {
    await openProposal(proposalOutput({ proposed_partial_lines: [{ sku: "SKU-1006", quantity: { amount: 7, unit: "CX" }, disposition: "devolver" }] }));
    await screen.check(screen.$("input[name=choice][value=receber_parcial]"));
    assert.equal(screen.$("input[data-col=amount]").value, "7");
    assert.equal(screen.$("select[data-col=unit]").value, "CX");
  });
});

describe("texto vindo de tool entra por textContent", () => {
  const hostile = '<img src=x onerror="window.pwned=1"><b>negrito</b>';

  test("a descrição, a evidência, o motivo e a justificativa do auditor aparecem como texto, não como marcação", async () => {
    const proposal = proposalOutput({
      regua: { line: 5, reason: hostile },
      divergences: [{ classification: "E4", classification_name: hostile, skus: [hostile], evidence: [{ source: "s", reference: "r", description: hostile }] }],
      engine: { ...proposalOutput().engine, reason: hostile },
      audit: { ...proposalOutput().audit, justification: hostile },
      dossier: { status: "ready", summary: hostile, divergences: [], supplier_history: null },
    });
    await openProposal(proposal);
    assert.equal(screen.$("img"), null);
    assert.equal(screen.$("b"), null);
    assert.equal(screen.window.pwned, undefined);
    assert.equal(screen.text().includes("<img src=x"), true);
  });

  test("o nome do fornecedor e a mensagem de erro da tool também", async () => {
    await openQueue({ list_approval_queue: () => ok(queueOutput([queueItem({ supplier_id: hostile, classification_name: hostile })])) });
    assert.equal(screen.$("img"), null);
    assert.equal(screen.$("b"), null);
    await openQueue({ list_approval_queue: () => fail("unavailable", hostile) });
    assert.equal(screen.$("img"), null);
  });
});

describe("um host que não responde (#274)", () => {
  test("a tool que o host nunca responde acaba na mensagem genérica, sem ficar no esqueleto", async () => {
    screen = openScreen({}, { unanswered: ["tools/call"], requestTimeoutMs: DEADLINE_MS });
    await screen.openApp();
    assert.notEqual(screen.$("[data-skeleton]"), null);
    await sleep(DEADLINE_MS * 2);
    await screen.flush();
    assert.equal(screen.$("[data-skeleton]"), null);
    assert.equal((screen.$("[data-state=error]")?.textContent ?? "").includes(GENERIC), true);
  });

  test("a decisão sem resposta do host mostra a mensagem genérica e o Registrar volta a habilitar", async () => {
    screen = openScreen(
      { list_approval_queue: () => ok(queueOutput()), get_proposal: () => ok(proposalOutput()) },
      { unanswered: ["tools/call:decide_proposal"], requestTimeoutMs: DEADLINE_MS },
    );
    await screen.openApp();
    await screen.click(screen.$(`tr[data-key="${KEY}"]`));
    const register = screen.$("button[data-action=register]");
    await screen.click(register);
    assert.equal(register.disabled, true);
    await sleep(DEADLINE_MS * 2);
    await screen.flush();
    assert.equal(register.disabled, false);
    assert.equal((screen.$("[data-block=decision] [data-state=error]")?.textContent ?? "").includes(GENERIC), true);
  });

  test("o ui/initialize sem resposta mostra o estado de erro genérico", async () => {
    screen = openScreen({}, { unanswered: ["ui/initialize"], requestTimeoutMs: DEADLINE_MS });
    await screen.flush();
    assert.equal(screen.$("[data-state=error]"), null);
    await sleep(DEADLINE_MS * 2);
    await screen.flush();
    assert.equal((screen.$("[data-state=error]")?.textContent ?? "").includes(GENERIC), true);
  });

  test("a resposta que chega a tempo não dispara o prazo", async () => {
    screen = openScreen({ list_approval_queue: () => ok(queueOutput()) }, { requestTimeoutMs: DEADLINE_MS });
    await screen.openApp();
    await sleep(DEADLINE_MS * 2);
    await screen.flush();
    assert.notEqual(screen.$("[data-screen=queue]"), null);
    assert.equal(screen.$("[data-state=error]"), null);
  });
});
