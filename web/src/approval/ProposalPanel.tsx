/**
 * #63 A proposta de uma nota: ação na doca, nível, valor em risco, a evidência de cada divergência
 * (AC-12) e a decisão de quem pode aprovar (AC-7 a AC-9). Usada na gaveta da fila e na rota própria.
 */
import { useState, type JSX } from "react";
import { Alert } from "barte-design-system";
import { Block, DataList, DecisionForm, StatusBadge } from "@barte-ai-services/barte-ui-kit";
import { ApiError } from "../api/client";
import { approvalApi, type DecisionResultDto, type ProposalDetailDto } from "../api/approval";
import type { PartialLineDto } from "../api/contract";
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

type Choice = DockActionKind;
/** #134 A validação local do receber parcial: o texto vai direto para quem decide. */
class PartialInputError extends Error {}

type Disposition = "segurar" | "devolver";
type PartialInput = { amount: string; disposition: Disposition };

const qtyText = (q: { amount: number; unit: string }): string => `${q.amount} ${q.unit}`;

export function ProposalPanel({
  proposal,
  onDecided,
  afterCount = false,
}: {
  proposal: ProposalDetailDto;
  onDecided?: (result: DecisionResultDto) => void;
  /** #134 Depois da contagem (2ª entrega) o verbo é "Confirmar recebimento"; antes da doca, "Receber". */
  afterCount?: boolean;
}): JSX.Element {
  const [decided, setDecided] = useState<DecisionResultDto | null>(null);
  const [partial, setPartial] = useState<Record<string, PartialInput>>({});
  const proposed = proposal.dockAction.kind;
  const labels = afterCount ? texts.proposalPanel.form.afterCountOptions : texts.proposalPanel.form.options;
  const tones: Record<Choice, "positive" | "waiting" | "negative"> = { receber: "positive", receber_parcial: "waiting", recusar: "negative" };

  /** #134 As linhas do receber parcial que a pessoa informou: o item, a quantidade na unidade da nota e o destino. */
  function typedLines(): PartialLineDto[] {
    return proposal.items.flatMap((i) => {
      const key = i.sku ?? i.supplierCode;
      const input = partial[key];
      const amount = Number(input?.amount);
      if (!input || !Number.isFinite(amount) || amount <= 0) return [];
      return [{ sku: key, quantity: { amount, unit: i.quantity.unit }, disposition: input.disposition }];
    });
  }

  async function submit({ value, note }: { value: Choice; note: string }) {
    let result: DecisionResultDto;
    if (value === proposed) {
      result = await approvalApi.approve(proposal.invoiceAccessKey);
    } else if (value === "receber_parcial") {
      const lines = typedLines();
      if (lines.length === 0) throw new PartialInputError(texts.proposalPanel.partial.missingLines);
      result = await approvalApi.alter(proposal.invoiceAccessKey, { kind: "receber_parcial", lines }, note);
    } else {
      result = await approvalApi.alter(proposal.invoiceAccessKey, { kind: value }, note);
    }
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
              <StatusBadge size="sm" tone={ACTION_TONE[proposed]}>
                {ACTION_LABEL[proposed]}
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
      {proposal.dockAction.kind === "receber_parcial" ? <PartialItems proposal={proposal} lines={proposal.dockAction.lines} /> : null}
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
        <>
          {proposed !== "receber_parcial" ? (
            <Block title={texts.proposalPanel.partial.inputTitle} size="sm">
              <p>{texts.proposalPanel.partial.inputHelp}</p>
              {proposal.items
                .map((i) => {
                  const sku = i.sku ?? i.supplierCode;
                  const input = partial[sku] ?? { amount: "", disposition: "segurar" as Disposition };
                  return (
                    <div key={sku} className="pagar-partial-row">
                      <span>{`${i.description} (${qtyText(i.quantity)})`}</span>
                      <input
                        type="number"
                        min={0}
                        max={i.quantity.amount}
                        aria-label={texts.proposalPanel.partial.qtyLabel(i.description)}
                        value={input.amount}
                        onChange={(e) => setPartial({ ...partial, [sku]: { ...input, amount: e.target.value } })}
                      />
                      <select
                        aria-label={texts.proposalPanel.partial.dispositionLabel(i.description)}
                        value={input.disposition}
                        onChange={(e) => setPartial({ ...partial, [sku]: { ...input, disposition: e.target.value as Disposition } })}
                      >
                        <option value="segurar">{texts.proposalPanel.partial.hold}</option>
                        <option value="devolver">{texts.proposalPanel.partial.giveBack}</option>
                      </select>
                    </div>
                  );
                })}
            </Block>
          ) : null}
          <DecisionForm<Choice>
            title={texts.proposalPanel.form.title}
            description={texts.proposalPanel.form.description}
            minNoteLength={10}
            onSubmit={(d) => submit(d).catch((e: unknown) => Promise.reject(e instanceof PartialInputError ? e : new Error(decisionError(e))))}
            texts={{ noteLabel: texts.proposalPanel.form.note, submit: texts.proposalPanel.form.submit, done: null }}
            options={(["receber", "receber_parcial", "recusar"] as const).map((k) => ({
              value: k,
              label: labels[k],
              tone: tones[k],
              ...(k === proposed ? { description: texts.proposalPanel.form.proposed } : { noteRequired: true }),
            }))}
          />
        </>
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

/** #134 O receber parcial item a item: o que entra e o que fica segurado ou volta, na unidade da nota. */
function PartialItems({ proposal, lines }: { proposal: ProposalDetailDto; lines: readonly PartialLineDto[] }): JSX.Element {
  const t = texts.proposalPanel.partial;
  return (
    <Block title={t.title} size="sm">
      <DataList
        divided
        items={proposal.items.map((i) => {
          const line = lines.find((l) => l.sku === (i.sku ?? i.supplierCode));
          const enters = line && line.quantity.unit === i.quantity.unit ? { amount: i.quantity.amount - line.quantity.amount, unit: i.quantity.unit } : i.quantity;
          const outcome = line ? (line.disposition === "segurar" ? t.holds : t.returns)(qtyText(line.quantity)) : null;
          return {
            key: i.sku ?? i.supplierCode,
            label: i.description,
            value: [t.enters(qtyText(line ? enters : i.quantity)), outcome].filter(Boolean).join(" · "),
          };
        })}
      />
    </Block>
  );
}
