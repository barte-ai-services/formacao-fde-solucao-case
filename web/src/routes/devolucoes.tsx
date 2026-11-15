import { useState, type ReactNode } from "react";
import { Alert, Button, Drawer, Input, Select, Table, Text } from "barte-design-system";
import { DataList, StatusBadge, formatCurrency } from "@barte-ai-services/barte-ui-kit";
import { ApiError } from "../api/client";
import { returnNotesApi, type ReturnNoteDto, type ReturnNoteStatusDto } from "../api/return-notes";
import { NotaFiscal } from "../components/NotaFiscal";
import { Screen } from "../components/Screen";
import { useLoad } from "../components/useLoad";
import type { RouteProps } from "./types";
import { texts } from "../texts";

const STATUS_LABEL: Record<ReturnNoteStatusDto, string> = texts.devolucoes.status;

const STATUS_TONE: Record<ReturnNoteStatusDto, "waiting" | "positive" | "neutral"> = {
  pendente: "waiting",
  emitida: "positive",
  cancelada: "neutral",
};

/** #140 Há quanto tempo a nota espera (ou esperou) a emissão. */
export function pendingSince(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return texts.devolucoes.lessThanMinute;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return texts.devolucoes.minutesAgo(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? texts.devolucoes.hoursAgo(hours) : texts.devolucoes.hoursMinutesAgo(hours, minutes % 60);
  const days = Math.floor(hours / 24);
  return texts.devolucoes.daysAgo(days);
}

const money = (cents: number | null) => (cents === null ? "—" : formatCurrency(cents / 100));
const qty = (l: ReturnNoteDto["lines"][number]) => texts.devolucoes.quantityOf(String(l.quantity.amount), l.quantity.unit, l.description);

function decisionError(reason: unknown): string {
  if (reason instanceof ApiError) {
    if (reason.status === 409) return texts.devolucoes.errors.conflict;
    if (reason.status === 404) return texts.devolucoes.errors.notFound;
    if (reason.status === 400) return texts.devolucoes.errors.badRequest;
  }
  return texts.devolucoes.errors.other;
}

function Two({ top, bottom }: { top: ReactNode; bottom: ReactNode }) {
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

/** /devolucoes: a fila de notas de devolução que o fiscal emite no ERP e marca como emitidas (#140). */
export default function ReturnNotes(_props: RouteProps) {
  const [status, setStatus] = useState<ReturnNoteStatusDto>("pendente");
  const [openId, setOpenId] = useState<number | null>(null);
  const { state, data, retry } = useLoad(
    (signal) => returnNotesApi.list(status, signal),
    (list) => list.notes.length === 0,
  );
  const choose = (value: string) => {
    setStatus(value as ReturnNoteStatusDto);
    retry();
  };
  const notes = data?.notes ?? [];
  const open = notes.find((n) => n.id === openId);
  return (
    <Screen
      title={texts.devolucoes.title}
      subtitle={texts.devolucoes.subtitle}
      actions={
        <Select
          size="sm"
          value={status}
          onChange={choose}
          options={(Object.keys(STATUS_LABEL) as ReturnNoteStatusDto[]).map((s) => ({ value: s, label: STATUS_LABEL[s] }))}
        />
      }
      state={state}
      onRetry={retry}
      loadingLabel={texts.devolucoes.loading}
      errorTitle={texts.devolucoes.error}
      emptyLabel={
        status === "pendente"
          ? texts.devolucoes.emptyPending
          : texts.devolucoes.emptyOther
      }
    >
      {() => (
        <>
          <Table<ReturnNoteDto>
            data={notes}
            rowKey={(n) => String(n.id)}
            size="md"
            onRowClick={(n) => setOpenId(n.id)}
            emptyText={texts.devolucoes.tableEmpty}
            columns={[
              {
                key: "origem",
                title: texts.devolucoes.columns.origin,
                dataIndex: "invoiceNumber",
                render: (_, n) => <NotaFiscal number={n.invoiceNumber ?? n.invoiceAccessKey.slice(-8)} bottom={n.supplierId ?? "—"} />,
              },
              {
                key: "itens",
                title: texts.devolucoes.columns.items,
                dataIndex: "lines",
                render: (_, n) => (
                  <Two top={n.lines.map(qty)[0] ?? "—"} bottom={n.lines.length > 1 ? texts.devolucoes.moreItems(n.lines.length - 1) : ""} />
                ),
              },
              { key: "valor", title: texts.devolucoes.columns.value, dataIndex: "valueCents", align: "right", render: (_, n) => money(n.valueCents) },
              { key: "motivo", title: texts.devolucoes.columns.reason, dataIndex: "reason", render: (_, n) => n.reason },
              {
                key: "tempo",
                title: status === "pendente" ? texts.devolucoes.columns.timePending : texts.devolucoes.columns.timeWasPending,
                dataIndex: "pendingSeconds",
                render: (_, n) => (
                  <Two
                    top={pendingSince(n.pendingSeconds)}
                    bottom={
                      <StatusBadge size="sm" tone={STATUS_TONE[n.status]}>
                        {n.emitted ? texts.devolucoes.badgeEmitted(n.emitted.number) : n.status === "cancelada" ? texts.devolucoes.badgeCancelled : texts.devolucoes.badgeAwaiting}
                      </StatusBadge>
                    }
                  />
                ),
              },
            ]}
          />
          {open ? <NoteDrawer note={open} onClose={() => setOpenId(null)} onDecided={() => { setOpenId(null); retry(); }} /> : null}
        </>
      )}
    </Screen>
  );
}

function NoteDrawer({ note, onClose, onDecided }: { note: ReturnNoteDto; onClose: () => void; onDecided: () => void }) {
  const [nfe, setNfe] = useState("");
  const [why, setWhy] = useState("");
  const [nfeError, setNfeError] = useState<string | null>(null);
  const [whyError, setWhyError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = note.status === "pendente";

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setFailure(null);
    try {
      await action();
      onDecided();
    } catch (reason) {
      setFailure(decisionError(reason));
      setBusy(false);
    }
  }
  const emit = () => {
    if (!/^\d{1,9}$/.test(nfe.trim())) return setNfeError(texts.devolucoes.nfeMissing);
    setNfeError(null);
    void run(() => returnNotesApi.emit(note.id, nfe.trim()));
  };
  const cancel = () => {
    if (why.trim() === "") return setWhyError(texts.devolucoes.whyMissing);
    setWhyError(null);
    void run(() => returnNotesApi.cancel(note.id, why.trim()));
  };

  return (
    <Drawer isOpen title={texts.devolucoes.drawerTitle(note.invoiceNumber ?? "—")} onClose={onClose} className="shell-connection-panel">
      <div style={{ display: "grid", gap: "var(--spacing-xl)" }}>
        {failure ? <Alert variant="error" title={failure} /> : null}
        <DataList
          items={[
            { label: texts.devolucoes.detail.supplier, value: note.supplierId ?? "—" },
            { label: texts.devolucoes.detail.reason, value: note.reason },
            { label: texts.devolucoes.detail.value, value: money(note.valueCents), emphasis: true },
            { label: texts.devolucoes.detail.pending, value: pendingSince(note.pendingSeconds) },
            ...note.lines.map((l) => ({ label: l.supplierCode, value: `${qty(l)} · ${money(l.valueCents)}` })),
            ...(note.emitted ? [{ label: texts.devolucoes.detail.emitted, value: texts.devolucoes.detail.emittedValue(note.emitted.number, note.emitted.by) }] : []),
            ...(note.cancelled ? [{ label: texts.devolucoes.detail.cancelled, value: texts.devolucoes.detail.cancelledValue(note.cancelled.justification, note.cancelled.by) }] : []),
          ]}
        />
        {pending ? (
          <>
            <Input
              id="nfe-devolucao"
              aria-label={texts.devolucoes.nfeLabel}
              label={texts.devolucoes.nfeLabel}
              value={nfe}
              onChange={(e) => setNfe(e.target.value)}
              error={nfeError ?? undefined}
              inputMode="numeric"
            />
            <Button onClick={emit} disabled={busy}>
              {texts.devolucoes.emit}
            </Button>
            <Input
              id="justificativa-cancelamento"
              aria-label={texts.devolucoes.whyLabel}
              label={texts.devolucoes.whyLabel}
              value={why}
              onChange={(e) => setWhy(e.target.value)}
              error={whyError ?? undefined}
            />
            <Button variant="outline" onClick={cancel} disabled={busy}>
              {texts.devolucoes.cancel}
            </Button>
          </>
        ) : null}
      </div>
    </Drawer>
  );
}
