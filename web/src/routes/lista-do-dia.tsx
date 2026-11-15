import { Table } from "barte-design-system";
import { Stat, StatGrid, StatusBadge } from "@barte-ai-services/barte-ui-kit";
import { approvalApi, type TodayDto } from "../api/approval";
import { ACTION_LABEL, ACTION_TONE } from "../approval/labels";
import { Screen } from "../components/Screen";
import { useLoad } from "../components/useLoad";
import type { RouteProps } from "./types";

const DAY = new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "long", timeZone: "UTC" });
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
  const day = data ? DAY.format(new Date(`${data.day}T00:00:00Z`)) : "hoje";
  return (
    <Screen
      title="Lista do dia"
      subtitle={`Os títulos liberados para pagar em ${day}: pela regra, sem pessoa, ou por quem aprovou a proposta.`}
      state={state}
      onRetry={retry}
      loadingLabel="Carregando a lista do dia…"
      errorTitle="Não consegui ler a lista do dia agora"
      emptyLabel="Nenhum título liberado hoje. Eles aparecem aqui quando a regra ou uma pessoa aprova a proposta."
    >
      {() => (
        <>
          <StatGrid columns={3}>
            <Stat caption="Títulos na lista" value={items.length} context="liberados hoje" />
            <Stat caption="A pagar" value={BRL.format((data?.total.cents ?? 0) / 100)} context="soma dos títulos" />
            <Stat caption="Liberados pela regra" value={byRule} context="sem pessoa" tone="positive" />
          </StatGrid>
          <Table<Row>
            data={items}
            rowKey={(i) => i.invoiceAccessKey}
            size="md"
            emptyText="Nenhum título."
            columns={[
              { key: "nota", title: "Nota fiscal", dataIndex: "number", render: (_, i) => `NF ${i.number} · ${i.supplierId}` },
              {
                key: "acao",
                title: "Ação na doca",
                dataIndex: "dockAction",
                render: (_, i) => (
                  <StatusBadge size="sm" tone={ACTION_TONE[i.dockAction]}>
                    {ACTION_LABEL[i.dockAction]}
                  </StatusBadge>
                ),
              },
              { key: "quem", title: "Aprovado por", dataIndex: "approver", render: (_, i) => (i.approver === "regra" ? "Regra" : (i.approver ?? "—")) },
              { key: "valor", title: "A pagar", dataIndex: "amount", align: "right", render: (_, i) => `${i.amount.text} de ${i.invoiceTotal.text}` },
            ]}
          />
        </>
      )}
    </Screen>
  );
}
