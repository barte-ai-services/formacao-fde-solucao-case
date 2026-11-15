import { Table } from "barte-design-system";
import { Stat, StatGrid, StatusBadge } from "@barte-ai-services/barte-ui-kit";
import { approvalApi, type TodayDto } from "../api/approval";
import { ACTION_LABEL, ACTION_TONE } from "../approval/labels";
import { EmptyState } from "../components/EmptyState";
import { Screen } from "../components/Screen";
import { useLoad } from "../components/useLoad";
import type { RouteProps } from "./types";
import { texts } from "../texts";

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

type Row = TodayDto["items"][number];

/**
 * /pagar/hoje: a lista do dia (AC-13). Só os títulos liberados ou reduzidos hoje, pela regra ou por
 * uma pessoa; nenhum bloqueado e nenhum de nota sem decisão.
 */
export default function ListaDoDia(_props: RouteProps) {
  const { state, data, retry } = useLoad(
    (signal): Promise<TodayDto> => approvalApi.today(signal),
    (today) => today.items.length === 0,
  );
  const items = data?.items ?? [];
  const byRule = items.filter((i) => i.approver === "regra").length;
  return (
    <Screen
      title={texts.listaDoDia.title}
      subtitle={texts.listaDoDia.subtitle}
      state={state}
      onRetry={retry}
      loadingLabel={texts.listaDoDia.loading}
      errorTitle={texts.listaDoDia.error}
      emptyLabel={texts.listaDoDia.empty}
      empty={
        <EmptyState
          title={texts.emptyState.listaDoDia.title}
          description={texts.emptyState.listaDoDia.description}
          action={{ label: texts.emptyState.action, to: "/pagar/fila" }}
        />
      }
    >
      {() => (
        <>
          <StatGrid columns={3}>
            <Stat caption={texts.listaDoDia.statTitles.caption} value={items.length} context={texts.listaDoDia.statTitles.context} />
            <Stat caption={texts.listaDoDia.statToPay.caption} value={BRL.format((data?.total.cents ?? 0) / 100)} context={texts.listaDoDia.statToPay.context} />
            <Stat caption={texts.listaDoDia.statByRule.caption} value={byRule} context={texts.listaDoDia.statByRule.context} tone="positive" />
          </StatGrid>
          <Table<Row>
            data={items}
            rowKey={(i) => i.invoiceAccessKey}
            size="md"
            emptyText={texts.listaDoDia.tableEmpty}
            columns={[
              { key: "nota", title: texts.listaDoDia.columns.invoice, dataIndex: "number", render: (_, i) => `NF ${i.number} · ${i.supplierId}` },
              {
                key: "excecao",
                title: texts.listaDoDia.columns.classification,
                dataIndex: "exceptionName",
                render: (_, i) => (
                  <StatusBadge size="sm" tone="neutral">
                    {i.exceptionName}
                  </StatusBadge>
                ),
              },
              { key: "codigo", title: texts.listaDoDia.columns.code, dataIndex: "exceptionCode" },
              {
                key: "acao",
                title: texts.listaDoDia.columns.action,
                dataIndex: "dockAction",
                render: (_, i) => (
                  <StatusBadge size="sm" tone={ACTION_TONE[i.dockAction]}>
                    {ACTION_LABEL[i.dockAction]}
                  </StatusBadge>
                ),
              },
              { key: "quem", title: texts.listaDoDia.columns.approver, dataIndex: "approver", render: (_, i) => (i.approver === "regra" ? texts.listaDoDia.rule : (i.approver ?? "—")) },
              { key: "valor", title: texts.listaDoDia.columns.amount, dataIndex: "amount", align: "right", render: (_, i) => `${i.amount.text} de ${i.invoiceTotal.text}` },
            ]}
          />
        </>
      )}
    </Screen>
  );
}
