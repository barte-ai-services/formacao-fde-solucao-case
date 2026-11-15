import { useState } from "react";
import { Drawer, Table } from "barte-design-system";
import { InlineEmpty, Stat, StatGrid, StatusBadge } from "@barte-ai-services/barte-ui-kit";
import { approvalApi, type ProposalDetailDto, type QueueDto, type QueueItemDto } from "../api/approval";
import { ProposalPanel } from "../approval/ProposalPanel";
import { ACTION_LABEL, ACTION_TONE, LEVEL_LABEL, LEVEL_TONE, byQueueOrder } from "../approval/labels";
import { Screen } from "../components/Screen";
import { useLoad } from "../components/useLoad";
import { divergenceLabel } from "../evidence/labels";
import type { RouteProps } from "./types";

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });

/** /pagar/fila: a fila de aprovação (AC-6). A proposta abre numa gaveta por cima da fila. */
export default function FilaDeAprovacao(_props: RouteProps) {
  const { state, data, retry } = useLoad(
    (signal): Promise<QueueDto> => approvalApi.queue(signal),
    (queue) => queue.items.length === 0,
  );
  const [open, setOpen] = useState<string | null>(null);
  const items = [...(data?.items ?? [])].sort(byQueueOrder);
  const risk = items.reduce((sum, i) => sum + i.amountAtRisk.cents, 0);
  const blocked = items.filter((i) => i.level === "bloqueio").length;

  return (
    <Screen
      title="Fila de aprovação"
      subtitle="As propostas do agente que esperam uma pessoa decidir. O nível mais alto e o maior valor em risco vêm primeiro."
      state={state}
      onRetry={retry}
      loadingLabel="Carregando a fila…"
      errorTitle="Não consegui ler a fila de aprovação agora"
      emptyLabel="Nenhuma proposta esperando você. As novas aparecem aqui assim que o agente conferir a nota."
    >
      {() => (
        <>
          <StatGrid columns={3}>
            <Stat caption="Aguardando aprovação" value={items.length} context="propostas na fila" />
            <Stat caption="Valor em risco na fila" value={BRL.format(risk / 100)} context="se pagas como vieram" tone="waiting" />
            <Stat caption="Bloqueadas por duplicidade" value={blocked} context="ninguém paga até resolver" tone="negative" />
          </StatGrid>
          <Table<QueueItemDto>
            data={items}
            rowKey={(i) => i.invoiceAccessKey}
            size="md"
            onRowClick={(i) => setOpen(i.invoiceAccessKey)}
            emptyText="Nenhuma proposta na fila."
            columns={[
              { key: "nota", title: "Nota fiscal", dataIndex: "number", render: (_, i) => `NF ${i.number} · ${i.supplierId}` },
              {
                key: "classificacao",
                title: "Divergência",
                dataIndex: "classification",
                render: (_, i) => (
                  <StatusBadge size="sm" tone="neutral">
                    {i.classification === "MATCH" ? "Confere" : divergenceLabel(i.classification)}
                  </StatusBadge>
                ),
              },
              {
                key: "acao",
                title: "Ação na doca",
                dataIndex: "dockAction",
                render: (_, i) => (
                  <StatusBadge size="sm" tone={ACTION_TONE[i.dockAction.kind]}>
                    {ACTION_LABEL[i.dockAction.kind]}
                  </StatusBadge>
                ),
              },
              {
                key: "nivel",
                title: "Nível",
                dataIndex: "level",
                render: (_, i) => (
                  <StatusBadge size="sm" variant="soft" tone={LEVEL_TONE[i.level]}>
                    {LEVEL_LABEL[i.level]}
                  </StatusBadge>
                ),
              },
              {
                key: "risco",
                title: "Valor em risco",
                dataIndex: "amountAtRisk",
                align: "right",
                render: (_, i) => `${i.amountAtRisk.text} de ${i.total.text}`,
              },
              {
                key: "pode",
                title: "Você aprova?",
                dataIndex: "canApprove",
                render: (_, i) => (i.canApprove ? "Sim" : "Não, outro nível"),
              },
            ]}
          />
          {open !== null ? (
            <ProposalDrawer
              invoiceAccessKey={open}
              onClose={() => setOpen(null)}
              onDecided={retry}
            />
          ) : null}
        </>
      )}
    </Screen>
  );
}

function ProposalDrawer({
  invoiceAccessKey,
  onClose,
  onDecided,
}: {
  invoiceAccessKey: string;
  onClose: () => void;
  onDecided: () => void;
}) {
  const { state, data } = useLoad((signal): Promise<ProposalDetailDto> => approvalApi.proposal(invoiceAccessKey, signal));
  return (
    <Drawer isOpen title={data ? `Proposta da NF ${data.number}` : "Proposta"} onClose={onClose} className="shell-connection-panel">
      {state === "ready" && data ? (
        <ProposalPanel proposal={data} onDecided={onDecided} />
      ) : (
        <InlineEmpty>{state === "error" ? "Não consegui ler esta proposta agora." : "Carregando a proposta…"}</InlineEmpty>
      )}
    </Drawer>
  );
}
