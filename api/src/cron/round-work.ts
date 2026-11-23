/*
 * #356 AC-4 O trabalho real de cada passo da rodada: o que o `runRound` do tick fazia em sequência (os helpers estão em round-helpers.ts), agora um
 * passo por vez para o executor de automation/round-budget.ts. Os passos falham sozinhos, como a #311 deixou: os helpers de
 * round-helpers.ts engolem a falha, logam uma linha sem dado sensível e a registram em `fail` (failed_steps); o que lança, o executor
 * conta. Só a captura, o caminho crítico, faz a rodada `failed` (`ROUND_FAILING_STEPS`).
 *
 * #311 O dossiê não é passo daqui: tem o cron próprio (cron/dossier-round.ts) e a rodada orquestrada não o despacha.
 */
import { blockDuplicateTitles } from '../connectors/duplicate-settler.js';
import { listDescriptionSuggestions, storedDescriptionSuggester } from '../connectors/claude-suggestions.js';
import type { CheckFailure } from '../connectors/invoice-store.js';
import { supabaseConnectors } from '../connectors/supabase-connectors.js';
import type { FetchFn, SupabaseRest } from '../connectors/supabase-rest.js';
import type { DescriptionSuggester } from '../domain/description-match.js';
import type { Env } from '../env.js';
import { proposeChecked } from '../approval/propose-checked.js';
import { runClaudeRound } from '../claude/cron.js';
import { tasksFor } from '../claude/tasks/index.js';
import { lastDaysUtc } from './publish-approved-e8.js';
import { captureInvoices, markCheckFailures, type CaptureDeps } from './capture.js';
import type { RoundWork } from './round-steps.js';
import {
  markOverdueRequests,
  publishApproved,
  publishDock,
  publishReturnNotes,
  publishStoreActions,
  runEngine,
  storedSuggestions,
  type Fail,
} from "./round-helpers.js";
import { runDemoNotesRound } from '../demo/round-step.js';
import { findUnreconciledReceipts } from './unreconciled-receipts.js';

/** #356 AC-4 A janela do E8 é a de round-helpers.ts (7 dias, PUBLISH_WINDOW_DAYS), servida em fatias (REGISTRY_SLICES). */
export const REGISTRY_WINDOW_DAYS = 7;
/** #356 AC-4 Os tetos de cada passo por rodada, escolhidos para o passo caber ao lado da captura (STEP_COSTS). */
export const RETURN_NOTES_PER_STEP = 5;
export const DOCK_PER_STEP = 5;
export const STORE_PER_STEP = 5;
/**
 * #356 AC-4 Os tetos dos passos que tinham laço sem teto, no tamanho que o custo declarado em STEP_COSTS comporta:
 * - títulos E6 bloqueados por passo: 2 leituras + 1 update por título = 11 (STEP_COSTS.duplicates);
 * - mensagens E8 novas por fatia da janela: 12 leituras (2 dias de decisões) + 1 leitura da caixa (o que já foi publicado não se
 *   republica) + 1 publicação por mensagem nova = 21 (STEP_COSTS.registry); a leitura de um bloco a mais de notas (60 por bloco)
 *   sai do mesmo teto de 8, então o custo não passa de 21;
 * - notas propostas por passo: as gravações são em lote (16 requisições qualquer que seja o volume); o teto limita o corpo;
 * - notas que quebraram na conferência e são marcadas por passo: 1 update por nota = 5 (STEP_COSTS.checkFailures).
 */
export const DUPLICATES_PER_STEP = 9;
export const REGISTRY_MESSAGES_PER_STEP = 8;
export const PROPOSALS_PER_STEP = 40;
export const CHECK_FAILURE_MARKS_PER_STEP = 5;
export const ENGINE_LIMITS = { decisionLimit: 2, clefLimit: 1 } as const;

/**
 * #356 AC-4 Liga os passos ao Supabase e ao Worker. A camada API monta, por rodada, um medidor (cron/round-meter.ts, o contador da
 * #311) e passa aqui o `rest` feito com o fetch dele, o env dele (`meter.env`, com o ai contado) e o fetch dele: o Claude usa esse
 * fetch, e assim todo fetch da rodada, o das portas inclusive, é contado.
 */
export function supabaseRoundWork(
  rest: SupabaseRest,
  env: Env,
  fetch?: FetchFn,
  // #356 AC-2 Só a rodada manual os passa (cron/manual-window.ts): o prazo de uma pergunta ao Claude e o teto do prazo do Clef.
  { claudeTimeoutMs, clefTimeoutCapMs }: { readonly claudeTimeoutMs?: number; readonly clefTimeoutCapMs?: number } = {},
): RoundWork {
  const failedSteps = new Set<string>();
  const fail: Fail = (step) => void failedSteps.add(step);
  const { captureDeps, registryCorrections } = supabaseConnectors(rest);
  // #356 AC-4 As notas que quebraram na conferência: a captura as guarda e o passo seguinte as marca (dentro da mesma rodada).
  let checkFailures: readonly CheckFailure[] = [];
  const deps = (descriptions: DescriptionSuggester | undefined): CaptureDeps => (descriptions ? { ...captureDeps, descriptions } : captureDeps);
  return {
    capture: async () => {
      const descriptions: DescriptionSuggester | undefined = await storedSuggestions(rest, fail);
      const { failures, ...result } = await captureInvoices(deps(descriptions), { markFailures: false });
      checkFailures = failures ?? [];
      console.log(`cron: notas vistas ${result.seen}, novas ${result.inserted}, conferidas ${result.checked}, com erro ${result.failed}`);
      return result;
    },
    markCheckFailures: () => markCheckFailures(captureDeps, checkFailures, CHECK_FAILURE_MARKS_PER_STEP),
    reportUnreconciledReceipts: async () => {
      const unreconciled = await findUnreconciledReceipts(captureDeps);
      console.log(
        `cron: recebimentos sem nota [${unreconciled.noKey.join(', ')}], com chave sem nota [${unreconciled.keyWithoutInvoice.join(', ')}]`,
      );
    },
    propose: async () => {
      const r = await proposeChecked({
        rest,
        purchasing: captureDeps.purchasing,
        registry: captureDeps.registry,
        wms: captureDeps.wms,
        limit: PROPOSALS_PER_STEP,
      });
      return { proposed: r.proposed, approvedByRule: r.approvedByRule };
    },
    publishRegistry: (from, to) => publishApproved(rest, registryCorrections, fail, lastDaysUtc(new Date(), REGISTRY_WINDOW_DAYS).slice(from, to), REGISTRY_MESSAGES_PER_STEP),
    publishDock: () => publishDock(rest, fail, DOCK_PER_STEP),
    publishStore: () => publishStoreActions(rest, fail, STORE_PER_STEP),
    publishReturns: async () => {
      const published = await publishReturnNotes(rest, fail, RETURN_NOTES_PER_STEP);
      console.log(`cron: devoluções publicadas ${published}`);
      return published;
    },
    blockDuplicates: () => blockDuplicateTitles(rest, undefined, DUPLICATES_PER_STEP),
    markOverdueSupplierRequests: () => markOverdueRequests(rest, fail),
    claudeTasks: tasksFor(rest).map((t) => t.name),
    claudeTask: async (name, deadline) => {
      const round = await runClaudeRound(rest, env, { only: [name], deadline, ...(fetch ? { fetch } : {}), ...(claudeTimeoutMs === undefined ? {} : { timeoutMs: claudeTimeoutMs }) });
      // #311 A tarefa que falhou ou desistiu conta como passo falho do Claude, como no tick.
      if (round.failedTasks.length > 0) fail('claude');
    },
    engine: () => runEngine(rest, env, fail, { ...ENGINE_LIMITS, ...(clefTimeoutCapMs === undefined ? {} : { clefTimeoutCapMs }) }),
    // #349 O passo só entra na lista com o modo ligado (buildRoundSteps), então `enabled` é sempre true aqui.
    captureDemoNotes: () => runDemoNotesRound({ rest, enabled: true, now: new Date() }),
    failedSteps: () => [...failedSteps],
  };
}
