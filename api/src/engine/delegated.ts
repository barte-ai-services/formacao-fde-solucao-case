// #42 O motor de decisão em modo delegado (épico #149): com a delegação do analista ligada, aprova sozinho a E4 de
// #42 até R$ 20 mil quando a regra fecha a conta ou o Clef tem a confiança do limite, pelo mesmo caminho da
// #42 aprovação da pessoa. Desligada, a rodada é a do modo sombra (#41), sem mudança nenhuma.
import { AlreadyDecidedError, EngineApprovalRefusedError, type ApprovalStore, type CaseFile } from '../approval/store.js';
import { SupabaseRestError } from '../connectors/supabase-rest.js';
import { approveByEngine } from '../domain/approval.js';
import { DomainError } from '../domain/errors.js';
import { askClef, exclusionOf, isCandidate, screen } from './cascade.js';
import type { EngineDecision, EngineSettings } from './decision.js';
import { CLEF_ROUND_LIMIT, runShadowRound, type ShadowDeps, type ShadowRound } from './run.js';

/** #42 O nível em que o motor aprova nesta história (linha 5 da régua). */
export const DELEGATED_LEVEL = 'analista';

/**
 * #42 Propostas decididas por rodada no modo delegado. Cada uma grava a decisão e, quando aprova, relê a proposta
 * e grava a aprovação pelo caminho da pessoa (perto de uma dezena de subrequests). O Cron tem um teto de
 * subrequests por invocação e o motor é periférico: o que passar do teto fica para a próxima rodada, sem linha.
 */
export const DELEGATED_ROUND_LIMIT = 10;

export type DelegatedRound = {
  /** #42 Decisões da cascata gravadas nesta rodada com `mode = delegated`. */
  readonly evaluated: number;
  /** #42 Propostas que o motor aprovou: a aprovação gravada em approvals. É o `engine_approved` da rodada. */
  readonly approved: number;
  /**
   * #42 Decisões `approve` gravadas que não viraram aprovação porque a pessoa decidiu antes, outra rodada aprovou,
   * a proposta mudou ou a delegação foi desligada no meio: a proposta fica com a pessoa.
   */
  readonly keptWithPerson: number;
  /** #42 AC-2 Pendências por confiança abaixo do limite, com a recomendação do motor. */
  readonly belowConfidence: number;
  readonly clefCalls: number;
  readonly clefFailed: number;
  /** #42 Propostas que ficaram para a próxima rodada, pelo teto de decisões ou de chamadas ao Clef. */
  readonly deferred: number;
  /**
   * #42 Aprovações recusadas por erro de programação (a aprovação não bate com a decisão) ou que falharam ao
   * gravar; e decisões que não foram gravadas. A rodada registra e segue com as outras propostas.
   */
  readonly errors: number;
  /** #42 A classe do primeiro desses erros, para o log; nulo quando não houve. */
  readonly firstError: string | null;
};

export type DelegatedDeps = Omit<ShadowDeps, 'approvals'> & {
  /** #42 A leitura da fila, a releitura da proposta na hora de aprovar e a gravação da aprovação. */
  readonly approvals: Pick<ApprovalStore, 'listAwaiting' | 'find' | 'saveDecision' | 'reread'>;
  /** #42 O dia (AAAA-MM-DD, Brasília) da aprovação, o mesmo `decided_on` da aprovação da pessoa. */
  readonly today: () => string;
  /** #42 Teto de propostas decididas na rodada delegada; padrão `DELEGATED_ROUND_LIMIT`. */
  readonly decisionLimit?: number;
  /**
   * #351 O modo demonstração (demo_settings.enabled, #348), lido pela rodada. Ligado, a delegação do analista liga;
   * desligado, volta ao valor de antes. Ausente, nada muda. Se a leitura falha, a delegação fica como está.
   */
  readonly demoMode?: () => Promise<boolean>;
};

/** #42 A rodada do Cron: a sombra com a delegação desligada, a delegada com ela ligada. */
export type EngineRound = ({ readonly mode: 'shadow' } & ShadowRound) | ({ readonly mode: 'delegated' } & DelegatedRound);

const errorName = (error: unknown): string => {
  if (error instanceof SupabaseRestError) return `${error.name} HTTP ${error.status}`;
  return error instanceof Error ? error.name : 'Error';
};

/**
 * #42 AC-5 A delegação liga e desliga por nível no banco (engine_settings), sem deploy, e vale na rodada seguinte.
 * Desligada, roda o modo sombra da #41 exatamente como era: nada em approvals. Ligada, roda o modo delegado.
 *
 * Decisão sobre a medição com a delegação ligada: a rodada delegada não grava medição (`benchmark`) nem a sombra.
 * - A sombra existe para medir o motor antes de ele aprovar (AC-6). Ligada a delegação, a proposta que o motor
 *   aprova não passa mais pela pessoa: não há decisão da pessoa contra a qual medir, e manter a sombra só gastaria
 *   uma segunda chamada ao Clef por proposta no mesmo teto de chamadas (e de subrequests) da rodada.
 * - A medição ao lado da regra (`benchmark`) também fica de fora: com a regra aprovando, o Clef não muda o que
 *   acontece, e a chamada tomaria o lugar de uma proposta que só o Clef decide.
 * O relatório de acerto continua sobre `mode = shadow` (ver `agreementReport`); para medir de novo, desliga-se a
 * delegação e a sombra volta a gravar.
 */
export async function runEngineRound(deps: DelegatedDeps): Promise<EngineRound> {
  const settings = await followDemoMode(deps, await deps.store.settings(DELEGATED_LEVEL));
  if (!settings.delegationEnabled) return { mode: 'shadow', ...(await runShadowRound(deps)) };
  return { mode: 'delegated', ...(await runDelegatedRound(deps, settings)) };
}

/**
 * #351 A delegação do analista segue o modo demonstração. Ligado: liga e guarda o valor de antes (uma vez). Desligado:
 * devolve esse valor e limpa o guardado. A régua não muda: o motor só aprova o que `screen` deixa passar (E4 do
 * analista), então diretoria e bloqueio continuam com a pessoa. Escreve só quando o modo muda (uma chamada).
 */
async function followDemoMode(deps: DelegatedDeps, settings: EngineSettings): Promise<EngineSettings> {
  if (!deps.demoMode) return settings;
  let demo: boolean;
  try {
    demo = await deps.demoMode();
  } catch (error) {
    // #351 Falha fechada: sem o modo, a rodada nunca amplia a delegação; com o modo já ligado antes, vale o valor de antes.
    const before = settings.delegationBeforeDemo ?? null;
    console.log(`cron: modo demonstração ilegível (${errorName(error)}); delegação do analista mantida em ${before ?? settings.delegationEnabled}`);
    return before === null ? settings : { ...settings, delegationEnabled: before };
  }
  const before = settings.delegationBeforeDemo ?? null;
  if (demo && before === null) {
    await deps.store.setDelegation(settings.level, true, settings.delegationEnabled);
    console.log(`cron: modo demonstração ligou a delegação do analista (antes: ${settings.delegationEnabled})`);
    return { ...settings, delegationEnabled: true, delegationBeforeDemo: settings.delegationEnabled };
  }
  if (!demo && before !== null) {
    await deps.store.setDelegation(settings.level, before, null);
    console.log(`cron: modo demonstração devolveu a delegação do analista a ${before}`);
    return { ...settings, delegationEnabled: before, delegationBeforeDemo: null };
  }
  return settings;
}

/**
 * #42 AC-2 Aplica o limite à resposta do Clef: abaixo dele a proposta fica com a pessoa (`below_confidence`), com
 * a recomendação do Clef e o porquê. No limite ou acima, a resposta vale como veio: `approve` vira aprovação;
 * `refuse` fica gravado e a proposta segue com a pessoa (o motor nunca recusa sozinho). A regra e a falha do
 * Clef não têm confiança e passam sem mudança.
 */
export function applyThreshold(decision: EngineDecision, threshold: number): EngineDecision {
  if (decision.decidedBy !== 'clef' || decision.confidence === null || decision.outcome === 'pending') return decision;
  if (decision.confidence >= threshold) return decision;
  const recommendation = decision.outcome;
  const verb = recommendation === 'approve' ? 'aprovar' : 'recusar';
  return {
    ...decision,
    outcome: 'pending',
    pendingReason: 'below_confidence',
    recommendation,
    reason: `Confiança ${decision.confidence} abaixo do limite ${threshold}: o motor recomenda ${verb} e deixa com a pessoa. ${decision.reason}`,
  };
}

type Approval = 'approved' | 'person' | { readonly error: string };

/**
 * #42 AC-1 e AC-4 A aprovação do motor, pelo mesmo caminho da pessoa (`approve()` e `saveDecision`): a proposta
 * é relida agora, e só é aprovada se ainda aguarda, sem aprovação gravada e sem cair numa exclusão. A pessoa que
 * decidiu antes (ou a outra rodada) ganha: o motor não decide. A delegação desligada no meio também deixa com a
 * pessoa. O erro de programação (a aprovação não bate com a decisão) é devolvido para a rodada registrar.
 */
async function approveAsEngine(
  deps: DelegatedDeps,
  key: string,
  decision: EngineDecision,
  decisionId: number,
  // #371 A proposta que o lote já conferiu (`approvals.reread`, na versão lida): sem ela, relê aqui, nota a nota, como antes.
  checked: CaseFile | null = null,
): Promise<Approval> {
  try {
    const current = checked ?? (await deps.approvals.find(key));
    if (!current || !stillAwaiting(current)) return 'person';
    const approval = approveByEngine(
      current.invoice,
      current.proposal,
      current.title,
      deps.today(),
      { decisionId, confidence: decision.confidence, modelVersion: decision.modelVersion },
      { paymentBlocked: current.supplierBlocked },
    );
    await deps.approvals.saveDecision({ ...current, approval });
    return 'approved';
  } catch (error) {
    if (error instanceof AlreadyDecidedError) return 'person';
    if (error instanceof EngineApprovalRefusedError && error.reason === 'delegation_off') return 'person';
    if (error instanceof EngineApprovalRefusedError || !(error instanceof DomainError)) return { error: errorName(error) };
    // #42 A transição que não vale mais (a proposta mudou entre a leitura e a aprovação) fica com a pessoa.
    return 'person';
  }
}

/** #42 A proposta de agora ainda é do motor: aguarda a pessoa, sem aprovação gravada e sem exclusão. */
function stillAwaiting(file: CaseFile): boolean {
  return isCandidate(file) && exclusionOf(file) === null;
}

/**
 * #42 AC-1, AC-2 e AC-3 A rodada delegada. Para cada candidata ainda sem decisão da cascata no modo delegado:
 * - exclusões primeiro (AC-3: diretoria e bloqueio são `level_not_delegable`; o resto fora da E4 até R$ 20 mil do
 *   analista, `outside_criteria`): fica com a pessoa e nunca chega ao Clef;
 * - a regra que fecha a conta aprova (`decided_by = rule`, confiança nula, versão `regra-e4-v1`);
 * - senão, o Clef decide, até o teto de chamadas por rodada: no limite ou acima com `approve`, aprova; abaixo,
 *   `below_confidence` com a recomendação; a falha do Clef fica com a pessoa (`clef_failed`, com a classe do erro
 *   e a latência, como na #41).
 * Até `DELEGATED_ROUND_LIMIT` propostas por rodada; o resto fica para a próxima. A decisão é gravada antes da
 * aprovação, que a cita (o banco confere que batem). A decisão `approve` gravada sem
 * aprovação é a que ficou com a pessoa.
 *
 * A falha do Clef no modo delegado não volta ao Clef: a cascata gravada é uma por proposta e modo, e decisão do
 * dono é que a falha deixa a proposta com a pessoa. O retorno das falhas fica com o modo sombra.
 */
export async function runDelegatedRound(deps: DelegatedDeps, settings: EngineSettings): Promise<DelegatedRound> {
  const mode = 'delegated';
  const limit = deps.clefLimit ?? CLEF_ROUND_LIMIT;
  const decisionLimit = deps.decisionLimit ?? DELEGATED_ROUND_LIMIT;
  const counts = { evaluated: 0, approved: 0, keptWithPerson: 0, belowConfidence: 0, clefCalls: 0, clefFailed: 0, deferred: 0, errors: 0 };
  let firstError: string | null = null;
  const fail = (name: string) => {
    counts.errors += 1;
    firstError ??= name;
  };

  const awaiting = (await deps.approvals.listAwaiting()).filter(isCandidate);
  const decided: Decided[] = [];
  if (awaiting.length > 0) {
    // #371 Só a cascata importa na rodada delegada: uma leitura das decisões em vez de duas.
    const seen = await deps.store.evaluated(mode, deps.clef.modelVersion, { cascadeOnly: true });
    for (const file of awaiting) {
      if (seen.cascade.has(file.invoice.accessKey)) continue;
      if (decided.length >= decisionLimit) {
        counts.deferred += 1;
        continue;
      }
      let decision = screen(file, mode);
      if (!decision) {
        if (counts.clefCalls >= limit) {
          counts.deferred += 1;
          continue;
        }
        counts.clefCalls += 1;
        const answer = await askClef(file, { clef: deps.clef, settings, mode, now: deps.now });
        if (answer.pendingReason === 'clef_failed') counts.clefFailed += 1;
        decision = applyThreshold(answer, settings.confidenceThreshold);
      }
      decided.push({ file, decision });
    }
  }
  // #371 As decisões da rodada gravam juntas (uma leitura e uma gravação), e cada uma falha sozinha só se o lote falhar.
  const ids = await recordAll(deps.store, decided.map((d) => d.decision), fail);
  const toApprove: Approvable[] = [];
  decided.forEach(({ file, decision }, i) => {
    const decisionId = ids[i] ?? null;
    // #42 Outra rodada gravou a decisão antes (ou a gravação falhou): é a outra que decide esta proposta.
    if (decisionId === null) return;
    counts.evaluated += 1;
    if (decision.pendingReason === 'below_confidence') counts.belowConfidence += 1;
    if (decision.outcome === 'approve') toApprove.push({ file, decision, decisionId });
  });
  const stillAwaiting = await rereadBatch(deps, toApprove.map((a) => a.file));
  for (const { file, decision, decisionId } of toApprove) {
    const key = file.invoice.accessKey;
    // #371 Com a releitura do lote, a nota que a pessoa decidiu, ou que mudou de versão, fica com ela sem tocar no banco.
    const result = stillAwaiting && !stillAwaiting.has(key) ? 'person' : await approveAsEngine(deps, key, decision, decisionId, stillAwaiting ? file : null);
    if (result === 'approved') counts.approved += 1;
    else if (result === 'person') counts.keptWithPerson += 1;
    else {
      fail(result.error);
      console.error(`#42 motor: aprovação da nota ${key} não gravada (${result.error}); fica com a pessoa`);
    }
  }
  return { ...counts, firstError };
}

type Decided = { readonly file: CaseFile; readonly decision: EngineDecision };
type Approvable = Decided & { readonly decisionId: number };

/**
 * #371 Grava as decisões e devolve o id de cada uma (nulo onde outra rodada gravou antes ou onde a gravação falhou). Em lote, quando a loja o tem;
 * se o lote falha, uma a uma, para que cada decisão falhe sozinha, como antes do lote (#42).
 */
async function recordAll(store: DelegatedDeps['store'], decisions: readonly EngineDecision[], fail: (name: string) => void): Promise<(number | null)[]> {
  if (decisions.length === 0) return [];
  if (store.recordMany) {
    try {
      return await store.recordMany(decisions);
    } catch {
      // #371 O lote falhou (a classe do erro é contada por decisão abaixo): grava uma a uma.
    }
  }
  const ids: (number | null)[] = [];
  for (const decision of decisions) {
    try {
      ids.push(await store.recordWithId(decision));
    } catch (error) {
      fail(errorName(error));
      ids.push(null);
    }
  }
  return ids;
}

/** #371 As chaves que seguem aguardando, relidas numa vez só; nulo quando a porta não relê em lote (a releitura é nota a nota) ou a releitura falhou. */
async function rereadBatch(deps: DelegatedDeps, files: readonly CaseFile[]): Promise<ReadonlySet<string> | null> {
  if (files.length === 0 || !deps.approvals.reread) return null;
  try {
    return await deps.approvals.reread(files);
  } catch {
    return null;
  }
}
