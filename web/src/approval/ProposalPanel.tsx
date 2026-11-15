/**
 * #63 A proposta de uma nota: ação na doca, nível, valor em risco, a evidência de cada divergência
 * (AC-12) e a decisão de quem pode aprovar (AC-7 a AC-9). Usada na gaveta da fila e na rota própria.
 */
import { useState } from "react";
import { Alert } from "barte-design-system";
import { Block, DataList, DecisionForm, StatusBadge } from "@barte-ai-services/barte-ui-kit";
import { ApiError } from "../api/client";
import { approvalApi, type DecisionResultDto, type ProposalDetailDto } from "../api/approval";
import { EvidenceView } from "../evidence";
import { ACTION_LABEL, ACTION_TONE, LEVEL_LABEL, LEVEL_TONE, type DockActionKind } from "./labels";

const STATE_LABEL: Record<ProposalDetailDto["state"], string> = {
  registrada: "Registrada",
  aguardando_aprovacao: "Aguardando aprovação",
  aprovada: "Aprovada",
  alterada: "Alterada",
};

/** O que a API recusou, em português para quem decide. */
export function decisionError(reason: unknown): string {
  if (reason instanceof ApiError) {
    if (reason.status === 403) return "Seu nível não aprova esta proposta.";
    if (reason.status === 409) return "Esta proposta já foi decidida por outra pessoa.";
    if (reason.status === 422) return "A decisão não foi aceita: confira a justificativa.";
  }
  return "Não consegui registrar a decisão agora. Tente de novo em um minuto.";
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
          Nível {LEVEL_LABEL[proposal.level]}
        </StatusBadge>
      </div>
      <DataList
        divided
        items={[
          {
            key: "acao",
            label: "Ação na doca proposta",
            value: (
              <StatusBadge size="sm" tone={ACTION_TONE[action]}>
                {ACTION_LABEL[action]}
              </StatusBadge>
            ),
          },
          { key: "risco", label: "Valor em risco", value: proposal.amountAtRisk.text, emphasis: true },
          { key: "valor", label: "Valor da nota", value: proposal.total.text },
          { key: "regua", label: "Por que este nível", value: `Linha ${proposal.line} da régua: ${proposal.reason}` },
          { key: "fornecedor", label: "Fornecedor", value: proposal.supplierId },
          { key: "destino", label: "Destino", value: proposal.store },
          { key: "justificativa", label: "Justificativa", value: proposal.justification },
          { key: "chave", label: "Chave de acesso", value: proposal.invoiceAccessKey, mono: true },
        ]}
      />
      <Block title="Evidência por divergência" size="sm">
        {proposal.divergences.length === 0 ? (
          <p>Nenhuma divergência: a nota confere com a ordem.</p>
        ) : (
          proposal.divergences.map((d, i) => <EvidenceView key={`${d.classification}-${i}`} divergence={d} />)
        )}
      </Block>
      {decided ?? proposal.approval ? (
        <Alert
          variant="success"
          title="Decisão registrada"
          description={`Ação final: ${ACTION_LABEL[(decided?.approval ?? proposal.approval)!.dockAction.kind as DockActionKind].toLowerCase()}. O título está ${(decided?.title.state ?? proposal.title.state).replaceAll("_", " ")}.`}
        />
      ) : proposal.canApprove ? (
        <DecisionForm<Choice>
          title="Sua decisão"
          description="Aprovar mantém a ação proposta. Alterar troca a ação e pede justificativa. A decisão é registrada uma vez."
          minNoteLength={10}
          onSubmit={(d) => submit(d).catch((e: unknown) => Promise.reject(new Error(decisionError(e))))}
          texts={{ noteLabel: "Justificativa", submit: "Registrar a decisão", done: null }}
          options={[
            { value: "aprovar", label: `Aprovar: ${ACTION_LABEL[action].toLowerCase()}`, tone: "positive" },
            ...others.map((k) => ({
              value: (k === "receber" ? "alterar_receber" : "alterar_recusar") as Choice,
              label: `Alterar para ${ACTION_LABEL[k].toLowerCase()}`,
              tone: "waiting" as const,
              noteRequired: true,
            })),
          ]}
        />
      ) : (
        <Alert
          variant="warning"
          title={`Esta proposta pede o nível ${LEVEL_LABEL[proposal.requiredApproverLevel].toLowerCase()} ou acima.`}
          description="Você vê a proposta, sem aprovar. Quem tem o nível encontra a proposta na fila."
        />
      )}
    </div>
  );
}
