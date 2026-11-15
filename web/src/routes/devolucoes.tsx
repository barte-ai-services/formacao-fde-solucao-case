import { useState, type ReactNode } from "react";
import { Alert, Button, Drawer, Input, Select, Table, Text } from "barte-design-system";
import { DataList, StatusBadge, formatCurrency } from "@barte-ai-services/barte-ui-kit";
import { ApiError } from "../api/client";
import { returnNotesApi, type ReturnNoteDto, type ReturnNoteStatusDto } from "../api/return-notes";
import { Screen } from "../components/Screen";
import { useLoad } from "../components/useLoad";
import type { RouteProps } from "./types";

const STATUS_LABEL: Record<ReturnNoteStatusDto, string> = {
  pendente: "Pendentes de emissão",
  emitida: "Emitidas",
  cancelada: "Canceladas",
};

const STATUS_TONE: Record<ReturnNoteStatusDto, "waiting" | "positive" | "neutral"> = {
  pendente: "waiting",
  emitida: "positive",
  cancelada: "neutral",
};

/** #140 Há quanto tempo a nota espera (ou esperou) a emissão. */
export function pendingSince(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return "há menos de 1 min";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `há ${hours} h` : `há ${hours} h ${minutes % 60} min`;
  const days = Math.floor(hours / 24);
  return `há ${days} ${days === 1 ? "dia" : "dias"}`;
}

const money = (cents: number | null) => (cents === null ? "—" : formatCurrency(cents / 100));
const qty = (l: ReturnNoteDto["lines"][number]) => `${l.quantity.amount} ${l.quantity.unit} de ${l.description}`;

function decisionError(reason: unknown): string {
  if (reason instanceof ApiError) {
    if (reason.status === 409) return "Esta nota já foi decidida por outra pessoa.";
    if (reason.status === 404) return "Esta nota não existe mais na fila.";
    if (reason.status === 400) return "A API não aceitou o que foi preenchido. Confira os campos.";
  }
  return "Não consegui registrar agora. Tente de novo em um minuto.";
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
      title="Notas de devolução"
      subtitle="As devoluções que o fiscal precisa emitir no ERP. Marque como emitida com o número da NF-e de devolução; o motivo mostra de qual exceção veio cada uma."
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
      loadingLabel="Carregando as notas de devolução…"
      errorTitle="Não consegui ler as notas de devolução agora"
      emptyLabel={
        status === "pendente"
          ? "Nenhuma devolução pendente de emissão. As novas aparecem aqui quando uma proposta de receber parcial for aprovada."
          : "Nenhuma nota neste estado."
      }
    >
      {() => (
        <>
          <Table<ReturnNoteDto>
            data={notes}
            rowKey={(n) => String(n.id)}
            size="md"
            onRowClick={(n) => setOpenId(n.id)}
            emptyText="Nenhuma nota."
            columns={[
              {
                key: "origem",
                title: "Nota de origem",
                dataIndex: "invoiceNumber",
                render: (_, n) => <Two top={`NF ${n.invoiceNumber ?? n.invoiceAccessKey.slice(-8)}`} bottom={n.supplierId ?? "—"} />,
              },
              {
                key: "itens",
                title: "Itens a devolver",
                dataIndex: "lines",
                render: (_, n) => (
                  <Two top={n.lines.map(qty)[0] ?? "—"} bottom={n.lines.length > 1 ? `e mais ${n.lines.length - 1}` : ""} />
                ),
              },
              { key: "valor", title: "Valor", dataIndex: "valueCents", align: "right", render: (_, n) => money(n.valueCents) },
              { key: "motivo", title: "Motivo", dataIndex: "reason", render: (_, n) => n.reason },
              {
                key: "tempo",
                title: status === "pendente" ? "Pendente" : "Esteve pendente",
                dataIndex: "pendingSeconds",
                render: (_, n) => (
                  <Two
                    top={pendingSince(n.pendingSeconds)}
                    bottom={
                      <StatusBadge size="sm" tone={STATUS_TONE[n.status]}>
                        {n.emitted ? `NF-e ${n.emitted.number}` : n.status === "cancelada" ? "Cancelada" : "Aguardando emissão"}
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
    if (!/^\d{1,9}$/.test(nfe.trim())) return setNfeError("Informe o número da NF-e de devolução.");
    setNfeError(null);
    void run(() => returnNotesApi.emit(note.id, nfe.trim()));
  };
  const cancel = () => {
    if (why.trim() === "") return setWhyError("Explique por que a devolução foi cancelada.");
    setWhyError(null);
    void run(() => returnNotesApi.cancel(note.id, why.trim()));
  };

  return (
    <Drawer isOpen title={`Devolução da NF ${note.invoiceNumber ?? "—"}`} onClose={onClose} className="shell-connection-panel">
      <div style={{ display: "grid", gap: "var(--spacing-xl)" }}>
        {failure ? <Alert variant="error" title={failure} /> : null}
        <DataList
          items={[
            { label: "Fornecedor", value: note.supplierId ?? "—" },
            { label: "Motivo", value: note.reason },
            { label: "Valor", value: money(note.valueCents), emphasis: true },
            { label: "Pendente", value: pendingSince(note.pendingSeconds) },
            ...note.lines.map((l) => ({ label: l.supplierCode, value: `${qty(l)} · ${money(l.valueCents)}` })),
            ...(note.emitted ? [{ label: "NF-e de devolução", value: `${note.emitted.number}, por ${note.emitted.by}` }] : []),
            ...(note.cancelled ? [{ label: "Cancelada", value: `${note.cancelled.justification}, por ${note.cancelled.by}` }] : []),
          ]}
        />
        {pending ? (
          <>
            <Input
              id="nfe-devolucao"
              aria-label="Número da NF-e de devolução"
              label="Número da NF-e de devolução"
              value={nfe}
              onChange={(e) => setNfe(e.target.value)}
              error={nfeError ?? undefined}
              inputMode="numeric"
            />
            <Button onClick={emit} disabled={busy}>
              Marcar como emitida
            </Button>
            <Input
              id="justificativa-cancelamento"
              aria-label="Justificativa do cancelamento"
              label="Justificativa do cancelamento"
              value={why}
              onChange={(e) => setWhy(e.target.value)}
              error={whyError ?? undefined}
            />
            <Button variant="outline" onClick={cancel} disabled={busy}>
              Cancelar nota
            </Button>
          </>
        ) : null}
      </div>
    </Drawer>
  );
}
