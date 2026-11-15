import { useState, type ReactNode } from "react";
import { Alert, Drawer, Table, Text } from "barte-design-system";
import {
  DataList,
  ReconciliationDiff,
  Stat,
  StatGrid,
  StatusBadge,
  formatCurrency,
  formatIsoDate,
} from "@barte-ai-services/barte-ui-kit";
import { apiGet } from "../api";
import type { DuplicateDto, DuplicateReason, DuplicatesResponseDto, TitleState } from "../api/contract";
import { Screen } from "../components/Screen";
import { useLoad } from "../components/useLoad";
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

/** O número da nota como link: alcançável pelo teclado, com as cores e a tipografia do DS. */
const LINK_BUTTON = {
  background: "none",
  border: 0,
  padding: 0,
  font: "inherit",
  color: "var(--content-brand)",
  textDecoration: "underline",
  cursor: "pointer",
} as const;

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

/** /pagar/duplicadas: as notas duplicadas, cada uma ao lado da original, com o título bloqueado. */
export default function NotasDuplicadas(_props: RouteProps) {
  const { state, data, retry } = useLoad(
    (signal) => apiGet<DuplicatesResponseDto>("/api/duplicates", { signal }),
    (response) => response.count === 0,
  );
  const [openKey, setOpenKey] = useState<string | null>(null);
  const duplicates = data?.duplicates ?? [];
  const blockedCents = duplicates.reduce((sum, d) => sum + d.blockedAmountCents, 0);
  const byReason = (reason: DuplicateReason) => duplicates.filter((d) => d.reason === reason).length;
  const open = duplicates.find((d) => d.duplicate.accessKey === openKey);

  return (
    <Screen
      title={texts.duplicadas.title}
      subtitle={texts.duplicadas.subtitle}
      state={state}
      onRetry={retry}
      loadingLabel={texts.duplicadas.loading}
      errorTitle={texts.duplicadas.error}
      emptyLabel={texts.duplicadas.empty}
    >
      {() => (
        <>
          <StatGrid columns={3}>
            <Stat caption={texts.duplicadas.statDuplicates.caption} value={duplicates.length} context={texts.duplicadas.statDuplicates.context} tone="negative" />
            <Stat caption={texts.duplicadas.statBlocked.caption} value={formatCurrency(blockedCents / 100)} context={texts.duplicadas.statBlocked.context} tone="positive" />
            <Stat
              caption={texts.duplicadas.statWhy.caption}
              value={`${byReason("titulo_lancado")} · ${byReason("ordem_sem_saldo")}`}
              context={texts.duplicadas.statWhy.context}
            />
          </StatGrid>
          <Table<DuplicateDto>
            data={duplicates}
            rowKey={(d) => d.duplicate.accessKey}
            size="md"
            onRowClick={(d) => setOpenKey(d.duplicate.accessKey)}
            columns={[
              {
                key: "duplicate",
                title: texts.duplicadas.columns.duplicate,
                dataIndex: "duplicate",
                render: (_, d) => (
                  <TwoLines
                    top={
                      <>
                        <button
                          type="button"
                          aria-label={texts.duplicadas.openInvoice(d.duplicate.number)}
                          onClick={(event) => {
                            // A linha também abre no clique do mouse: o botão não deixa abrir duas vezes.
                            event.stopPropagation();
                            setOpenKey(d.duplicate.accessKey);
                          }}
                          style={LINK_BUTTON}
                        >
                          NF {d.duplicate.number}
                        </button>
                        {` · ${formatIsoDate(d.duplicate.issuedOn)}`}
                      </>
                    }
                    bottom={`${d.duplicate.supplierId} · ${d.duplicate.total}`}
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
                    <TwoLines top={`NF ${d.original.number}`} bottom={d.original.status} />
                  ),
              },
              {
                key: "reason",
                title: texts.duplicadas.columns.reason,
                dataIndex: "reason",
                render: (_, d) => (
                  <StatusBadge size="sm" tone="neutral">
                    {reasonLabel(d.reason)}
                  </StatusBadge>
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
                    <StatusBadge size="sm" tone={badge.tone}>
                      {badge.label}
                    </StatusBadge>
                  );
                },
              },
            ]}
          />
          {open !== undefined ? <DuplicateDrawer duplicate={open} onClose={() => setOpenKey(null)} /> : null}
        </>
      )}
    </Screen>
  );
}

/** O detalhe de uma duplicidade: a original contra a duplicada, campo a campo. */
function DuplicateDrawer({ duplicate: d, onClose }: { duplicate: DuplicateDto; onClose: () => void }) {
  const badge = titleBadge(d.titleState);
  return (
    <Drawer isOpen title={texts.duplicadas.drawerTitle(d.duplicate.number)} onClose={onClose} className="shell-connection-panel">
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
    </Drawer>
  );
}
