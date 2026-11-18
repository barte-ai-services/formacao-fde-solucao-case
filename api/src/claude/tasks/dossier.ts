// #38: as peças comuns do dossiê da proposta encaminhada a uma pessoa — o pedido ao Claude, a validação
// da resposta e o motivo do erro. Quem chama é o evento (dossier/event.ts, reativo, sem rodada agendada) e
// o pedido na gaveta (dossier/on-demand.ts, #130). Nenhum dos dois decide nem grava a ação na doca: o Claude
// explica, e a gaveta lê e confere cada número contra o banco na hora de mostrar (readDossier, #68).
import { ClaudeError } from '../client.js';
import { buildDossierPrompt } from '../../dossier/prompt.js';
import { buildFactCatalog, DOSSIER_OUTPUT_SCHEMA, type CheckContext, type InvoiceView } from '../../domain/index.js';
import type { CaseFile } from '../../approval/store.js';

/** #38 O que a pergunta precisa, já serializado: o system, o prompt com os dados e o schema da saída. */
export type DossierInput = { system: string; prompt: string; schema: Record<string, unknown> };

/** #38 A saída crua do Claude, no formato de DOSSIER_OUTPUT_SCHEMA. Os números ainda não foram conferidos. */
export type DossierOutput = {
  summary: string;
  divergences: { classification: string; what_diverges: string; evidence: string[] }[];
  supplier_history: string;
};

/** #38 AC-1: só a proposta que espera uma pessoa ganha dossiê. A regra aprova o resto sozinha. */
export function needsDossier(file: Pick<CaseFile, 'proposal' | 'route' | 'approval'>): boolean {
  return file.approval === null && file.proposal.state === 'aguardando_aprovacao' && file.route.level !== 'regra';
}

/** #38 Monta o pedido do dossiê de uma nota: o mesmo catálogo de fatos que a gaveta usa para conferir. */
export function dossierRequest(invoice: InvoiceView, ctx: CheckContext): DossierInput {
  const catalog = buildFactCatalog(invoice, ctx);
  const { system, prompt } = buildDossierPrompt(catalog, invoice.divergences);
  return { system, prompt, schema: DOSSIER_OUTPUT_SCHEMA as unknown as Record<string, unknown> };
}

const isStr = (v: unknown): v is string => typeof v === 'string';

/** #38 AC-2: a resposta fora do schema não é gravada como ok; quem chama registra a linha de erro. */
export function parseDossierOutput(raw: unknown): DossierOutput | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isStr(r.summary) || !isStr(r.supplier_history) || !Array.isArray(r.divergences)) return null;
  const divergences: DossierOutput['divergences'] = [];
  for (const d of r.divergences) {
    if (typeof d !== 'object' || d === null) return null;
    const x = d as Record<string, unknown>;
    if (!isStr(x.classification) || !isStr(x.what_diverges) || !Array.isArray(x.evidence) || !x.evidence.every(isStr)) {
      return null;
    }
    divergences.push({ classification: x.classification, what_diverges: x.what_diverges, evidence: [...x.evidence] });
  }
  return { summary: r.summary, divergences, supplier_history: r.supplier_history };
}

/** #130 O motivo do erro na língua da gaveta: formato, prazo ou o resto (`claude_failed`). */
export type DossierFailureReason = 'claude_failed' | 'invalid_shape' | 'timeout';

/** #130 Do erro da chamada ao motivo gravado em claude_suggestions.reason. */
export function failureReason(error: unknown): DossierFailureReason {
  if (error instanceof ClaudeError && error.kind === 'format') return 'invalid_shape';
  if (error instanceof ClaudeError && error.kind === 'timeout') return 'timeout';
  return 'claude_failed';
}
