import { listDescriptionSuggestions, storedDescriptionSuggester } from "../connectors/claude-suggestions";
import { blockDuplicateTitles } from "../connectors/duplicate-settler";
import { runClaudeRound } from "../claude/cron";
import { supabaseConnectors } from "../connectors/supabase-connectors";
import { SupabaseRest, SupabaseRestError, type FetchFn } from "../connectors/supabase-rest";
import type { RegistryCorrectionOutbox } from "../connectors/ports";
import type { DescriptionSuggester } from "../domain/description-match";
import type { Env } from "../env";
import { captureInvoices } from "./capture";
import { findUnreconciledReceipts } from "./unreconciled-receipts";
import { proposeChecked } from "../approval/propose-checked";
import { SupabaseApprovalStore } from "../approval/supabase-store";
import { publishDecidedDockActions, publishDecidedStoreActions } from "../dock/publish-decided";
import { NO_FIGURES, recordRun, type RunFigures } from "../automation/runs";
import { erpReturnNoteOutbox } from "../connectors/erp-return-note";
import { SupabaseDecidedReturnSource } from "../returns/supabase-decided-source";
import { sweepReturnNotes } from "../returns/sweep-return-notes";
import { lastDaysUtc, publishApprovedUnregistered } from "./publish-approved-e8";
import { WorkersAiClef } from "../engine/clef";
import { runEngineRound } from "../engine/delegated";
import { todayInBrasilia } from "../http/approval";
import { SupabaseEngineStore } from "../engine/supabase-store";
import { sweepSupplierOverdue } from "./supplier-sweep";
import { SupplierStoreError } from "../supplier/supabase-store";
import { countSubrequests, subrequestsLine } from "./subrequests";

/** #66 A janela, em dias, das decisões que o Cron manda ao Cadastro; ver `lastDaysUtc`. */
const PUBLISH_WINDOW_DAYS = 7;

/** #156 O teto de devoluções publicadas por rodada, para caber nas ~50 subrequisições do plano gratuito. */
const RETURN_NOTES_PER_ROUND = 20;

/** #174 O que uma rodada fez, para a reconferência devolver. Nulo quando a rodada foi pulada. */
export interface TickSummary {
  seen: number;
  inserted: number;
  checked: number;
  failed: number;
  proposed: number;
}

/**
 * Execução agendada: captura e confere as notas (#59). Registra uma linha, sem dado sensível.
 * #311 O dossiê não roda aqui: este tick já passa dos 50 subrequests antes de chegar nele; o dossiê tem a própria
 * invocação (cron/dossier-round.ts, o cron de schedule.ts).
 * #311 Só a captura é o caminho crítico: falha nela é rodada `failed` e o erro sobe. Todo passo depois dela falha sozinho (`guarded` ou o
 * próprio try/catch do passo), entra em failed_steps e a rodada segue; a linha de automation_runs é sempre tentada. No plano gratuito,
 * passado o teto de 50 todo fetch falha (status 0) e a própria gravação também; a linha `subrequests n/50` no log é o rastro que resta.
 * Medido sobre a base do kit (api/test/cron/subrequests-line.test.ts): a rodada quieta (sem nota nova) faz 67 chamadas sem o Claude e 90 com
 * duas tarefas dele; a 50ª cai dentro de proposeChecked (a leitura por proposta que espera: invoices, divergences, titles, approvals e
 * fornecedores). Em produção o teto cai antes da doca, da loja, das devoluções e dos títulos duplicados, como o log de 22/11 mostrou.
 */
export async function tick(
  controller: Pick<ScheduledController, "cron">,
  env: Env,
): Promise<TickSummary | null> {
  const startedAt = new Date();
  const url = env.BARTE_ACADEMY_SUPABASE_URL;
  const secretKey = env.BARTE_ACADEMY_SUPABASE_SECRET_KEY;
  if (!url || !secretKey) {
    console.log(`cron: execução agendada (${controller.cron}); sem credenciais do Supabase, captura pulada`);
    return null;
  }
  // #311 O fetch por invocação conta os subrequests (PostgREST e Messages API); a linha final diz quantos foram contra os 50.
  const counter = countSubrequests();
  const rest = new SupabaseRest({ url, secretKey, fetch: counter.fetch });
  const failedSteps: string[] = [];
  // #311 A gravação da rodada é mais um subrequest e já entra no número que ela grava.
  const runCount = () => counter.count() + 1;
  try {
    const { summary, figures } = await runRound(controller, env, rest, counter.fetch, failedSteps);
    // #311 Passo periférico falho não muda o status: a rodada fica `ok` e failed_steps diz o que falhou (o enum de status não muda).
    await recordRunSafely(rest, { startedAt, status: "ok", figures, failedSteps, subrequests: runCount() });
    return summary;
  } catch (error) {
    // #211 AC-1 A rodada que falha (a captura, o caminho crítico) também fica gravada, só com a classe do erro.
    await recordRunSafely(rest, { startedAt, status: "failed", figures: NO_FIGURES, error: errorClass(error), failedSteps, subrequests: runCount() });
    throw error;
  } finally {
    console.log(subrequestsLine(counter.count(), `tick ${controller.cron}`));
  }
}

function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

/** #211 O registro da rodada é observação: se falha, uma linha no log e o Cron segue. */
async function recordRunSafely(
  rest: SupabaseRest,
  run: { startedAt: Date; status: "ok" | "failed"; figures: RunFigures; error?: string; failedSteps: readonly string[]; subrequests: number },
): Promise<void> {
  try {
    await recordRun(rest, { ...run, finishedAt: new Date() });
  } catch (error) {
    const status = error instanceof SupabaseRestError ? `HTTP ${error.status}` : "falha na gravação";
    console.log(`cron: rodada não registrada (${status})`);
  }
}

async function runRound(
  controller: Pick<ScheduledController, "cron">,
  env: Env,
  rest: SupabaseRest,
  fetch: FetchFn,
  failedSteps: string[],
): Promise<{ summary: TickSummary; figures: RunFigures }> {
  const fail: Fail = (step) => {
    failedSteps.push(step);
  };
  const { captureDeps, registryCorrections } = supabaseConnectors(rest);
  const descriptions = await storedSuggestions(rest, fail);
  // #311 A captura é o caminho crítico: se ela falha, a rodada falha. Tudo depois dela é periférico e falha sozinho (`guarded`).
  const result = await captureInvoices(descriptions ? { ...captureDeps, descriptions } : captureDeps);
  const unreconciled = await guarded(fail, "unreconciled", "recebimentos sem nota", () => findUnreconciledReceipts(captureDeps), {
    noKey: [] as string[],
    keyWithoutInvoice: [] as string[],
  });
  // #63 Depois de conferir, propõe e encaminha pela régua; o match vai sozinho para a lista do dia.
  const proposals = await guarded<{ proposed: number; approvedByRule: number }>(
    fail,
    "proposals",
    "propostas",
    () => proposeChecked({ rest, purchasing: captureDeps.purchasing, registry: captureDeps.registry, wms: captureDeps.wms }),
    { proposed: 0, approvedByRule: 0 },
  );
  const cadastroE8 = await publishApproved(rest, registryCorrections, fail);
  // #43 AC-1 O que a regra aprovou agora (e o que falhou na hora da aprovação) vai para a doca.
  const dock = await publishDock(rest, fail);
  const storeActions = await publishStoreActions(rest, fail);
  // #156 A devolução das decisões da regra e das que falharam na rota entra na fila das notas de devolução.
  const returnNotes = await publishReturnNotes(rest, fail);
  // #31/AC-5: o título da E6 fica bloqueado já na detecção.
  const duplicates = await guarded(fail, "duplicate-titles", "títulos duplicados", () => blockDuplicateTitles(rest), { blocked: 0, failed: 0 });
  // #157 (#157) O pedido ao fornecedor sem resposta depois do prazo vira no_reply, sem o Claude: a regra roda mesmo sem credencial.
  // #157 Vai antes da rodada do Claude; a cobrança é montada pela própria varredura (#157).
  const overdueRequests = await markOverdueRequests(rest, fail);
  // #171 O Claude vai por último: é periférico, e a captura (o caminho crítico) fica com os subrequests da
  // invocação. As sugestões que ele grava aqui a próxima rodada lê. Falha fechada: a regra decide sozinha.
  // #311 Recebe o fetch contado da invocação; a rodada com alguma tarefa falha (ou que desistiu de todas) conta como passo falho.
  await guarded(fail, "claude", "rodada do Claude", async () => {
    const round = await runClaudeRound(rest, env, { fetch });
    if (round.failedTasks.length > 0) fail("claude");
  }, undefined);
  // #41 O motor de decisão também é periférico e falha sozinho. #42 Com a delegação do analista ligada, aprova; a
  // ação aprovada pelo motor chega à doca na varredura da próxima rodada (`publishDock`), como a que falhou agora.
  const engine = await runEngine(rest, env, fail);
  const engineEvaluated = engine.evaluated;
  console.log(
    `cron: execução agendada (${controller.cron}); notas vistas ${result.seen}, novas ${result.inserted}, conferidas ${result.checked}, com erro ${result.failed}, propostas ${proposals.proposed}, aprovadas pela regra ${proposals.approvedByRule}, cadastro E8 ${cadastroE8}, ações publicadas na doca ${dock}, ações publicadas no app da loja ${storeActions}, devoluções publicadas ${returnNotes}, pedidos ao fornecedor atrasados ${overdueRequests}, títulos duplicados bloqueados ${duplicates.blocked}, com falha ${duplicates.failed}, avaliadas pelo motor ${engineEvaluated}, aprovadas pelo motor ${engine.approved}; recebimentos sem nota [${unreconciled.noKey.join(", ")}], com chave sem nota [${unreconciled.keyWithoutInvoice.join(", ")}]; passos com falha [${failedSteps.join(", ")}]`,
  );
  const summary = {
    seen: result.seen,
    inserted: result.inserted,
    checked: result.checked,
    failed: result.failed,
    proposed: proposals.proposed,
  };
  const figures: RunFigures = {
    ...summary,
    approvedByRule: proposals.approvedByRule,
    cadastroE8,
    dockPublished: dock,
    storePublished: storeActions,
    duplicatesBlocked: duplicates.blocked,
    engineEvaluated,
    engineApproved: engine.approved,
  };
  return { summary, figures };
}

/**
 * #66 As sugestões de casamento por descrição que a rodada do Claude (api/src/claude) gravou. Se a leitura falha,
 * registra uma linha (só o status, sem dado sensível) e a regra decide sozinha.
 */
async function storedSuggestions(rest: SupabaseRest, fail: Fail): Promise<DescriptionSuggester | undefined> {
  try {
    return storedDescriptionSuggester(await listDescriptionSuggestions(rest));
  } catch (error) {
    const status = error instanceof SupabaseRestError ? `HTTP ${error.status}` : "falha na leitura";
    fail("suggestions");
    console.log(`cron: sugestões do Claude indisponíveis (${status}); a regra decide sozinha`);
    return undefined;
  }
}

/**
 * #35 (plano #66, AC-5) Manda ao Cadastro o E8 das propostas decididas os últimos 7 dias (UTC). Se falha, registra
 * uma linha sem dado sensível e a rodada segue: a caixa de saída é idempotente e a próxima rodada repete.
 */
async function publishApproved(
  rest: SupabaseRest,
  outbox: RegistryCorrectionOutbox,
  fail: Fail,
): Promise<number> {
  try {
    const days = lastDaysUtc(new Date(), PUBLISH_WINDOW_DAYS);
    const { published } = await publishApprovedUnregistered({ store: new SupabaseApprovalStore(rest), outbox, days });
    return published;
  } catch (error) {
    const status = error instanceof SupabaseRestError ? `HTTP ${error.status}` : "falha na publicação";
    fail("registry-e8");
    console.log(`cron: cadastro E8 indisponível (${status}); a próxima rodada repete`);
    return 0;
  }
}

/**
 * #43 AC-1 Publica na caixa de saída do WMS a ação das propostas decididas que ainda não chegou à doca.
 * Se falha, registra uma linha sem dado sensível e a rodada segue: a varredura é idempotente e a
 * próxima rodada repete.
 */
async function publishDock(rest: SupabaseRest, fail: Fail): Promise<number> {
  try {
    return (await publishDecidedDockActions(rest)).published;
  } catch (error) {
    const status = error instanceof SupabaseRestError ? `HTTP ${error.status}` : "falha na publicação";
    fail("dock");
    console.log(`cron: doca indisponível (${status}); a próxima rodada repete`);
    return 0;
  }
}

/** #135 As notas de loja: a ação aprovada vai para o app da loja. Falhou, o Cron repete na próxima rodada. */
async function publishStoreActions(rest: SupabaseRest, fail: Fail): Promise<number> {
  try {
    return (await publishDecidedStoreActions(rest)).published;
  } catch (error) {
    const status = error instanceof SupabaseRestError ? `HTTP ${error.status}` : "falha na publicação";
    fail("store");
    console.log(`cron: app da loja indisponível (${status}); a próxima rodada repete`);
    return 0;
  }
}

/**
 * #41 AC-1 a AC-3 e AC-6 O motor de decisão. #42 AC-5 Com a delegação do analista desligada (o padrão), o modo
 * sombra: grava o que faria em engine_decisions, sem tocar em approvals nem em proposals. Ligada, o modo delegado:
 * aprova pelo caminho da aprovação da pessoa e conta em `engine_approved`. Sem o binding do Workers AI, pula; se
 * falha, registra uma linha sem dado sensível e a rodada segue: a próxima avalia o que ficou.
 */
async function runEngine(rest: SupabaseRest, env: Env, fail: Fail): Promise<{ evaluated: number; approved: number }> {
  const none = { evaluated: 0, approved: 0 };
  if (!env.ai) {
    console.log("cron: sem o binding do Workers AI; motor de decisão pulado");
    return none;
  }
  try {
    const round = await runEngineRound({
      approvals: new SupabaseApprovalStore(rest),
      store: new SupabaseEngineStore(rest),
      clef: new WorkersAiClef(env.ai),
      today: () => todayInBrasilia(),
    });
    if (round.mode === "delegated") {
      console.log(
        `cron: motor (delegado), avaliadas ${round.evaluated}, aprovadas ${round.approved}, com a pessoa depois de aprovar ${round.keptWithPerson}, abaixo do limite ${round.belowConfidence}, Clef ${round.clefCalls}, com falha ${round.clefFailed}, para a próxima rodada ${round.deferred}, com erro ${round.errors}`,
      );
      if (round.firstError) {
        console.log(`cron: motor (delegado), decisões ou aprovações não gravadas (${round.firstError}); ficam com a pessoa`);
      }
      return { evaluated: round.evaluated, approved: round.approved };
    }
    console.log(
      `cron: motor (sombra), avaliadas ${round.evaluated}, medidas pelo Clef ${round.measured}, refeitas depois de falha ${round.retried}, Clef ${round.clefCalls}, com falha ${round.clefFailed}, para a próxima rodada ${round.deferred}`,
    );
    if (round.writeError) {
      console.log(`cron: motor (sombra), novas tentativas ou medição não gravadas (${round.writeError}); a próxima rodada repete`);
    }
    return { evaluated: round.evaluated, approved: 0 };
  } catch (error) {
    const status = error instanceof SupabaseRestError ? `HTTP ${error.status}` : "falha no motor";
    fail("engine");
    console.log(`cron: motor de decisão indisponível (${status}); a próxima rodada repete`);
    return none;
  }
}

/**
 * #156 Publica a devolução das decisões que devolvem e ainda não estão na fila, até o teto por rodada. Se
 * falha, registra uma linha sem dado (só o status ou a tabela de uma linha fora do formato) e a rodada segue:
 * a varredura é idempotente e a próxima rodada repete.
 */
async function publishReturnNotes(rest: SupabaseRest, fail: Fail): Promise<number> {
  try {
    const { published } = await sweepReturnNotes(new SupabaseDecidedReturnSource(rest), erpReturnNoteOutbox(rest), RETURN_NOTES_PER_ROUND);
    return published;
  } catch (error) {
    const reason =
      error instanceof SupabaseRestError
        ? error.operation === "parse"
          ? `linha de ${error.table} fora do formato`
          : `HTTP ${error.status}`
        : "falha na publicação";
    fail("return-notes");
    console.log(`cron: devoluções indisponíveis (${reason}); a próxima rodada repete`);
    return 0;
  }
}

/**
 * #157 Marca no_reply o pedido ao fornecedor enviado, sem leitura, depois do prazo. Se falha, registra uma linha sem dado
 * (só o status ou a tabela) e a rodada segue: a varredura é idempotente e a próxima rodada repete.
 */
async function markOverdueRequests(rest: SupabaseRest, fail: Fail): Promise<number> {
  try {
    return (await sweepSupplierOverdue(rest)).marked;
  } catch (error) {
    const reason = error instanceof SupabaseRestError || error instanceof SupplierStoreError ? `HTTP ${error.status}` : "falha na varredura";
    fail("overdue-requests");
    console.log(`cron: prazo dos pedidos ao fornecedor indisponível (${reason}); a próxima rodada repete`);
    return 0;
  }
}

/** #311 Registra o passo periférico que falhou (o nome fixo vai para automation_runs.failed_steps). */
type Fail = (step: string) => void;

/** #311 O que o log e a gravação dizem de um erro: só o status do banco ou a classe, nunca a mensagem (pode trazer a resposta do banco). */
function reasonOf(error: unknown): string {
  return error instanceof SupabaseRestError ? `HTTP ${error.status}` : errorClass(error);
}

/**
 * #311 Roda um passo periférico da rodada: se lança, registra o nome em `fail` e uma linha só com a classe ou o status, devolve o
 * `fallback` e a rodada segue para os passos seguintes. A captura não passa por aqui: ela é o caminho crítico.
 */
async function guarded<T>(fail: Fail, step: string, what: string, run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    fail(step);
    console.log(`cron: ${what} indisponível (${reasonOf(error)}); a próxima rodada repete`);
    return fallback;
  }
}
