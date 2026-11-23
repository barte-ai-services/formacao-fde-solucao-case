/*
 * #356 Os passos periféricos da rodada, um helper por passo: cada um engole a própria falha, registra uma linha sem dado sensível
 * (só o status ou a classe, nunca a mensagem do banco) e o nome fixo do passo em `fail` (automation_runs.failed_steps). Saíram de
 * tick.ts quando a rodada passou a ser a lista de passos orçada (round-steps.ts, round-work.ts): tick.ts importa round-work.ts, e
 * round-work.ts não pode importar de volta o tick sem fechar um ciclo.
 */
import { listDescriptionSuggestions, storedDescriptionSuggester } from "../connectors/claude-suggestions";
import { SupabaseRest, SupabaseRestError } from "../connectors/supabase-rest";
import type { RegistryCorrectionOutbox } from "../connectors/ports";
import type { DescriptionSuggester } from "../domain/description-match";
import type { Env } from "../env";
import { SupabaseApprovalStore } from "../approval/supabase-store";
import { publishDecidedDockActions, publishDecidedStoreActions } from "../dock/publish-decided";
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

/** #66 A janela, em dias, das decisões que o Cron manda ao Cadastro; ver `lastDaysUtc`. */
const PUBLISH_WINDOW_DAYS = 7;

/** #156 O teto de devoluções publicadas por rodada, para caber nas ~50 subrequisições do plano gratuito. */
const RETURN_NOTES_PER_ROUND = 20;

/**
 * #66 As sugestões de casamento por descrição que a rodada do Claude (api/src/claude) gravou. Se a leitura falha,
 * registra uma linha (só o status, sem dado sensível) e a regra decide sozinha.
 */
export async function storedSuggestions(rest: SupabaseRest, fail: Fail): Promise<DescriptionSuggester | undefined> {
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
export async function publishApproved(
  rest: SupabaseRest,
  outbox: RegistryCorrectionOutbox,
  fail: Fail,
  // #356 AC-4 O passo da rodada varre uma fatia da janela por vez; sem a fatia, a janela inteira de sempre.
  days: readonly string[] = lastDaysUtc(new Date(), PUBLISH_WINDOW_DAYS),
  // #356 AC-4 O teto de mensagens novas por chamada; sem ele, todas, como fora da rodada.
  limit?: number,
): Promise<number> {
  try {
    const { published } = await publishApprovedUnregistered({
      store: new SupabaseApprovalStore(rest),
      outbox,
      days,
      ...(limit === undefined ? {} : { limit }),
    });
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
export async function publishDock(rest: SupabaseRest, fail: Fail, limit: number = Number.POSITIVE_INFINITY): Promise<number> {
  try {
    return (await publishDecidedDockActions(rest, undefined, limit)).published;
  } catch (error) {
    const status = error instanceof SupabaseRestError ? `HTTP ${error.status}` : "falha na publicação";
    fail("dock");
    console.log(`cron: doca indisponível (${status}); a próxima rodada repete`);
    return 0;
  }
}

/** #135 As notas de loja: a ação aprovada vai para o app da loja. Falhou, o Cron repete na próxima rodada. */
export async function publishStoreActions(rest: SupabaseRest, fail: Fail, limit: number = Number.POSITIVE_INFINITY): Promise<number> {
  try {
    return (await publishDecidedStoreActions(rest, undefined, limit)).published;
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
export async function runEngine(
  rest: SupabaseRest,
  env: Env,
  fail: Fail,
  // #356 AC-4 Os tetos da rodada do motor, para o passo caber no orçamento; sem eles, os de sempre.
  { clefTimeoutCapMs, ...limits }: { readonly decisionLimit?: number; readonly clefLimit?: number; readonly clefTimeoutCapMs?: number } = {},
): Promise<{ evaluated: number; approved: number }> {
  const none = { evaluated: 0, approved: 0 };
  if (!env.ai) {
    console.log("cron: sem o binding do Workers AI; motor de decisão pulado");
    return none;
  }
  try {
    const round = await runEngineRound({
      approvals: new SupabaseApprovalStore(rest),
      store: new SupabaseEngineStore(rest, clefTimeoutCapMs),
      clef: new WorkersAiClef(env.ai),
      today: () => todayInBrasilia(),
      ...limits,
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
export async function publishReturnNotes(rest: SupabaseRest, fail: Fail, limit: number = RETURN_NOTES_PER_ROUND): Promise<number> {
  try {
    const { published } = await sweepReturnNotes(new SupabaseDecidedReturnSource(rest), erpReturnNoteOutbox(rest), limit);
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
export async function markOverdueRequests(rest: SupabaseRest, fail: Fail): Promise<number> {
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
export type Fail = (step: string) => void;
