import type { ApprovalLevel } from './approval-level.js';
import { APPROVAL_LEVELS, compareLevels } from './approval-level.js';
import type { Classification } from './classification.js';
import type { DockAction } from './dock-action.js';
import type { InvoiceView } from './invoice.js';
import type { ProposalState } from './proposal.js';

/**
 * #230 A auditoria da nota: a segunda opinião do agente auditor, gravada ao lado da proposta da regra.
 * Pura e síncrona. A auditoria nunca muda a ação da proposta e nunca aprova (#153/AC-4): ela só
 * pode subir o nível de uma proposta ainda à espera de aprovação, e nunca descê-lo (regra 7).
 */

/** #230 Os nomes da classificação que o auditor pode gravar: os do domínio, sem inventar outros. */
export const AUDIT_CLASSIFICATIONS: readonly Classification[] = Object.freeze([
  'MATCH', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'NAO_CATALOGADA',
] as const satisfies readonly Classification[]);

/** #230 A ação na doca que o auditor opina: o `kind` do DockAction (a ação da regra continua sendo a da proposta). */
export type AuditedDockAction = DockAction['kind'];
export const AUDIT_DOCK_ACTIONS: readonly AuditedDockAction[] = Object.freeze(['receber', 'receber_parcial', 'recusar'] as const);

const MIN_JUSTIFICATION_LINES = 2;
const MAX_JUSTIFICATION_LINES = 4;
const MAX_JUSTIFICATION_CHARS = 1200;

/** #230 O que fica gravado em `audit`. */
export type InvoiceAudit = {
  readonly classification: Classification;
  readonly dockAction: AuditedDockAction;
  readonly routing: ApprovalLevel;
  readonly justification: string;
  readonly amountAtRisk: { readonly cents: number } | null;
  readonly model: string;
  readonly auditedAt: string;
};

/** #230 O que o record_audit lê para validar: a nota auditada, o nível da regra e o que a gravação carimba. */
export type AuditContext = {
  readonly invoiceAccessKey: string;
  /** #230 Regra 7: o nível do encaminhamento da regra para esta nota é o mínimo do auditor. */
  readonly ruleLevel: ApprovalLevel;
  readonly invoiceTotalCents: number;
  readonly model: string;
  readonly auditedAt: string;
};

export type AuditRefusal =
  | { readonly refusal: 'invalid_field'; readonly field: string }
  | { readonly refusal: 'routing_below_regua'; readonly minimumLevel: ApprovalLevel };

export type AuditValidation =
  | { readonly ok: true; readonly audit: InvoiceAudit }
  | { readonly ok: false; readonly refusal: AuditRefusal };

const invalid = (field: string): AuditValidation => ({ ok: false, refusal: { refusal: 'invalid_field', field } });

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function justificationLines(value: unknown): number {
  if (typeof value !== 'string' || value.length > MAX_JUSTIFICATION_CHARS) return 0;
  return value.split('\n').filter((line) => line.trim() !== '').length;
}

/** #230 Valida a entrada do record_audit (#153): a auditoria, ou a recusa com o campo ou o nível mínimo. */
export function validateAudit(raw: unknown, ctx: AuditContext): AuditValidation {
  if (!isRecord(raw)) return invalid('input');
  if (raw.invoice_access_key !== ctx.invoiceAccessKey) return invalid('invoice_access_key');
  const classification = AUDIT_CLASSIFICATIONS.find((c) => c === raw.classification);
  if (classification === undefined) return invalid('classification');
  const dockAction = AUDIT_DOCK_ACTIONS.find((a) => a === raw.dock_action);
  if (dockAction === undefined) return invalid('dock_action');
  const routing = APPROVAL_LEVELS.find((l) => l === raw.routing);
  if (routing === undefined) return invalid('routing');
  const lines = justificationLines(raw.justification);
  if (lines < MIN_JUSTIFICATION_LINES || lines > MAX_JUSTIFICATION_LINES) return invalid('justification');
  let amountAtRisk: { cents: number } | null = null;
  if (raw.amount_at_risk !== null && raw.amount_at_risk !== undefined) {
    const cents = isRecord(raw.amount_at_risk) ? raw.amount_at_risk.cents : undefined;
    if (typeof cents !== 'number' || !Number.isSafeInteger(cents) || cents < 0 || cents > ctx.invoiceTotalCents) {
      return invalid('amount_at_risk');
    }
    amountAtRisk = { cents };
  }
  // #230 Regra 7: o auditor nunca encaminha abaixo da régua. Vem depois dos campos: a forma antes do mérito.
  if (compareLevels(routing, ctx.ruleLevel) < 0) {
    return { ok: false, refusal: { refusal: 'routing_below_regua', minimumLevel: ctx.ruleLevel } };
  }
  return {
    ok: true,
    audit: { classification, dockAction, routing, justification: raw.justification as string, amountAtRisk, model: ctx.model, auditedAt: ctx.auditedAt },
  };
}

/** #230 A proposta da regra como a auditoria a lê. */
export type RuleProposal = {
  readonly classification: Classification;
  readonly dockAction: AuditedDockAction;
  readonly level: ApprovalLevel;
  readonly state: ProposalState;
};

export type AuditedField = 'classification' | 'dock_action' | 'routing';

/** #230 `agrees`, ou o que difere entre a opinião do auditor e a proposta. */
export type Agreement = { readonly agrees: true } | { readonly agrees: false; readonly differs: readonly AuditedField[] };

/** #230 O que se grava com a nota auditada: a auditoria, a concordância, o nível elevado e o trecho de injeção. */
export type AuditResult = {
  readonly audit: InvoiceAudit;
  readonly agreement: Agreement;
  readonly raisedLevel: ApprovalLevel | null;
  readonly injectionFlag: string | null;
};

/**
 * #230 AC-3, AC-4: o efeito da auditoria na proposta. O nível sobe só quando o auditor encaminha acima
 * e a proposta ainda aguarda aprovação; proposta já aprovada pela régua (ou decidida) não muda, e a
 * discordância fica em `agreement` como alerta. Não há caminho para descer o nível, trocar a ação ou aprovar.
 */
export function applyAudit(audit: InvoiceAudit, proposal: RuleProposal, injectionFlag: string | null): AuditResult {
  const differs: AuditedField[] = [];
  if (audit.classification !== proposal.classification) differs.push('classification');
  if (audit.dockAction !== proposal.dockAction) differs.push('dock_action');
  if (audit.routing !== proposal.level) differs.push('routing');
  const agreement: Agreement = differs.length === 0 ? { agrees: true } : { agrees: false, differs };
  const raises = proposal.state === 'aguardando_aprovacao' && compareLevels(audit.routing, proposal.level) > 0;
  return { audit, agreement, raisedLevel: raises ? audit.routing : null, injectionFlag };
}

export type NotAuditedReason = 'claude_falhou' | 'erro_de_tool' | 'sem_auditoria';

/** #230 AC-6: a nota que ficou sem auditoria, com o motivo (um código fechado, nunca o texto do erro). */
export type NotAudited = { readonly audited: false; readonly reason: NotAuditedReason };

export const notAudited = (reason: NotAuditedReason): NotAudited => Object.freeze({ audited: false, reason });

// #230 AC-5 O detector de ordem ao agente é determinístico: não depende do modelo obedecer ou não.

/** #230 Tamanho máximo do trecho gravado em injection_flag. */
export const MAX_INJECTION_EXCERPT = 120;
const MAX_INJECTION_FLAG = 300;
const MAX_EXCERPTS = 3;

const ORDERS: readonly RegExp[] = [
  /\bregistr\w*\s+(\w+\s+){0,3}como\s+(match|conferid\w*|ok)\b/,
  /\bignor\w*\s+(\w+\s+){0,3}(regua|regras?|instrucoes|instrucao|auditor)\b/,
  /\bignor\w*\s+(\w+\s+){0,3}(previous|prior|above)\s+instructions?\b/,
  /\bdesconsider\w*/,
  /\baprove\b/,
  /\baprovar\s+(\w+\s+){0,2}(nota|pagamento)\b/,
  /\bclassifi(que|car)\s+(\w+\s+){0,2}como\b/,
  /\b(voce|agente|auditor)\s+(\w+\s+){0,3}(deve|precisa|tem que)\b/,
];

/** #230 Minúsculas e sem acento, com o mesmo tamanho do texto, para o trecho sair do original. */
function fold(text: string): string {
  return Array.from(text.normalize('NFC'), (c) => {
    const base = c.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    return base.length === c.length ? base : c;
  }).join('');
}

function excerptOf(text: string): string | null {
  const original = text.normalize('NFC');
  const folded = fold(original);
  if (folded.length !== original.length) return null;
  let first: RegExpExecArray | null = null;
  for (const order of ORDERS) {
    const found = order.exec(folded);
    if (found && (first === null || found.index < first.index)) first = found;
  }
  if (first === null) return null;
  const end = Math.min(first.index + first[0].length + 40, first.index + MAX_INJECTION_EXCERPT);
  return original.slice(first.index, end).trim();
}

/** #230 AC-5: o trecho de texto livre que dá ordem ao agente, ou null. Vários trechos saem separados por " | ". */
export function findInjection(texts: readonly string[]): string | null {
  const found: string[] = [];
  for (const text of texts) {
    const excerpt = excerptOf(text);
    if (excerpt !== null && !found.includes(excerpt)) found.push(excerpt);
    if (found.length === MAX_EXCERPTS) break;
  }
  return found.length === 0 ? null : found.join(' | ').slice(0, MAX_INJECTION_FLAG);
}

/** #230 AC-5: o texto livre da nota (descrições dos itens, código do fornecedor, pedido citado, canal). */
export function injectionFlagOf(invoice: Pick<InvoiceView, 'items' | 'purchaseOrderRef' | 'entryChannel'>): string | null {
  const texts = [
    ...invoice.items.flatMap((item) => [item.description, item.supplierCode]),
    invoice.purchaseOrderRef ?? '',
    invoice.entryChannel,
  ];
  return findInjection(texts.filter((t) => t !== ''));
}
