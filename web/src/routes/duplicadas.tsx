import { useState, type ReactElement, type ReactNode } from "react";
import { Alert, Text } from "barte-design-system";
import {
  DataList,
  ReconciliationDiff,
  Stat,
  StatGrid,
  formatIsoDate,
} from "@barte-ai-services/barte-ui-kit";
import type { DuplicateReason, DuplicatesAggregates, TitleState } from "../api/contract";
import { duplicatesApi, type DuplicateRow } from "../api/duplicates";
import { EmptyState } from "../components/EmptyState";
import { GridBadge } from "../components/GridBadge";
import { InvoiceCell } from "../components/InvoiceCell";
import { Screen } from "../components/Screen";
import { InvoiceDrawer } from "../approval/InvoiceDrawer";
import { DecidedBy } from "../components/DecidedBy";
import { ScrollTable } from "../components/ScrollTable";
import { usePagedList } from "../components/usePagedList";
import type { RouteProps } from "./types";
import { texts } from "../texts";

/** O motivo da duplicidade na língua do controller. */
const REASON_LABEL: Record<DuplicateReason, string> = texts.duplicadas.reason;

const NO_ORIGINAL_LABEL = texts.duplicadas.noOriginal;

type Tone = "negative" | "waiting" | "info";

/**
 * O selo do título pelo estado real que o contas a pagar devolve. Só `bloqueado` é "Título
 * bloqueado"; título ainda lançado (ou sem título) espera o bloqueio; os outros dizem o que são.
 */
function titleBadge(state: TitleState | null): { label: string; tone: Tone } {
  switch (state) {
    case "bloqueado":
      return { label: texts.duplicadas.badge.bloqueado, tone: "negative" };
    case "lancado":
    case null:
      return { label: texts.duplicadas.badge.pendente, tone: "waiting" };
    case "liberado":
      return { label: texts.duplicadas.badge.liberado, tone: "info" };
    case "reduzido":
      return { label: texts.duplicadas.badge.reduzido, tone: "info" };
    case "na_lista_do_dia":
      return { label: texts.duplicadas.badge.naLista, tone: "info" };
    default:
      // O fio pode trazer um estado que o contrato ainda não conhece: aparece como veio.
      return { label: texts.duplicadas.badge.other(String(state)), tone: "info" };
  }
}

const ALERT_VARIANT: Record<Tone, "error" | "warning" | "info"> = { negative: "error", waiting: "warning", info: "info" };

const ALERT_DESCRIPTION: Record<Tone, string> = texts.duplicadas.alertDescription;

function reasonLabel(reason: string): string {
  return Object.hasOwn(REASON_LABEL, reason) ? REASON_LABEL[reason as DuplicateReason] : reason;
}

/** Duas linhas na mesma célula: o que importa em cima, o contexto embaixo. */
function TwoLines({ top, bottom }: { top: ReactNode; bottom: ReactNode }) {
  return (
    <span style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-2xs)" }}>
      <Text as="span" variant="body-xs" color="var(--content-primary)">
        {top}
      </Text>
      <Text as="span" variant="caption-sm" color="var(--content-tertiary)">
        {bottom}
      </Text>
    </span>
  );
}

/**
 * /pagar/duplicadas: as notas duplicadas, cada uma ao lado da original, com o título bloqueado.
 * #160 A lista chega em blocos por cursor; os números do topo são o `total` e os agregados da resposta (AC-4).
 */
export default function NotasDuplicadas(_props: RouteProps): ReactElement {
  const list = usePagedList<DuplicateRow, DuplicatesAggregates>((cursor, signal) => duplicatesApi.page(cursor, signal), "duplicadas");
  const { aggregates } = list;
  // #160 A gaveta guarda a linha aberta e lê a versão atual dela na lista: decidir a atualiza no lugar (D3) e a gaveta segue mostrando a decisão.
  const [open, setOpen] = useState<DuplicateRow | null>(null);
  const drawerRow = open === null ? null : (list.rows.find((row) => row.key === open.key) ?? open);

  return (
    <Screen
      title={texts.duplicadas.title}
      subtitle={texts.duplicadas.subtitle}
      state={list.state}
      onRetry={list.retry}
      loadingLabel={texts.duplicadas.loading}
      errorTitle={texts.duplicadas.error}
      emptyLabel={texts.duplicadas.empty}
      empty={
        <EmptyState
          title={texts.emptyState.duplicadas.title}
          description={texts.emptyState.duplicadas.description}
          action={{ label: texts.emptyState.action, to: "/pagar/fila" }}
        />
      }
    >
      {() => (
        <>
          <StatGrid columns={3}>
            <Stat caption={texts.duplicadas.statDuplicates.caption} value={list.total} context={texts.duplicadas.statDuplicates.context} tone="negative" />
            <Stat caption={texts.duplicadas.statBlocked.caption} value={aggregates?.blockedAmount.text ?? ""} context={texts.duplicadas.statBlocked.context} tone="positive" />
            <Stat
              caption={texts.duplicadas.statWhy.caption}
              value={`${aggregates?.byReason.titulo_lancado ?? 0} · ${aggregates?.byReason.ordem_sem_saldo ?? 0}`}
              context={texts.duplicadas.statWhy.context}
            />
          </StatGrid>
          <ScrollTable<DuplicateRow>
            rows={list.rows}
            total={list.total}
            phase={list.phase}
            skeletonRows={list.skeletonRows}
            counterBusy={list.counterBusy}
            restarted={list.restarted}
            resetKey={list.scrollKey}
            onNearEnd={list.loadNext}
            onRetry={list.retryBlock}
            label={texts.duplicadas.title}
            onOpenRow={setOpen}
            rowLabel={(d) => texts.grid.openInvoice(d.duplicate.number)}
            columns={[
              {
                key: "duplicate",
                title: texts.duplicadas.columns.duplicate,
                dataIndex: "duplicate",
                render: (_, d) => (
                  <InvoiceCell
                    number={d.duplicate.number}
                    issuedOn={d.duplicate.issuedOn}
                    bottom={`${d.duplicate.supplierId} · ${d.duplicate.total}`}
                    openLabel={texts.duplicadas.openInvoice(d.duplicate.number)}
                    onOpen={() => setOpen(d)}
                  />
                ),
              },
              {
                key: "original",
                title: texts.duplicadas.columns.original,
                dataIndex: "original",
                render: (_, d) =>
                  d.original === null ? (
                    <TwoLines top="—" bottom={NO_ORIGINAL_LABEL} />
                  ) : (
                    <InvoiceCell number={d.original.number} bottom={d.original.status} />
                  ),
              },
              {
                key: "reason",
                title: texts.duplicadas.columns.reason,
                dataIndex: "reason",
                render: (_, d) => (
                  <GridBadge tone="neutral">
                    {reasonLabel(d.reason)}
                  </GridBadge>
                ),
              },
              {
                key: "blocked",
                title: texts.duplicadas.columns.blocked,
                dataIndex: "blockedAmount",
                align: "right",
                render: (_, d) => <b>{d.blockedAmount}</b>,
              },
              {
                key: "title",
                title: texts.duplicadas.columns.title,
                dataIndex: "blockedAmountCents",
                render: (_, d) => {
                  const badge = titleBadge(d.titleState);
                  return (
                    <GridBadge tone={badge.tone}>
                      {badge.label}
                    </GridBadge>
                  );
                },
              },
              // #211 O sistema bloqueia a duplicada sozinho; título que ainda não está bloqueado não tem quem decidiu.
              { key: "decidedBy", title: texts.decidedBy.column, dataIndex: "reason", render: (_, d) => (d.titleState === "bloqueado" ? <DecidedBy actor="system" /> : "—") },
            ]}
          />
          {drawerRow !== null ? <DuplicateDrawer duplicate={drawerRow} onClose={() => setOpen(null)} onDecided={() => list.refresh(drawerRow.key)} /> : null}
        </>
      )}
    </Screen>
  );
}

/** O detalhe de uma duplicidade: a original contra a duplicada, campo a campo. */
function DuplicateDrawer({ duplicate: d, onClose, onDecided }: { duplicate: DuplicateRow; onClose: () => void; onDecided: () => void }) {
  const badge = titleBadge(d.titleState);
  return (
    <InvoiceDrawer invoiceAccessKey={d.duplicate.accessKey} title={() => texts.duplicadas.drawerTitle(d.duplicate.number)} onClose={onClose} onDecided={onDecided}>
      <div style={{ display: "grid", gap: "var(--spacing-xl)" }}>
        <Alert variant={ALERT_VARIANT[badge.tone]} title={badge.label} description={ALERT_DESCRIPTION[badge.tone]} />
        {d.original === null ? (
          <Alert variant="warning" title={reasonLabel(d.reason)} description={NO_ORIGINAL_LABEL} />
        ) : (
          <ReconciliationDiff
            columns={texts.duplicadas.diffColumns(d.original.number, d.duplicate.number)}
            fields={[
              { label: texts.duplicadas.fields.number, a: d.original.number, b: d.duplicate.number, state: d.original.number === d.duplicate.number ? "match" : "divergent" },
              { label: texts.duplicadas.fields.accessKey, a: <code>{d.original.accessKey}</code>, b: <code>{d.duplicate.accessKey}</code>, ...(d.original.accessKey === d.duplicate.accessKey ? { state: "match" as const, note: texts.duplicadas.fields.sameInvoice } : { state: "divergent" as const, note: texts.duplicadas.fields.newInvoice }) },
              { label: texts.duplicadas.fields.title, a: d.original.status, b: badge.label.toLowerCase() },
            ]}
          />
        )}
        <DataList
          items={[
            { label: texts.duplicadas.detail.why, value: reasonLabel(d.reason) },
            { label: texts.duplicadas.detail.supplier, value: d.duplicate.supplierId },
            { label: texts.duplicadas.detail.issued, value: formatIsoDate(d.duplicate.issuedOn) },
            { label: texts.duplicadas.detail.blocked, value: d.blockedAmount, emphasis: true },
          ]}
        />
      </div>
    </InvoiceDrawer>
  );
}
