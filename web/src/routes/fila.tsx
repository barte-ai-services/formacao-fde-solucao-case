import { useState, type ReactNode } from "react";

import { Stat, StatGrid } from "@barte-ai-services/barte-ui-kit";
import { approvalApi, type QueueDto, type QueueItemDto } from "../api/approval";
import { InvoiceDrawer } from "../approval/InvoiceDrawer";
import { ACTION_LABEL, ACTION_TONE, LEVEL_LABEL, LEVEL_TONE, byQueueOrder, codeLabel } from "../approval/labels";
import { DecidedBy } from "../components/DecidedBy";
import { GridBadge } from "../components/GridBadge";
import { RowTable } from "../components/RowTable";
import { GridFilter } from "../components/GridFilter";
import { InvoiceCell } from "../components/InvoiceCell";
import { EmptyState } from "../components/EmptyState";
import { Screen } from "../components/Screen";
import { useLoad } from "../components/useLoad";
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
  const [view, setView] = useState<"all" | "mine">("all");
  const all = [...(data?.items ?? [])].sort(byQueueOrder);
  const mine = all.filter((i) => i.canApprove);
  const items = view === "mine" ? mine : all;
  /** #133 A linha que a pessoa não decide fica esmaecida, com o cadeado e a dica do nível exigido. */
  const dim = (i: QueueItemDto, node: ReactNode): ReactNode =>
    i.canApprove ? node : (
      <span className="pagar-dimmed" title={texts.fila.needsLevel(LEVEL_LABEL[i.requiredApproverLevel])}>
        {node}
      </span>
    );
  const risk = all.reduce((sum, i) => sum + i.amountAtRisk.cents, 0);
  const blocked = all.filter((i) => i.level === "bloqueio").length;

  return (
    <Screen
      title={texts.fila.title}
      subtitle={texts.fila.subtitle}
      state={state}
      onRetry={retry}
      loadingLabel={texts.fila.loading}
      errorTitle={texts.fila.error}
      emptyLabel={texts.fila.empty}
      empty={<EmptyState title={texts.emptyState.queue.title} description={texts.emptyState.queue.description} />}
    >
      {() => (
        <>
          <StatGrid columns={3}>
            <Stat caption={texts.fila.statWaiting.caption} value={all.length} context={texts.fila.statWaiting.context} />
            <Stat caption={texts.fila.statRisk.caption} value={BRL.format(risk / 100)} context={texts.fila.statRisk.context} tone="waiting" />
            <Stat caption={texts.fila.statBlocked.caption} value={blocked} context={texts.fila.statBlocked.context} tone="negative" />
          </StatGrid>
          <GridFilter
            ariaLabel={texts.fila.filterLabel}
            value={view}
            onChange={setView}
            options={[
              { value: "all", label: texts.fila.filterAll, count: all.length },
              { value: "mine", label: texts.fila.filterMine, count: mine.length },
            ]}
          />
          <RowTable<QueueItemDto>
            data={items}
            rowKey={(i) => i.invoiceAccessKey}
            size="md"
            onOpenRow={(i) => setOpen(i.invoiceAccessKey)}
            rowLabel={(i) => texts.grid.openInvoice(i.number)}
            emptyText={texts.fila.tableEmpty}
            columns={[
              { key: "nota", title: texts.fila.columns.invoice, dataIndex: "number", render: (_, i) =>
                  dim(
                    i,
                    <InvoiceCell
                      number={i.number}
                      issuedOn={i.issuedOn}
                      bottom={i.supplierId}
                      prefix={
                        i.canApprove ? null : (
                          <span role="img" aria-label={texts.fila.noPermission}>
                            🔒{" "}
                          </span>
                        )
                      }
                    />,
                  ),
              },
              {
                key: "classificacao",
                title: texts.fila.columns.classification,
                dataIndex: "exceptionName",
                render: (_, i) =>
                  dim(
                    i,
                    <GridBadge tone="neutral">
                      {i.exceptionName}
                    </GridBadge>,
                  ),
              },
              { key: "codigo", title: texts.fila.columns.code, dataIndex: "exceptionCode", render: (_, i) => codeLabel(i.exceptionCode) },
              {
                key: "acao",
                title: texts.fila.columns.action,
                dataIndex: "dockAction",
                render: (_, i) =>
                  dim(
                    i,
                    <GridBadge tone={ACTION_TONE[i.dockAction.kind]}>
                      {ACTION_LABEL[i.dockAction.kind]}
                    </GridBadge>,
                  ),
              },
              {
                key: "nivel",
                title: texts.fila.columns.level,
                dataIndex: "level",
                render: (_, i) =>
                  dim(
                    i,
                    <GridBadge tone={LEVEL_TONE[i.level]}>
                      {LEVEL_LABEL[i.level]}
                    </GridBadge>,
                  ),
              },
              {
                key: "risco",
                title: texts.fila.columns.risk,
                dataIndex: "amountAtRisk",
                align: "right",
                render: (_, i) => dim(i, `${i.amountAtRisk.text} de ${i.total.text}`),
              },
              {
                key: "encaminhada",
                title: texts.fila.columns.forwardedTo,
                dataIndex: "requiredApproverLevel",
                render: (_, i) => dim(i, LEVEL_LABEL[i.requiredApproverLevel]),
              },
              // #211 Tudo o que está na fila espera uma pessoa; o nível a quem foi encaminhado está na coluna ao lado.
              { key: "decididoPor", title: texts.decidedBy.column, dataIndex: "state", render: (_, i) => dim(i, <GridBadge tone="waiting">{texts.decidedBy.awaiting}</GridBadge>) },
            ]}
          />
          {open !== null ? (
            <InvoiceDrawer
              invoiceAccessKey={open}
              title={texts.fila.drawerTitle}
              onClose={() => setOpen(null)}
              onDecided={retry}
            />
          ) : null}
        </>
      )}
    </Screen>
  );
}
