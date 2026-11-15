/**
 * #63 A proposta de uma nota: ação na doca, nível, valor em risco, a evidência de cada divergência
 * (AC-12) e a decisão de quem pode aprovar (AC-7 a AC-9). Usada na gaveta da fila e na rota própria.
 */
import { useState, type JSX } from "react";
import { Alert, Input, Select, Text } from "barte-design-system";
import { Block, DataList, DecisionForm, StatusBadge } from "@barte-ai-services/barte-ui-kit";
import { ApiError } from "../api/client";
import { approvalApi, type DecisionResultDto, type ProposalDetailDto } from "../api/approval";
import type { PartialLineDto } from "../api/contract";
import { AccessKey } from "../components/AccessKey";
import { Dossier } from "../components/Dossier";
import { EvidenceView } from "../evidence";
import { partialPrefill, type Disposition, type PartialInput } from "./partial-prefill";
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


const qtyText = (q: { amount: number; unit: string }): string => `${q.amount} ${q.unit}`;

/** #176 As classificações que já têm contagem conciliada na doca: depois dela o verbo é "Confirmar recebimento". */
const COUNTED: readonly string[] = ["E1", "E3"];

type Item = ProposalDetailDto["items"][number];
/** #176 Quantidade na unidade de estoque pelo fator do cadastro: a parte `parte` da linha, na mesma proporção. */
const stockText = (item: Item, amount: number): string | null =>
  item.stockQuantity && item.quantity.amount > 0 && item.stockQuantity.unit !== item.quantity.unit
    ? `${(item.stockQuantity.amount / item.quantity.amount) * amount} ${item.stockQuantity.unit}`
    : null;
/** #176 "12 CX" ou, quando há fator, "12 CX (48 UN)". */
const withStock = (item: Item, amount: number, say: (qty: string) => string): string => {
  const stock = stockText(item, amount);
  return say(stock ? `${amount} ${item.quantity.unit} (${stock})` : `${amount} ${item.quantity.unit}`);
};

export function ProposalPanel({
  proposal,
  onDecided,
  afterCount,
}: {
  proposal: ProposalDetailDto;
  onDecided?: (result: DecisionResultDto) => void;
  /** #134 Depois da contagem (2ª entrega) o verbo é "Confirmar recebimento"; antes da doca, "Receber". */
  afterCount?: boolean;
}): JSX.Element {
  const [decided, setDecided] = useState<DecisionResultDto | null>(null);
  // #203 A opção marcada é do DecisionForm, mas a gaveta a conhece (value/onValueChange) para mostrar os itens só no parcial.
  const [choice, setChoice] = useState<Choice | undefined>(undefined);
  // #203 Já preenchidos com a diferença da evidência; o que a pessoa digita fica aqui ao trocar de opção.
  const [partial, setPartial] = useState<Record<string, PartialInput>>(() => partialPrefill(proposal));
  const proposed = proposal.dockAction.kind;
  /** #134 Sem divergência em item (MATCH), não há o que segurar ou devolver: o bloco do parcial some. */
  const hasItemDivergence = proposal.divergences.some((d) => d.skus.length > 0);
  const labels = (afterCount ?? COUNTED.includes(proposal.classification)) ? texts.proposalPanel.form.afterCountOptions : texts.proposalPanel.form.options;
  const tones: Record<Choice, "positive" | "waiting" | "negative"> = { receber: "positive", receber_parcial: "waiting", recusar: "negative" };

  const typingPartial = choice === "receber_parcial" && proposed !== "receber_parcial" && hasItemDivergence;
  const inputOf = (key: string): PartialInput => partial[key] ?? { amount: "", disposition: "segurar" };
  /** #203 AC-4: sem nenhuma quantidade maior que zero, o Registrar fica desabilitado (texto que não é número avisa no clique). */
  const typedAmount = (key: string): number => {
    const text = inputOf(key).amount.trim().replace(",", ".");
    return text === "" ? 0 : Number(text);
  };
  const noQuantity = typingPartial && !proposal.items.some((i) => {
    const n = typedAmount(i.sku ?? i.supplierCode);
    return n > 0 || Number.isNaN(n);
  });

  /** #134 As linhas do receber parcial que a pessoa informou: o item, a quantidade na unidade da nota e o destino. */
  function typedLines(): PartialLineDto[] {
    return proposal.items.flatMap((i) => {
      const key = i.sku ?? i.supplierCode;
      const input = partial[key];
      if (!input || input.amount.trim() === "") return [];
      // #176 O campo é texto (DS): a vírgula do teclado pt-BR vale como ponto. Lixo avisa, não some.
      const amount = Number(input.amount.trim().replace(",", "."));
      if (!Number.isFinite(amount) || amount < 0) throw new PartialInputError(texts.proposalPanel.partial.invalidQty);
      if (amount === 0) return [];
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
          <DecisionForm<Choice>
            title={texts.proposalPanel.form.title}
            description={texts.proposalPanel.form.description}
            minNoteLength={10}
            value={choice}
            onValueChange={setChoice}
            submitDisabled={noQuantity}
            onSubmit={(d) => submit(d).catch((e: unknown) => Promise.reject(e instanceof PartialInputError ? e : new Error(decisionError(e))))}
            texts={{ noteLabel: texts.proposalPanel.form.note, submit: texts.proposalPanel.form.submit, done: null }}
            // #134 Sem divergência em item não há linha para segurar ou devolver: o parcial seria um beco sem saída.
            options={(["receber", "receber_parcial", "recusar"] as const).filter((k) => k !== "receber_parcial" || hasItemDivergence || proposed === "receber_parcial").map((k) => ({
              value: k,
              label: labels[k],
              tone: tones[k],
              ...(k === proposed ? { description: texts.proposalPanel.form.proposed } : { noteRequired: true }),
            }))}
          >
            {typingPartial ? (
            <Block title={texts.proposalPanel.partial.inputTitle} size="sm">
              {proposal.items
                .map((i) => {
                  const sku = i.sku ?? i.supplierCode;
                  const input = inputOf(sku);
                  return (
                    <div key={sku} className="pagar-partial-row">
                      <span>{texts.proposalPanel.partial.itemQty(i.description, qtyText(i.quantity), stockText(i, i.quantity.amount))}</span>
                      <Input
                        aria-label={texts.proposalPanel.partial.qtyLabel(i.description)}
                        inputMode="decimal"
                        value={input.amount}
                        onChange={(e) => setPartial({ ...partial, [sku]: { ...input, amount: e.target.value } })}
                      />
                      <Text as="span" variant="body-sm">{i.quantity.unit}</Text>
                      <div role="group" aria-label={texts.proposalPanel.partial.dispositionLabel(i.description)}>
                        <Select
                          size="sm"
                          value={input.disposition}
                          onChange={(value) => setPartial({ ...partial, [sku]: { ...input, disposition: value as Disposition } })}
                          options={[
                            { value: "segurar", label: texts.proposalPanel.partial.hold },
                            { value: "devolver", label: texts.proposalPanel.partial.giveBack },
                          ]}
                        />
                      </div>
                    </div>
                  );
                })}
              {noQuantity ? <p role="status">{texts.proposalPanel.partial.missingLines}</p> : null}
            </Block>
          ) : null}
          </DecisionForm>
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
          const outcome = line ? (line.disposition === "segurar" ? t.holds : t.returns)(
            // #176 A unidade de estoque só se soma quando a linha está na unidade da nota.
            line.quantity.unit === i.quantity.unit ? withStock(i, line.quantity.amount, (q) => q) : qtyText(line.quantity),
          ) : null;
          return {
            key: i.sku ?? i.supplierCode,
            label: i.description,
            value: [withStock(i, line ? enters.amount : i.quantity.amount, t.enters), outcome].filter(Boolean).join(" · "),
          };
        })}
      />
    </Block>
  );
}
