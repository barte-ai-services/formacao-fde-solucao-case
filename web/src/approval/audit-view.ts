import type { ApprovalLevel, Classification } from "../api/contract";
import type { AuditBlockView } from "./AuditBlock";
import type { DockActionKind } from "./labels";

/** #231 A auditoria como a API a devolve (`auditView` em api/src/http/approval.ts): a camada de contrato a pendura na proposta. */
export type AuditDto =
  | { status: "nao_auditada"; reason: "claude_falhou" | "erro_de_tool" | "sem_auditoria"; refusals: readonly unknown[] }
  | {
      status: "auditada";
      classification: Classification;
      dockAction: { kind: DockActionKind };
      routing: ApprovalLevel;
      justification: string;
      amountAtRisk: { cents: number; text: string } | null;
      model: string;
      auditedAt: string;
      agreement: { agrees: true } | { agrees: false; differs: readonly ("classification" | "dockAction" | "routing")[] };
      raisedLevel: ApprovalLevel | null;
      injectionFlag: string | null;
      refusals: readonly unknown[];
    };

/** #231 Os valores da própria proposta, de onde vem o "não X" do veredito. */
export type AuditProposal = { classification: Classification; dockAction: { kind: DockActionKind } };

/** #231 A auditoria (ou a falta dela) no modelo de visão do bloco "Agente auditor". */
export function auditBlockView(_audit: AuditDto | null, _proposal: AuditProposal): AuditBlockView {
  return { kind: "pending" };
}
