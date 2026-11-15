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
import { texts } from "../texts";

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
      title={texts.fila.title}
      subtitle={texts.fila.subtitle}
      state={state}
      onRetry={retry}
      loadingLabel={texts.fila.loading}
      errorTitle={texts.fila.error}
      emptyLabel={texts.fila.empty}
    >
      {() => (
        <>
          <StatGrid columns={3}>
            <Stat caption={texts.fila.statWaiting.caption} value={items.length} context={texts.fila.statWaiting.context} />
            <Stat caption={texts.fila.statRisk.caption} value={BRL.format(risk / 100)} context={texts.fila.statRisk.context} tone="waiting" />
            <Stat caption={texts.fila.statBlocked.caption} value={blocked} context={texts.fila.statBlocked.context} tone="negative" />
          </StatGrid>
          <Table<QueueItemDto>
            data={items}
            rowKey={(i) => i.invoiceAccessKey}
            size="md"
            onRowClick={(i) => setOpen(i.invoiceAccessKey)}
            emptyText={texts.fila.tableEmpty}
            columns={[
              { key: "nota", title: texts.fila.columns.invoice, dataIndex: "number", render: (_, i) => `NF ${i.number} · ${i.supplierId}` },
              {
                key: "classificacao",
                title: texts.fila.columns.classification,
                dataIndex: "classification",
                render: (_, i) => (
                  <StatusBadge size="sm" tone="neutral">
                    {i.classification === "MATCH" ? texts.fila.match : divergenceLabel(i.classification)}
                  </StatusBadge>
                ),
              },
              {
                key: "acao",
                title: texts.fila.columns.action,
                dataIndex: "dockAction",
                render: (_, i) => (
                  <StatusBadge size="sm" tone={ACTION_TONE[i.dockAction.kind]}>
                    {ACTION_LABEL[i.dockAction.kind]}
                  </StatusBadge>
                ),
              },
              {
                key: "nivel",
                title: texts.fila.columns.level,
                dataIndex: "level",
                render: (_, i) => (
                  <StatusBadge size="sm" variant="soft" tone={LEVEL_TONE[i.level]}>
                    {LEVEL_LABEL[i.level]}
                  </StatusBadge>
                ),
              },
              {
                key: "risco",
                title: texts.fila.columns.risk,
                dataIndex: "amountAtRisk",
                align: "right",
                render: (_, i) => `${i.amountAtRisk.text} de ${i.total.text}`,
              },
              {
                key: "pode",
                title: texts.fila.columns.canApprove,
                dataIndex: "canApprove",
                render: (_, i) => (i.canApprove ? texts.fila.yes : texts.fila.noOtherLevel),
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
    <Drawer isOpen title={texts.fila.drawerTitle(data ? data.number : null)} onClose={onClose} className="shell-connection-panel">
      {state === "ready" && data ? (
        <ProposalPanel proposal={data} onDecided={onDecided} />
      ) : (
        <InlineEmpty>{state === "error" ? texts.fila.drawerError : texts.fila.drawerLoading}</InlineEmpty>
      )}
    </Drawer>
  );
}
