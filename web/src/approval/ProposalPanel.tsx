/**
 * #63 A proposta de uma nota: ação na doca, nível, valor em risco, a evidência de cada divergência
 * (AC-12) e a decisão de quem pode aprovar (AC-7 a AC-9). Usada na gaveta da fila e na rota própria.
 */
import { useState } from "react";
import { Alert } from "barte-design-system";
import { Block, DataList, DecisionForm, StatusBadge } from "@barte-ai-services/barte-ui-kit";
import { ApiError } from "../api/client";
import { approvalApi, type DecisionResultDto, type ProposalDetailDto } from "../api/approval";
import { AccessKey } from "../components/AccessKey";
import { Dossier } from "../components/Dossier";
import { EvidenceView } from "../evidence";
import { ACTION_LABEL, ACTION_TONE, LEVEL_LABEL, LEVEL_TONE, type DockActionKind } from "./labels";
import { texts } from "../texts";

const STATE_LABEL: Record<ProposalDetailDto["state"], string> = texts.proposalPanel.state;

/** O que a API recusou, em português para quem decide. */
export function decisionError(reason: unknown): string {
  if (reason instanceof ApiError) {
    if (reason.status === 403) return texts.proposalPanel.errors.forbidden;
    if (reason.status === 409) return texts.proposalPanel.errors.conflict;
    if (reason.status === 422) return texts.proposalPanel.errors.unprocessable;
  }
  return texts.proposalPanel.errors.other;
}

type Choice = "aprovar" | "alterar_receber" | "alterar_recusar";

export function ProposalPanel({
  proposal,
  onDecided,
}: {
  proposal: ProposalDetailDto;
  onDecided?: (result: DecisionResultDto) => void;
}) {
  const [decided, setDecided] = useState<DecisionResultDto | null>(null);
  const action = proposal.dockAction.kind;
  const others = (["receber", "recusar"] as const).filter((k) => k !== action);

  async function submit({ value, note }: { value: Choice; note: string }) {
    const result =
      value === "aprovar"
        ? await approvalApi.approve(proposal.invoiceAccessKey)
        : await approvalApi.alter(proposal.invoiceAccessKey, { kind: value === "alterar_receber" ? "receber" : "recusar" }, note);
    setDecided(result);
    onDecided?.(result);
    return result;
  }

  return (
    <div className="pagar-proposal">
      <div className="pagar-badges">
        <StatusBadge tone={proposal.state === "aguardando_aprovacao" ? "waiting" : "positive"}>
          {STATE_LABEL[proposal.state]}
        </StatusBadge>
        <StatusBadge variant="soft" tone={LEVEL_TONE[proposal.level]}>
          {texts.proposalPanel.level(LEVEL_LABEL[proposal.level])}
        </StatusBadge>
      </div>
      <DataList
        divided
        items={[
          {
            key: "acao",
            label: texts.proposalPanel.rows.action,
            value: (
              <StatusBadge size="sm" tone={ACTION_TONE[action]}>
                {ACTION_LABEL[action]}
              </StatusBadge>
            ),
          },
          { key: "risco", label: texts.proposalPanel.rows.risk, value: proposal.amountAtRisk.text, emphasis: true },
          { key: "valor", label: texts.proposalPanel.rows.total, value: proposal.total.text },
          { key: "regua", label: texts.proposalPanel.rows.why, value: texts.proposalPanel.rows.whyValue(proposal.line, proposal.reason) },
          { key: "fornecedor", label: texts.proposalPanel.rows.supplier, value: proposal.supplierId },
          { key: "destino", label: texts.proposalPanel.rows.destination, value: proposal.store },
          { key: "justificativa", label: texts.proposalPanel.rows.justification, value: proposal.justification },
          { key: "chave", label: texts.proposalPanel.rows.accessKey, value: <AccessKey value={proposal.invoiceAccessKey} />, mono: true },
        ]}
      />
      <Block title={texts.proposalPanel.evidenceTitle} size="sm">
        {proposal.divergences.length === 0 ? (
          <p>{texts.proposalPanel.noDivergence}</p>
        ) : (
          proposal.divergences.map((d, i) => <EvidenceView key={`${d.classification}-${i}`} divergence={d} />)
        )}
      </Block>
      <Dossier dossier={proposal.dossier} />
      {decided ?? proposal.approval ? (
        <Alert
          variant="success"
          title={texts.proposalPanel.decidedTitle}
          description={texts.proposalPanel.decidedDescription(
            ACTION_LABEL[(decided?.approval ?? proposal.approval)!.dockAction.kind as DockActionKind].toLowerCase(),
            (decided?.title.state ?? proposal.title.state).replaceAll("_", " "),
          )}
        />
      ) : proposal.canApprove ? (
        <DecisionForm<Choice>
          title={texts.proposalPanel.form.title}
          description={texts.proposalPanel.form.description}
          minNoteLength={10}
          onSubmit={(d) => submit(d).catch((e: unknown) => Promise.reject(new Error(decisionError(e))))}
          texts={{ noteLabel: texts.proposalPanel.form.note, submit: texts.proposalPanel.form.submit, done: null }}
          options={[
            { value: "aprovar", label: texts.proposalPanel.form.approve(ACTION_LABEL[action].toLowerCase()), tone: "positive" },
            ...others.map((k) => ({
              value: (k === "receber" ? "alterar_receber" : "alterar_recusar") as Choice,
              label: texts.proposalPanel.form.change(ACTION_LABEL[k].toLowerCase()),
              tone: "waiting" as const,
              noteRequired: true,
            })),
          ]}
        />
      ) : (
        <Alert
          variant="warning"
          title={texts.proposalPanel.needsLevel(LEVEL_LABEL[proposal.requiredApproverLevel].toLowerCase())}
          description={texts.proposalPanel.needsLevelDescription}
        />
      )}
    </div>
  );
}
