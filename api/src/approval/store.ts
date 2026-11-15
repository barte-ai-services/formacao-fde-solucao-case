// #63 O que a fila de aprovação e a lista do dia leem e gravam: a nota, a proposta, o título e a aprovação.
import type { ApprovalLevel } from '../domain/approval-level.js';
import type { AuditedDockAction, AuditedField, AuditRefusal, NotAuditedReason } from '../domain/invoice-audit.js';
import type { Classification } from '../domain/classification.js';
import type { Approval } from '../domain/approval.js';
import type { ApprovalRoute } from '../domain/approval-policy.js';
import type { Invoice } from '../domain/invoice.js';
import type { Proposal } from '../domain/proposal.js';
import type { Title } from '../domain/title.js';

/** #230 AC-7 A auditoria corrente da nota (a linha mais recente de invoice_audits), como a API a lê. */
export type StoredAudit =
  | { readonly status: 'nao_auditada'; readonly reason: NotAuditedReason; readonly refusals: readonly AuditRefusal[] }
  | {
      readonly status: 'auditada';
      readonly classification: Classification;
      readonly dockAction: AuditedDockAction;
      readonly routing: ApprovalLevel;
      readonly justification: string;
      readonly amountAtRiskCents: number | null;
      readonly model: string;
      readonly auditedAt: string;
      /** #230 O que difere da proposta da regra; vazio = concorda. */
      readonly differs: readonly AuditedField[];
      readonly raisedLevel: ApprovalLevel | null;
      readonly injectionFlag: string | null;
      readonly refusals: readonly AuditRefusal[];
    };

/** O processo de uma nota na aprovação: tudo o que a proposta mostra e a decisão muda. */
export type CaseFile = {
  readonly invoice: Invoice;
  readonly proposal: Proposal;
  readonly title: Title;
  readonly route: ApprovalRoute;
  readonly approval: Approval | null;
  /** Regra 7 e decisão 9: se o fornecedor tem o pagamento bloqueado (linha 2 da régua). */
  readonly supplierBlocked: boolean;
  /** #230 AC-7 A auditoria da nota; null = ainda não auditada. Só `find` a carrega. */
  readonly audit?: StoredAudit | null;
};

export interface ApprovalStore {
  /** #63 AC-6: as propostas que aguardam uma pessoa. */
  listAwaiting(): Promise<CaseFile[]>;
  find(invoiceAccessKey: string): Promise<CaseFile | null>;
  /**
   * #63 Regra 8: grava a decisão uma vez só. Se a proposta já tem aprovação gravada, lança
   * `AlreadyDecidedError` e não muda nada (a corrida entre duas pessoas cai aqui). #42 Na aprovação do motor
   * (`approval.engine`), o banco ainda confere a decisão e a delegação: se recusa, lança
   * `EngineApprovalRefusedError` e não muda nada.
   */
  saveDecision(file: CaseFile & { readonly approval: Approval }): Promise<void>;
  /** #63 AC-13: os processos decididos no dia, com o título liberado ou reduzido na lista do dia. */
  listDecidedOn(day: string): Promise<CaseFile[]>;
}

export class AlreadyDecidedError extends Error {
  constructor(invoiceAccessKey: string) {
    super(`Proposta da nota ${invoiceAccessKey} já foi decidida`);
    this.name = 'AlreadyDecidedError';
  }
}

/**
 * #42 O banco recusou a aprovação do motor. `delegation_off`: a delegação do analista foi desligada depois de a
 * rodada começar (a proposta fica com a pessoa). `mismatch`: a aprovação não bate com a decisão gravada ou com a
 * proposta (erro de programação: a rodada registra e segue com as outras).
 */
export class EngineApprovalRefusedError extends Error {
  constructor(
    invoiceAccessKey: string,
    readonly reason: 'delegation_off' | 'mismatch',
  ) {
    super(`Aprovação do motor na nota ${invoiceAccessKey} recusada pelo banco (${reason})`);
    this.name = 'EngineApprovalRefusedError';
  }
}

/** #63 Loja em memória: a dos testes e a do Worker sem as credenciais do Supabase. Com elas, a loja é a das tabelas do domínio (#80). */
export class MemoryApprovalStore implements ApprovalStore {
  private readonly files = new Map<string, CaseFile>();

  constructor(files: readonly CaseFile[] = []) {
    for (const f of files) this.files.set(f.invoice.accessKey, f);
  }

  async listAwaiting(): Promise<CaseFile[]> {
    return [...this.files.values()].filter((f) => f.proposal.state === 'aguardando_aprovacao');
  }

  async find(invoiceAccessKey: string): Promise<CaseFile | null> {
    return this.files.get(invoiceAccessKey) ?? null;
  }

  async saveDecision(file: CaseFile & { readonly approval: Approval }): Promise<void> {
    const current = this.files.get(file.invoice.accessKey);
    if (current?.approval) throw new AlreadyDecidedError(file.invoice.accessKey);
    this.files.set(file.invoice.accessKey, file);
  }

  async listDecidedOn(day: string): Promise<CaseFile[]> {
    return [...this.files.values()].filter((f) => f.approval?.decidedOn === day);
  }
}
