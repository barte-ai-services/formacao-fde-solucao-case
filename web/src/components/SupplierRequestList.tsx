import type { ReactElement } from "react";
import { Button, Text } from "barte-design-system";
import { formatCurrency, type LoadState } from "@barte-ai-services/barte-ui-kit";
import { texts } from "../texts";
import { EmptyState } from "./EmptyState";
import { GridBadge } from "./GridBadge";
import { GridFilter } from "./GridFilter";
import { InvoiceCell } from "./InvoiceCell";
import { RowTable } from "./RowTable";
import { Screen } from "./Screen";
import { shortDate, type SupplierFilter, type SupplierFilterValue, type SupplierRequestRow, type SupplierRowStatus } from "./supplier-request-view";

const t = texts.supplierRequests;

/** #157 A rota em português da Fila de aprovação, que o vazio geral oferece. */
const APPROVAL_QUEUE_ROUTE = "/pagar/fila"; // ADR-004

const FILTERS: SupplierFilter[] = ["waiting", "fulfilled", "needsYou", "late"];

/** #157 O tom do selo de cada situação (mapa Q2 do wireframe). */
const STATUS_TONE: Record<SupplierRowStatus, "waiting" | "positive" | "negative" | "info"> = {
  waiting: "waiting",
  late: "negative",
  fulfilledToConfirm: "info",
  fulfilledToAnswer: "info",
  fulfilledToFollowUp: "info",
  fulfilled: "positive",
  partiallyFulfilled: "waiting",
  needsInformation: "info",
  refused: "negative",
};

export interface SupplierRequestListProps {
  state: LoadState;
  /** #157 O chip ativo; `all` quando nenhum está. */
  filter: SupplierFilterValue;
  /** #157 A contagem de cada chip; só aparece com a lista pronta. */
  counts: Record<SupplierFilter, number>;
  /** #157 As linhas do filtro, já na ordem em que a grid as mostra. */
  rows: SupplierRequestRow[];
  onFilterChange: (filter: SupplierFilterValue) => void;
  onOpenRow: (row: SupplierRequestRow) => void;
  onFollowUp: (row: SupplierRequestRow) => void;
  onRetry: () => void;
  /** #157 O "Ver todos" do chip sem linhas. */
  onShowAll: () => void;
}

function statusText(row: SupplierRequestRow): string {
  // #157 O servidor já cobrou e ainda a conta atrasada: o chip é o dele, e o texto diz que foi cobrada.
  if (row.status === "late" && row.alreadyCharged) return t.status.lateCharged;
  if (row.status === "fulfilledToConfirm") return t.status.fulfilledToConfirm(row.document);
  return t.status[row.status];
}

/** #157 A célula Status: o selo e, nas atrasadas, o botão "Cobrar", que não passa pelo clique da linha. */
function StatusCell({ row, onFollowUp }: { row: SupplierRequestRow; onFollowUp: (row: SupplierRequestRow) => void }): ReactElement {
  return (
    <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "var(--spacing-2xs)" }}>
      <GridBadge tone={STATUS_TONE[row.status]}>{statusText(row)}</GridBadge>
      {row.hiddenOrder ? (
        <GridBadge tone="negative">
          {/* #157 O texto visível é o selo; o nome acessível o contém e diz de que ordem se trata. */}
          <span role="img" aria-label={t.hiddenOrder.label}>
            {t.hiddenOrder.badge}
          </span>
        </GridBadge>
      ) : null}
      {row.status === "fulfilledToConfirm" ? (
        <Text as="span" variant="caption-sm" color="var(--content-tertiary)">
          {t.toConfirm}
        </Text>
      ) : null}
      {row.status === "late" && !row.alreadyCharged ? (
        <Button variant="outline" size="base" onClick={() => onFollowUp(row)}>
          {t.follow}
        </Button>
      ) : null}
    </span>
  );
}

/** #157 O chip sem linhas: diz o que significa e oferece "Ver todos". */
function FilteredEmpty({ filter, onShowAll }: { filter: SupplierFilterValue; onShowAll: () => void }): ReactElement {
  const message = t.filteredEmpty[filter === "all" ? "waiting" : filter];
  return (
    <div className="pagar-empty" role="status">
      <Text variant="label-lg">{message.title}</Text>
      <Text variant="body-base" className="pagar-empty-description">
        {message.description}
      </Text>
      <Button variant="outline" size="base" onClick={onShowAll}>
        {t.filteredEmpty.showAll}
      </Button>
    </div>
  );
}

/** #157 A tela "Pedidos ao fornecedor": título, chips com contagem e a grid, em todos os estados do wireframe (#157). Só props: o estado é da #157. */
export function SupplierRequestList(props: SupplierRequestListProps): ReactElement {
  const { state, filter, counts, rows, onFilterChange, onOpenRow, onFollowUp, onRetry, onShowAll } = props;
  const withCounts = state === "ready";
  const chips =
    state === "loading" || state === "ready" ? (
      <GridFilter<SupplierFilterValue>
        ariaLabel={t.filterLabel}
        value={filter}
        onChange={onFilterChange}
        options={FILTERS.map((value) => ({ value, label: t.filters[value], count: withCounts ? counts[value] : undefined }))}
      />
    ) : undefined;
  return (
    <Screen
      title={t.title}
      subtitle={t.subtitle}
      actions={chips}
      state={state}
      onRetry={onRetry}
      loadingLabel={t.loading}
      errorTitle={t.error}
      emptyLabel={t.empty.title}
      empty={<EmptyState title={t.empty.title} description={t.empty.description} action={{ label: t.empty.action, to: APPROVAL_QUEUE_ROUTE }} />}
    >
      {() =>
        rows.length === 0 ? (
          <FilteredEmpty filter={filter} onShowAll={onShowAll} />
        ) : (
          <RowTable<SupplierRequestRow>
            data={rows}
            rowKey={(row) => row.id}
            size="md"
            onOpenRow={onOpenRow}
            rowLabel={(row) => t.rowLabel(row.invoiceNumber, row.supplier)}
            emptyText={t.tableEmpty}
            columns={[
              { key: "invoice", title: t.columns.invoice, dataIndex: "invoiceNumber", render: (_, row) => <InvoiceCell number={row.invoiceNumber} /> },
              { key: "supplier", title: t.columns.supplier, dataIndex: "supplier", render: (_, row) => row.supplier },
              { key: "request", title: t.columns.request, dataIndex: "request", render: (_, row) => row.request },
              { key: "value", title: t.columns.value, dataIndex: "amountCents", align: "right", render: (_, row) => formatCurrency(row.amountCents / 100) },
              { key: "due", title: t.columns.due, dataIndex: "dueOn", render: (_, row) => shortDate(row.dueOn) },
              { key: "status", title: t.columns.status, dataIndex: "status", render: (_, row) => <StatusCell row={row} onFollowUp={onFollowUp} /> },
            ]}
          />
        )
      }
    </Screen>
  );
}
