import { useState, type ReactNode } from "react";

import { Stat, StatGrid } from "@barte-ai-services/barte-ui-kit";
import { approvalApi, type QueueAggregates, type QueueRow } from "../api/approval";
import { InvoiceDrawer } from "../approval/InvoiceDrawer";
import { ACTION_LABEL, ACTION_TONE, LEVEL_LABEL, LEVEL_TONE, codeLabel } from "../approval/labels";
import { DecidedBy } from "../components/DecidedBy";
import { GridBadge } from "../components/GridBadge";
import { ScrollTable } from "../components/ScrollTable";
import { GridFilter } from "../components/GridFilter";
import { InvoiceCell } from "../components/InvoiceCell";
import { EmptyState } from "../components/EmptyState";
import { Screen } from "../components/Screen";
import { usePagedList } from "../components/usePagedList";
import type { RouteProps } from "./types";
import { texts } from "../texts";

/**
 * /pagar/fila: a fila de aprovação (AC-6). A proposta abre numa gaveta por cima da fila.
 * #160 A lista chega em blocos por cursor, na ordem do servidor; os números do topo e os chips vêm dos agregados da API (AC-4),
 * e o chip "Minhas" é um parâmetro do pedido (D1), não um filtro sobre o que carregou.
 */
export default function FilaDeAprovacao(_props: RouteProps) {
  const [view, setView] = useState<"all" | "mine">("all");
  const list = usePagedList<QueueRow, QueueAggregates>((cursor, signal) => approvalApi.queuePage(view === "mine", cursor, signal), view);
  const { aggregates } = list;
  const [open, setOpen] = useState<string | null>(null);
  /** #133 A linha que a pessoa não decide fica esmaecida, com o cadeado e a dica do nível exigido. */
  const dim = (i: QueueRow, node: ReactNode): ReactNode =>
    i.canApprove ? node : (
      <span className="pagar-dimmed" title={texts.fila.needsLevel(LEVEL_LABEL[i.requiredApproverLevel])}>
        {node}
      </span>
    );

  return (
    <Screen
      title={texts.fila.title}
      subtitle={texts.fila.subtitle}
      // #160 "Minhas" sem nenhuma nota não é a fila vazia: a tela segue com o chip para voltar a "Todas".
      state={list.state === "empty" && view === "mine" ? "ready" : list.state}
      onRetry={list.retry}
      loadingLabel={texts.fila.loading}
      errorTitle={texts.fila.error}
      emptyLabel={texts.fila.empty}
      empty={<EmptyState title={texts.emptyState.queue.title} description={texts.emptyState.queue.description} />}
    >
      {() => (
        <>
          <StatGrid columns={3}>
            <Stat caption={texts.fila.statWaiting.caption} value={aggregates?.all ?? 0} context={texts.fila.statWaiting.context} />
            <Stat caption={texts.fila.statRisk.caption} value={aggregates?.amountAtRisk.text ?? ""} context={texts.fila.statRisk.context} tone="waiting" />
            <Stat caption={texts.fila.statBlocked.caption} value={aggregates?.blocked ?? 0} context={texts.fila.statBlocked.context} tone="negative" />
          </StatGrid>
          <ScrollTable<QueueRow>
            rows={list.rows}
            total={list.total}
            phase={list.phase}
            skeletonRows={list.skeletonRows}
            counterBusy={list.counterBusy}
            restarted={list.restarted}
            resetKey={list.scrollKey}
            onNearEnd={list.loadNext}
            onRetry={list.retryBlock}
            label={texts.fila.title}
            toolbar={
              <GridFilter
                ariaLabel={texts.fila.filterLabel}
                value={view}
                onChange={setView}
                options={[
                  { value: "all", label: texts.fila.filterAll, count: aggregates?.all ?? 0 },
                  { value: "mine", label: texts.fila.filterMine, count: aggregates?.approvable ?? 0 },
                ]}
              />
            }
            onOpenRow={(i) => setOpen(i.invoiceAccessKey)}
            rowLabel={(i) => texts.grid.openInvoice(i.number)}
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
              { key: "decidedBy", title: texts.decidedBy.column, dataIndex: "state", render: (_, i) => dim(i, <GridBadge tone="waiting">{texts.decidedBy.awaiting}</GridBadge>) },
            ]}
          />
          {open !== null ? (
            <InvoiceDrawer
              invoiceAccessKey={open}
              title={texts.fila.drawerTitle}
              onClose={() => setOpen(null)}
              // #160 D3: a nota decidida sai da lista e os números do topo se atualizam, sem voltar ao início.
              onDecided={() => list.remove(open)}
            />
          ) : null}
        </>
      )}
    </Screen>
  );
}
