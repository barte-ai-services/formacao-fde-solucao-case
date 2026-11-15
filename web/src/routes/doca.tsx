import { useEffect, useState } from "react";
import { Alert, Select, Table, Text } from "barte-design-system";
import { StatusBadge } from "@barte-ai-services/barte-ui-kit";
import { dockApi, type DockBoardDto, type DockRowDto } from "../api/dock";
import type { DockActionDto, QuantityDto } from "../api/contract";
import { ACTION_LABEL, ACTION_TONE } from "../approval/labels";
import { Screen } from "../components/Screen";
import { useLoad } from "../components/useLoad";
import type { RouteProps } from "./types";

function qty(q: QuantityDto): string {
  return `${q.amount} ${q.unit}`;
}

/** #135 O que cada lugar diz ao operador: a doca do CD fala de caminhão; o app da loja, de nota. */
export interface ReceivingWording {
  receive: string;
  refuse: string;
  awaiting: string;
}

const DOCK_WORDING: ReceivingWording = {
  receive: "Descarregue tudo",
  refuse: "Devolva o caminhão inteiro",
  awaiting: "Não descarregue ainda",
};

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
        lines.filter((l) => l.disposition === d).map((l) => `${qty(l.quantity)} de ${l.sku}`);
      const hold = of("segurar");
      const back = of("devolver");
      return [hold.length ? `Segure ${hold.join(", ")}` : "", back.length ? `Devolva ${back.join(", ")}` : ""]
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
  load: (destination: string | null, signal: AbortSignal) => Promise<DockBoardDto>;
  words: ReceivingWording;
  noun: string; // "doca" ou "loja": o lugar, nas mensagens de carga e de erro
  emptyIn: (shown: string | null) => string;
  warning: string;
}

/** /doca: as notas do dia num destino e o que fazer com cada caminhão (#43 AC-3, AC-4). */
export default function Doca(_props: RouteProps) {
  return (
    <ReceivingBoard
      title="Doca"
      subtitle="As notas que chegam hoje neste destino e o que fazer com cada caminhão. Nada é descarregado antes da decisão."
      load={(destination, signal) => dockApi.board(destination, signal)}
      words={DOCK_WORDING}
      noun="doca"
      emptyIn={(shown) => `Nenhuma nota com entrega prevista hoje ${shown ? `na ${shown}` : "neste destino"}.`}
      warning="Segure o caminhão: a ação aparece aqui assim que a pessoa decidir."
    />
  );
}

/** #135 O quadro de recebimento, o mesmo para a doca do CD e para a loja; cada um passa o seu texto e a sua leitura. */
export function ReceivingBoard({ title, subtitle, load, words, noun, emptyIn, warning }: ReceivingBoardProps) {
  const [destination, setDestination] = useState<string | null>(null);
  const { state, data, retry } = useLoad(
    (signal): Promise<DockBoardDto> => load(destination, signal),
    (board) => board.rows.length === 0,
  );
  // #72 Trocar o destino carrega de novo: as duas mudanças entram no mesmo render, e o `useLoad` lê a carga nova.
  const choose = (value: string) => {
    setDestination(value);
    retry();
  };
  // #72 A lista de destinos fica guardada entre as cargas: o seletor não some enquanto carrega nem depois de um erro.
  const [destinations, setDestinations] = useState<string[]>([]);
  useEffect(() => {
    if (data) setDestinations(data.destinations);
  }, [data]);
  const shown = data?.destination ?? destination;
  const rows = data?.rows ?? [];
  const awaiting = data?.awaiting ?? 0;
  return (
    <Screen
      title={title}
      subtitle={subtitle}
      actions={
        destinations.length > 0 ? (
          <Select
            size="sm"
            value={destination ?? data?.destination ?? undefined}
            onChange={choose}
            options={destinations.map((d) => ({ value: d, label: d }))}
          />
        ) : undefined
      }
      state={state}
      onRetry={retry}
      loadingLabel={`Carregando as notas da ${noun}…`}
      errorTitle={`Não consegui ler as notas desta ${noun} agora`}
      emptyLabel={emptyIn(shown)}
    >
      {() => (
        <>
          {awaiting > 0 ? (
            <Alert
              variant="warning"
              title={`${awaiting} ${awaiting === 1 ? "nota aguarda" : "notas aguardam"} aprovação.`}
              description={warning}
            />
          ) : null}
          <Table<DockRowDto>
            data={rows}
            rowKey={(n) => n.invoiceAccessKey}
            size="md"
            emptyText="Nenhuma nota."
            columns={[
              { key: "nota", title: "Nota fiscal", dataIndex: "number", render: (_, n) => <Two top={`NF ${n.number}`} bottom={n.supplierId} /> },
              {
                key: "itens",
                title: "Itens",
                dataIndex: "items",
                render: (_, n) => (
                  <Two
                    top={`${n.items.length} ${n.items.length === 1 ? "item" : "itens"}`}
                    bottom={n.items.map((i) => i.description).join(", ")}
                  />
                ),
              },
              {
                key: "acao",
                title: "O que fazer",
                dataIndex: "status",
                render: (_, n) =>
                  n.status.kind === "aguardando_aprovacao" ? (
                    <Two
                      top={
                        <StatusBadge size="sm" tone="waiting">
                          Aguardando aprovação
                        </StatusBadge>
                      }
                      bottom={words.awaiting}
                    />
                  ) : (
                    <Two
                      top={
                        <StatusBadge size="sm" variant="solid" tone={ACTION_TONE[n.status.action.kind]}>
                          {ACTION_LABEL[n.status.action.kind]}
                        </StatusBadge>
                      }
                      bottom={instruction(n.status.action, words)}
                    />
                  ),
              },
            ]}
          />
        </>
      )}
    </Screen>
  );
}
