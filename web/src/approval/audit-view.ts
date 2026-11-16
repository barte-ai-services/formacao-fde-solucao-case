import type { ApprovalLevel, Classification } from "../api/contract";
import type { AuditBlockView } from "./AuditBlock";
import { ACTION_LABEL, LEVEL_LABEL, type DockActionKind } from "./labels";
import { texts } from "../texts";

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

const CLOCK = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "America/Sao_Paulo" });
/** #231 "14:32": a hora de Brasília, onde a Já Chegou paga. */
const clockOf = (iso: string): string => CLOCK.format(new Date(iso));

type Field = "classification" | "dockAction" | "routing";
const ORDER: readonly Field[] = ["classification", "dockAction", "routing"];

/** #231 Uma frase por campo que difere, na ordem do wireframe; o "não X" vem da proposta e o encaminhamento não o tem. */
function phrase(field: Field, audit: Extract<AuditDto, { status: "auditada" }>, proposal: AuditProposal): string {
  const t = texts.auditor.differs;
  if (field === "classification") return t.classification(audit.classification, proposal.classification);
  if (field === "dockAction") return t.dockAction(ACTION_LABEL[audit.dockAction.kind], ACTION_LABEL[proposal.dockAction.kind]);
  return t.routing(LEVEL_LABEL[audit.routing]);
}

/** #231 A auditoria (ou a falta dela) no modelo de visão do bloco "Agente auditor". */
export function auditBlockView(audit: AuditDto | null, proposal: AuditProposal): AuditBlockView {
  if (audit === null) return { kind: "pending" };
  if (audit.status === "nao_auditada") return { kind: "not-audited", reason: texts.auditor.notAuditedReason[audit.reason] };
  const { agreement } = audit;
  const verdict = agreement.agrees
    ? texts.auditor.agrees
    : texts.auditor.disagrees(ORDER.filter((f) => agreement.differs.includes(f)).map((f) => phrase(f, audit, proposal)).join(" · "));
  return {
    kind: "audited",
    tone: agreement.agrees ? "positive" : "alert",
    verdict,
    raised: audit.raisedLevel === null ? null : texts.auditor.raisedTo(LEVEL_LABEL[audit.raisedLevel]),
    injection: audit.injectionFlag,
    justification: audit.justification,
    footer: texts.auditor.auditedBy(audit.model, clockOf(audit.auditedAt)),
  };
}
