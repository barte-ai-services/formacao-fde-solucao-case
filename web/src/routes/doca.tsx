import { useState, type ReactElement } from "react";
import { Alert, Select, Text } from "barte-design-system";
import { dockApi, type DockBoardAggregates, type DockRow } from "../api/dock";
import type { Block } from "../components/paged-list-state";
import type { DockActionDto, QuantityDto } from "../api/contract";
import { ACTION_LABEL, ACTION_TONE } from "../approval/labels";
import { DataList } from "@barte-ai-services/barte-ui-kit";
import { InvoiceDrawer } from "../approval/InvoiceDrawer";
import { ScrollTable } from "../components/ScrollTable";
import { EmptyState } from "../components/EmptyState";
import { DecidedBy } from "../components/DecidedBy";
import { GridBadge } from "../components/GridBadge";
import { InvoiceCell } from "../components/InvoiceCell";
import { Screen } from "../components/Screen";
import { usePagedList } from "../components/usePagedList";
import type { RouteProps } from "./types";
import { texts } from "../texts";

function qty(q: QuantityDto): string {
  return `${q.amount} ${q.unit}`;
}

/** #135 O que cada lugar diz ao operador: a doca do CD fala de caminhão; o app da loja, de nota. */
export interface ReceivingWording {
  receive: string;
  refuse: string;
  awaiting: string;
}

const DOCK_WORDING: ReceivingWording = texts.doca.words;

/** #43 AC-2: o que o operador faz no receber parcial, a partir das linhas a segurar ou devolver. */
function instruction(action: DockActionDto, words: ReceivingWording): string {
  switch (action.kind) {
    case "receber":
      return words.receive;
    case "recusar":
      return words.refuse;
    case "receber_parcial": {
      const { lines } = action;
      const of = (d: "segurar" | "devolver") =>
        lines.filter((l) => l.disposition === d).map((l) => texts.recebimento.quantityOf(qty(l.quantity), l.sku));
      const hold = of("segurar");
      const back = of("devolver");
      return [hold.length ? texts.recebimento.hold(hold.join(", ")) : "", back.length ? texts.recebimento.giveBack(back.join(", ")) : ""]
        .filter(Boolean)
        .join("; ");
    }
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}

function Two({ top, bottom }: { top: React.ReactNode; bottom: React.ReactNode }) {
  return (
    <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <Text variant="body-xs" color="var(--content-primary)">
        {top}
      </Text>
      <Text variant="caption-sm" color="var(--content-tertiary)">
        {bottom}
      </Text>
    </span>
  );
}

/** #135 O que muda entre a doca do CD e o recebimento na loja. */
export interface ReceivingBoardProps {
  title: string;
  subtitle: string;
  /** #160 Um bloco da lista: o destino (nulo abre no primeiro do dia) e o cursor do bloco. */
  load: (destination: string | null, cursor: string | null, signal: AbortSignal) => Promise<Block<DockRow, DockBoardAggregates>>;
  words: ReceivingWording;
  /** #135 "doca" ou "loja": o lugar, nas mensagens de carga e de erro. */
  noun: string;
  emptyIn: (shown: string | null) => string;
  warning: string;
}

/** /doca: as notas do dia num destino e o que fazer com cada caminhão (#43 AC-3, AC-4). */
export default function Doca(_props: RouteProps): ReactElement {
  return (
    <ReceivingBoard
      title={texts.doca.title}
      subtitle={texts.doca.subtitle}
      load={dockApi.boardPage}
      words={DOCK_WORDING}
      noun={texts.doca.noun}
      emptyIn={texts.doca.emptyIn}
      warning={texts.doca.warning}
    />
  );
}

/**
 * #135 O quadro de recebimento, o mesmo para a doca do CD e para a loja; cada um passa o seu texto e a sua leitura.
 * #160 A lista chega em blocos por cursor; o aviso de aguardando é `aggregates.awaiting`, do destino inteiro, e trocar o destino recomeça a lista.
 */
export function ReceivingBoard({ title, subtitle, load, words, noun, emptyIn, warning }: ReceivingBoardProps): ReactElement {
  const [destination, setDestination] = useState<string | null>(null);
  // #160 O destino é parâmetro da lista: trocar recomeça do primeiro bloco, e o cursor de um destino não vale em outro.
  const list = usePagedList<DockRow, DockBoardAggregates>((cursor, signal) => load(destination, cursor, signal), destination ?? "");
  const { aggregates } = list;
  // #72 A lista de destinos fica guardada entre as cargas: o seletor não some enquanto carrega (os agregados ficam até a resposta nova).
  const destinations = aggregates?.destinations ?? [];
  // #160 A gaveta guarda a linha aberta e lê a versão atual dela na lista: decidir a atualiza no lugar (D3) e a gaveta mostra a ação nova.
  const [open, setOpen] = useState<DockRow | null>(null);
  const drawerRow = open === null ? null : (list.rows.find((row) => row.key === open.key) ?? open);
  const shown = aggregates?.destination ?? destination;
  const awaiting = aggregates?.awaiting ?? 0;
  return (
    <Screen
      title={title}
      subtitle={subtitle}
      actions={
        destinations.length > 0 ? (
          // #160 O seletor do DS não tem nome acessível: o grupo diz de que é a escolha (a checagem de página da doca o cobra).
          <div role="group" aria-label={texts.recebimento.changeDestination(noun)}>
            <Select
              size="sm"
              value={destination ?? aggregates?.destination ?? undefined}
              onChange={setDestination}
              options={destinations.map((d) => ({ value: d, label: d }))}
            />
          </div>
        ) : undefined
      }
      state={list.state}
      onRetry={list.retry}
      loadingLabel={texts.recebimento.loading(noun)}
      errorTitle={texts.recebimento.error(noun)}
      emptyLabel={emptyIn(shown)}
      empty={
        <EmptyState
          title={texts.emptyState.recebimento.title(noun)}
          description={texts.emptyState.recebimento.description(emptyIn(shown))}
          action={{ label: texts.emptyState.action, to: "/pagar/fila" }}
        />
      }
    >
      {() => (
        <>
          {awaiting > 0 ? (
            <Alert
              variant="warning"
              title={texts.recebimento.awaitingTitle(awaiting)}
              description={warning}
            />
          ) : null}
          <ScrollTable<DockRow>
            rows={list.rows}
            total={list.total}
            phase={list.phase}
            skeletonRows={list.skeletonRows}
            counterBusy={list.counterBusy}
            restarted={list.restarted}
            resetKey={list.scrollKey}
            onNearEnd={list.loadNext}
            onRetry={list.retryBlock}
            label={title}
            onOpenRow={(n) => setOpen(n)}
            rowLabel={(n) => texts.grid.openInvoice(n.number)}
            columns={[
              { key: "nota", title: texts.recebimento.columns.invoice, dataIndex: "number", render: (_, n) => <InvoiceCell number={n.number} bottom={n.supplierId} /> },
              {
                key: "itens",
                title: texts.recebimento.columns.items,
                dataIndex: "items",
                render: (_, n) => (
                  <Two
                    top={texts.recebimento.itemCount(n.items.length)}
                    bottom={n.items.map((i) => i.description).join(", ")}
                  />
                ),
              },
              {
                key: "acao",
                title: texts.recebimento.columns.whatToDo,
                dataIndex: "status",
                render: (_, n) =>
                  n.status.kind === "aguardando_aprovacao" ? (
                    <Two
                      top={
                        <GridBadge tone="waiting">
                          {texts.recebimento.awaitingBadge}
                        </GridBadge>
                      }
                      bottom={words.awaiting}
                    />
                  ) : (
                    <Two
                      top={
                        <GridBadge variant="solid" tone={ACTION_TONE[n.status.action.kind]}>
                          {ACTION_LABEL[n.status.action.kind]}
                        </GridBadge>
                      }
                      bottom={instruction(n.status.action, words)}
                    />
                  ),
              },
              // #211 Quem decidiu a nota; sem aprovação, a nota espera uma pessoa.
              {
                key: "decidedBy",
                title: texts.decidedBy.column,
                dataIndex: "decidedBy",
                render: (_, n) =>
                  n.decidedBy ? (
                    <DecidedBy actor={n.decidedBy.actor} name={n.decidedBy.actor === "rule" ? null : n.decidedBy.actor_name} />
                  ) : n.status.kind === "aguardando_aprovacao" ? (
                    <GridBadge tone="waiting">{texts.decidedBy.awaiting}</GridBadge>
                  ) : (
                    "—"
                  ),
              },
            ]}
          />
          {drawerRow !== null ? (
            <InvoiceDrawer invoiceAccessKey={drawerRow.invoiceAccessKey} title={texts.fila.drawerTitle} onClose={() => setOpen(null)} onDecided={() => list.refresh(drawerRow.key)}>
              <DataList
                items={[
                  {
                    key: "acao",
                    label: texts.recebimento.columns.whatToDo,
                    value: drawerRow.status.kind === "aguardando_aprovacao" ? words.awaiting : instruction(drawerRow.status.action, words),
                  },
                ]}
              />
            </InvoiceDrawer>
          ) : null}
        </>
      )}
    </Screen>
  );
}
