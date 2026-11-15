import { useMemo, useState, type ReactNode } from "react";
import { Alert, Drawer, Pills, Search, Select, Table, Text, type ColumnDefinition } from "barte-design-system";
import {
  AiSourceBadge,
  Block,
  DataList,
  DecisionForm,
  LineChart,
  LoadFeedback,
  PageTitleBar,
  Panel,
  ProgressBar,
  RankingBars,
  ReconciliationDiff,
  Stat,
  StatGrid,
  StatusBadge,
  toneColor,
  type ComparisonField,
  type LoadState,
} from "@barte-ai-services/barte-ui-kit";
import {
  ACAO,
  ACAO_TOM,
  EXCECAO,
  HOJE,
  META_MES,
  MEU_NIVEL,
  NIVEL,
  NIVEL_TOM,
  notasDe,
  linhaDoLimite,
  resumo,
  SITUACAO,
  SITUACAO_TOM,
  dia,
  naOrdemDaFila,
  podeAprovar,
  reais,
  reaisCurto,
  type Acao,
  type Nivel,
  type Nota,
} from "./model";

const RETRY = "Tentar de novo";
const SUPORTE = "Tente de novo em um minuto. Se continuar, avise o suporte da Barte.";

/** A casca de toda tela: título compacto e o estado da carga, como em Sessões ativas e Conexões. */
function Screen({
  title,
  subtitle,
  actions,
  state,
  loadingLabel,
  errorTitle,
  emptyLabel,
  children,
}: {
  title: string;
  subtitle: string;
  actions?: ReactNode;
  state: LoadState;
  loadingLabel: string;
  errorTitle: string;
  emptyLabel: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="shell-home wf-screen">
      <PageTitleBar variant="compact" title={title} subtitle={subtitle} actions={actions} />
      <LoadFeedback
        state={state}
        size="page"
        loadingLabel={loadingLabel}
        errorTitle={errorTitle}
        errorDescription={SUPORTE}
        retryLabel={RETRY}
        onRetry={() => undefined}
        emptyLabel={emptyLabel}
      >
        <div className="wf-body">{children}</div>
      </LoadFeedback>
    </div>
  );
}

/** Os filtros em pílula, iguais aos de Conexões. */
function Filters<K extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { key: K; label: string; count: number; state?: "accent" | "success" | "info" | "warning" | "error" | "default" }[];
  value: K;
  onChange: (key: K) => void;
}) {
  return (
    <div className="shell-connections-filters" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          className="shell-connections-filter"
          aria-pressed={value === option.key}
          onClick={() => onChange(option.key)}
        >
          <Pills
            label={`${option.label} · ${option.count}`}
            state={option.state ?? "accent"}
            variant={value === option.key ? "fill" : "light"}
          />
        </button>
      ))}
    </div>
  );
}

function Duas({ top, bottom }: { top: ReactNode; bottom: ReactNode }) {
  return (
    <span className="wf-two">
      <Text variant="body-xs" color="var(--content-primary)">
        {top}
      </Text>
      <Text variant="caption-sm" color="var(--content-tertiary)">
        {bottom}
      </Text>
    </span>
  );
}

const notaCol: ColumnDefinition<Nota> = {
  key: "nota",
  title: "Nota fiscal",
  dataIndex: "numero",
  render: (_, n) => <Duas top={`NF ${n.numero}`} bottom={n.fornecedor} />,
};
const excecaoCol: ColumnDefinition<Nota> = {
  key: "classificacao",
  title: "Divergência",
  dataIndex: "classificacao",
  render: (_, n) =>
    n.classificacao === "match" ? (
      <StatusBadge size="sm" tone="positive">
        Confere
      </StatusBadge>
    ) : (
      <StatusBadge size="sm" tone="neutral">
        {EXCECAO[n.classificacao]}
      </StatusBadge>
    ),
};
const acaoCol: ColumnDefinition<Nota> = {
  key: "acao",
  title: "Ação na doca",
  dataIndex: "acao",
  render: (_, n) => (
    <StatusBadge size="sm" tone={ACAO_TOM[n.acao]}>
      {ACAO[n.acao]}
    </StatusBadge>
  ),
};
const nivelCol: ColumnDefinition<Nota> = {
  key: "nivel",
  title: "Nível",
  dataIndex: "nivel",
  render: (_, n) => (
    <StatusBadge size="sm" variant="soft" tone={NIVEL_TOM[n.nivel]}>
      {NIVEL[n.nivel]}
    </StatusBadge>
  ),
};
const riscoCol: ColumnDefinition<Nota> = {
  key: "risco",
  title: "Valor em risco",
  dataIndex: "risco",
  align: "right",
  render: (_, n) => <Duas top={<b>{reais(n.risco)}</b>} bottom={`de ${reais(n.valor)}`} />,
};

// ———————————————————————————————————————— Fila de aprovação

type FiltroNivel = "todos" | Nivel;

export function FilaDeAprovacao({ state, aprovadas }: { state: LoadState; aprovadas: boolean }) {
  const NOTAS = useMemo(() => notasDe(aprovadas), [aprovadas]);
  const fila = useMemo(() => NOTAS.filter((n) => n.situacao === "aguardando").sort(naOrdemDaFila), [NOTAS]);
  const [filtro, setFiltro] = useState<FiltroNivel>("todos");
  const [busca, setBusca] = useState("");
  const [aberta, setAberta] = useState<string | null>(null);
  const contar = (nivel: Nivel) => fila.filter((n) => n.nivel === nivel).length;
  const visiveis = fila.filter(
    (n) =>
      (filtro === "todos" || n.nivel === filtro) &&
      (busca === "" || `${n.numero} ${n.fornecedor}`.toLowerCase().includes(busca.toLowerCase()))
  );
  const nota = fila.find((n) => n.id === aberta);
  const riscoTotal = fila.reduce((soma, n) => soma + n.risco, 0);

  return (
    <Screen
      title="Fila de aprovação"
      subtitle="As propostas do agente que esperam uma pessoa decidir. O nível mais alto e o maior valor em risco vêm primeiro."
      state={state}
      loadingLabel="Carregando a fila…"
      errorTitle="Não consegui ler a fila de aprovação agora"
      emptyLabel="Nenhuma proposta esperando você. As novas aparecem aqui assim que o agente conferir a nota."
    >
      <StatGrid columns={3}>
        <Stat caption="Aguardando aprovação" value={fila.length} context="propostas na fila" />
        <Stat caption="Valor em risco na fila" value={reaisCurto(riscoTotal)} context="se pagas como vieram" tone="waiting" />
        <Stat caption="Bloqueadas por duplicidade" value={contar("bloqueio")} context="ninguém paga até resolver" tone="negative" />
      </StatGrid>
      <div className="shell-connections-toolbar">
        <Filters<FiltroNivel>
          label="Filtrar por nível"
          value={filtro}
          onChange={setFiltro}
          options={[
            { key: "todos", label: "Todas", count: fila.length },
            { key: "bloqueio", label: "Bloqueio", count: contar("bloqueio"), state: "error" },
            { key: "diretoria", label: "Diretoria", count: contar("diretoria"), state: "warning" },
            { key: "coordenacao", label: "Coordenação", count: contar("coordenacao") },
            { key: "analista", label: "Analista", count: contar("analista"), state: "info" },
          ]}
        />
        <Search placeholder="Buscar nota ou fornecedor" expanded value={busca} onChange={setBusca} />
      </div>
      <Table
        data={visiveis}
        rowKey={(n) => n.id}
        size="md"
        onRowClick={(n) => setAberta(n.id)}
        emptyText="Nenhuma proposta neste filtro."
        columns={[
          notaCol,
          excecaoCol,
          acaoCol,
          nivelCol,
          riscoCol,
          { key: "data", title: "Chegou", dataIndex: "data", render: (_, n) => dia(n.data) },
        ]}
      />
      {nota !== undefined ? <PropostaAberta nota={nota} onClose={() => setAberta(null)} /> : null}
    </Screen>
  );
}

/** A evidência de cada divergência: o que a ordem (ou outra fonte) diz contra o que a nota cobra. */
function evidencia(n: Nota): { fonte: string; campos: ComparisonField[] } {
  const item = n.itens[0];
  const ordem = n.ordem ?? null;
  switch (n.classificacao) {
    case "E2": {
      const troca = /troca (.+?) \(pedido\) por (.+?) \(não pedido\)/.exec(n.explicacao);
      return {
        fonte: `Ordem ${ordem}`,
        campos: [
          { label: "Ordem de compra", a: ordem, b: ordem, state: "match" },
          { label: "Item", a: troca?.[1], b: troca?.[2], state: "divergent", note: "item trocado" },
          { label: "Valor do item trocado", a: null, b: reais(n.risco), state: "divergent" },
        ],
      };
    }
    case "E3":
    case "E1": {
      const conta = /Chegaram (\d+) de (\d+) \S+ de (.+?):/.exec(n.explicacao);
      return {
        fonte: `Recebimento da ${n.destino}`,
        campos: [
          { label: "Item", a: conta?.[3] ?? item?.desc, b: conta?.[3] ?? item?.desc, state: "match" },
          { label: "Quantidade", a: conta ? `${conta[1]} recebidas` : "contado na doca", b: conta ? `${conta[2]} cobradas` : `${item?.qtd} ${item?.un}`, state: "divergent" },
          { label: "Valor a devolver", a: reais(n.risco), b: null, state: "divergent" },
        ],
      };
    }
    case "E4":
      return {
        fonte: `Ordem ${ordem} e cadastro do produto`,
        campos: [
          { label: "Unidade", a: "UN", b: "CX (fator 4)", state: "divergent", note: "convertido, bate" },
          { label: "Valor total", a: reais(n.valor), b: reais(n.valor), state: "match" },
        ],
      };
    case "E5":
      return {
        fonte: "Compras: nenhuma ordem para este fornecedor e destino",
        campos: [
          { label: "Ordem de compra", a: null, b: "não citada", state: "missing" },
          { label: "Fornecedor", a: null, b: n.fornecedor, state: "missing" },
        ],
      };
    case "E6":
      return {
        fonte: `Nota ${n.original?.numero} já lançada`,
        campos: [
          { label: "Número", a: n.original?.numero, b: n.numero, state: n.original?.numero === n.numero ? "match" : "divergent" },
          { label: "Ordem", a: n.original?.ordem, b: n.ordem, state: "match" },
          { label: "Valor", a: reais(n.original?.valor ?? 0), b: reais(n.valor), state: "match" },
        ],
      };
    case "E7":
      return {
        fonte: `Pagamento fora do fluxo, loja ${n.destino}`,
        campos: [
          { label: "Pagamento", a: "feito pela loja", b: "título novo", state: "divergent", note: "pagaria duas vezes" },
          { label: "Valor", a: reais(n.valor), b: reais(n.valor), state: "match" },
        ],
      };
    case "E8":
      return {
        fonte: "Cadastro de produtos",
        campos: [
          { label: "Produto", a: null, b: item?.desc, state: "missing", note: "sem SKU" },
          { label: "Ordem", a: "travada", b: ordem, state: "divergent" },
        ],
      };
    default:
      return { fonte: `Ordem ${ordem}`, campos: [{ label: "Valor", a: reais(n.valor), b: reais(n.valor), state: "match" }] };
  }
}

/** O dossiê do Claude: só a coordenação e a diretoria recebem. */
function Dossie({ nota }: { nota: Nota }) {
  if (nota.nivel === "analista" || nota.nivel === "regra") {
    return (
      <Alert
        variant="info"
        title="Não há dossiê do Claude para esta proposta."
        description="No nível analista o agente classifica, calcula a diferença e propõe a ação, sem dossiê. Decida pela evidência acima."
      />
    );
  }
  return (
    <Panel
      title="Dossiê do Claude"
      aside={<AiSourceBadge source="ai" label="Claude" size="sm" />}
      description={
        nota.nivel === "diretoria"
          ? "O agente prepara a decisão, sem recomendar valor."
          : "O agente monta o dossiê da exceção com as evidências."
      }
      size="sm"
    >
      <Text variant="body-sm" color="var(--content-primary)">
        {nota.explicacao}
      </Text>
      <DataList
        size="sm"
        items={[
          { label: "Regra aplicada", value: `Limites de aprovação, linha ${linhaDoLimite(nota)}` },
          { label: "Fontes", value: "Nota da SEFAZ, ordem de compra, títulos do contas a pagar" },
        ]}
      />
    </Panel>
  );
}

const OUTRAS: Record<Acao, Acao[]> = {
  receber: ["receber_parcial", "recusar"],
  receber_parcial: ["receber", "recusar"],
  recusar: ["receber", "receber_parcial"],
};

/** A proposta aberta, numa gaveta como a do conector em Conexões. */
function PropostaAberta({ nota, onClose }: { nota: Nota; onClose: () => void }) {
  const { fonte, campos } = evidencia(nota);
  const alcada = podeAprovar(nota.nivel);
  return (
    <Drawer isOpen title={`Proposta da NF ${nota.numero}`} onClose={onClose} className="shell-connection-panel wf-proposta">
      <div className="wf-drawer">
        <div className="wf-badges">
          <StatusBadge tone={SITUACAO_TOM[nota.situacao]}>{SITUACAO[nota.situacao]}</StatusBadge>
          <StatusBadge variant="soft" tone={NIVEL_TOM[nota.nivel]}>
            Nível {NIVEL[nota.nivel]}
          </StatusBadge>
        </div>
        <DataList
          divided
          items={[
            { label: "Ação na doca proposta", value: <StatusBadge size="sm" tone={ACAO_TOM[nota.acao]}>{ACAO[nota.acao]}</StatusBadge> },
            { label: "Valor em risco", value: reais(nota.risco), emphasis: true },
            { label: "Valor da nota", value: reais(nota.valor) },
            { label: "Fornecedor", value: nota.bloqueado ? `${nota.fornecedor} (pagamento bloqueado)` : nota.fornecedor },
            { label: "Destino", value: nota.destino },
            { label: "Ordem de compra", value: nota.ordem, mono: true },
            { label: "Chave de acesso", value: nota.chave, mono: true },
          ]}
        />
        <Block title="Evidência por divergência" size="sm">
          <Panel
            title={EXCECAO[nota.classificacao]}
            description={`Evidência: ${fonte}`}
            size="sm"
            padding="md"
          >
            <ReconciliationDiff columns={["Fonte", "Nota fiscal"]} fields={campos} showSummary variant="grid" />
          </Panel>
        </Block>
        <Dossie nota={nota} />
        {alcada ? (
          <DecisionForm<string>
            title="Sua decisão"
            description="Aprovar mantém a ação proposta. Alterar troca a ação e pede justificativa. A decisão é registrada uma vez."
            defaultValue="aprovar"
            minNoteLength={10}
            onSubmit={() => undefined}
            texts={{ noteLabel: "Justificativa", submit: "Registrar a decisão", done: "Decisão registrada. A doca e o contas a pagar já recebem a ação." }}
            options={[
              { value: "aprovar", label: `Aprovar: ${ACAO[nota.acao].toLowerCase()}`, tone: "positive" },
              ...OUTRAS[nota.acao].map((acao) => ({
                value: acao,
                label: `Alterar para ${ACAO[acao].toLowerCase()}`,
                tone: "waiting" as const,
                noteRequired: true,
              })),
            ]}
          />
        ) : (
          <Alert
            variant="warning"
            title={`Esta proposta pede o nível ${NIVEL[nota.nivel].toLowerCase()}.`}
            description={`Seu nível é ${NIVEL[MEU_NIVEL].toLowerCase()}: você vê a proposta, sem aprovar. Quem aprova recebe o aviso por e-mail.`}
          />
        )}
      </div>
    </Drawer>
  );
}

// ———————————————————————————————————————— Lista do dia

type FiltroDia = "todas" | "aguardando" | "decididas" | "regra";

export function ListaDoDia({ state, aprovadas }: { state: LoadState; aprovadas: boolean }) {
  const NOTAS = useMemo(() => notasDe(aprovadas), [aprovadas]);
  const notas = useMemo(() => NOTAS.filter((n) => n.data === HOJE), [NOTAS]);
  const [filtro, setFiltro] = useState<FiltroDia>("todas");
  const de = (f: FiltroDia) =>
    notas.filter(
      (n) =>
        f === "todas" ||
        (f === "aguardando" && n.situacao === "aguardando") ||
        (f === "decididas" && (n.situacao === "aprovada" || n.situacao === "alterada")) ||
        (f === "regra" && n.situacao === "regra")
    );
  const total = notas.reduce((s, n) => s + n.valor, 0);
  const risco = notas.reduce((s, n) => s + n.risco, 0);

  return (
    <Screen
      title="Lista do dia"
      subtitle={`Todas as notas fiscais que chegaram hoje, ${dia(HOJE)}, com a proposta e a situação de cada uma.`}
      state={state}
      loadingLabel="Carregando as notas do dia…"
      errorTitle="Não consegui ler as notas de hoje agora"
      emptyLabel="Nenhuma nota fiscal chegou hoje. As notas aparecem aqui quando o conector da SEFAZ as recebe."
    >
      <StatGrid columns={4}>
        <Stat caption="Notas do dia" value={notas.length} context={reaisCurto(total)} />
        <Stat caption="Liberadas pela regra" value={de("regra").length} context="sem pessoa" tone="positive" />
        <Stat caption="Aguardando aprovação" value={de("aguardando").length} context="na fila" tone="waiting" />
        <Stat caption="Valor em risco" value={reaisCurto(risco)} context="soma do dia" tone="negative" />
      </StatGrid>
      <div className="shell-connections-toolbar">
        <Filters<FiltroDia>
          label="Filtrar por situação"
          value={filtro}
          onChange={setFiltro}
          options={[
            { key: "todas", label: "Todas", count: notas.length },
            { key: "aguardando", label: "Aguardando aprovação", count: de("aguardando").length, state: "warning" },
            { key: "decididas", label: "Decididas", count: de("decididas").length, state: "success" },
            { key: "regra", label: "Liberadas pela regra", count: de("regra").length, state: "default" },
          ]}
        />
      </div>
      <Table
        data={de(filtro)}
        rowKey={(n) => n.id}
        size="md"
        emptyText="Nenhuma nota nesta situação."
        columns={[
          notaCol,
          { key: "destino", title: "Destino", dataIndex: "destino" },
          excecaoCol,
          acaoCol,
          nivelCol,
          {
            key: "situacao",
            title: "Situação",
            dataIndex: "situacao",
            render: (_, n) => (
              <StatusBadge size="sm" tone={SITUACAO_TOM[n.situacao]}>
                {SITUACAO[n.situacao]}
              </StatusBadge>
            ),
          },
          riscoCol,
        ]}
      />
    </Screen>
  );
}

// ———————————————————————————————————————— Notas duplicadas

export function NotasDuplicadas({ state, aprovadas }: { state: LoadState; aprovadas: boolean }) {
  const NOTAS = useMemo(() => notasDe(aprovadas), [aprovadas]);
  const duplicadas = useMemo(() => NOTAS.filter((n) => n.classificacao === "E6" && n.original), [NOTAS]);
  const [aberta, setAberta] = useState<string | null>(null);
  const barrado = duplicadas.reduce((s, n) => s + n.risco, 0);
  const nota = duplicadas.find((n) => n.id === aberta);

  return (
    <Screen
      title="Notas duplicadas"
      subtitle="Cada nota que cobra uma compra já cobrada, ao lado da original. O título fica bloqueado: ninguém paga até a coordenação resolver."
      state={state}
      loadingLabel="Procurando duplicidades…"
      errorTitle="Não consegui ler as duplicidades agora"
      emptyLabel="Nenhuma nota duplicada neste mês. Quando uma nota cobrar uma compra já cobrada, ela aparece aqui, bloqueada."
    >
      <StatGrid columns={3}>
        <Stat caption="Duplicadas no mês" value={duplicadas.length} context="títulos bloqueados" tone="negative" />
        <Stat caption="Valor barrado" value={reaisCurto(barrado)} context="não pago duas vezes" tone="positive" />
        <Stat
          caption="Como chegaram"
          value={`${duplicadas.filter((n) => n.original?.como === "mesma chave").length} · ${duplicadas.filter((n) => n.original?.como === "mesma ordem").length}`}
          context="mesma chave · nota nova, mesma ordem"
        />
      </StatGrid>
      <Table
        data={duplicadas}
        rowKey={(n) => n.id}
        size="md"
        onRowClick={(n) => setAberta(n.id)}
        columns={[
          {
            key: "dup",
            title: "Nota duplicada",
            dataIndex: "numero",
            render: (_, n) => <Duas top={`NF ${n.numero} · ${dia(n.data)}`} bottom={`${n.fornecedor} · ${n.canal}`} />,
          },
          {
            key: "orig",
            title: "Nota original",
            dataIndex: "original",
            render: (_, n) => <Duas top={`NF ${n.original?.numero} · ${dia(n.original?.data ?? "")}`} bottom={`lançada · ${n.original?.ordem}`} />,
          },
          {
            key: "como",
            title: "Por quê",
            dataIndex: "id",
            render: (_, n) => (
              <StatusBadge size="sm" tone="neutral">
                {n.original?.como === "mesma chave" ? "Mesma chave de acesso" : "Nota nova, ordem já atendida"}
              </StatusBadge>
            ),
          },
          {
            key: "barrado",
            title: "Valor barrado",
            dataIndex: "risco",
            align: "right",
            render: (_, n) => <b>{reais(n.risco)}</b>,
          },
          {
            key: "sit",
            title: "Título",
            dataIndex: "situacao",
            render: () => (
              <StatusBadge size="sm" tone="negative">
                Bloqueado
              </StatusBadge>
            ),
          },
        ]}
      />
      {nota !== undefined ? (
        <Drawer isOpen title={`NF ${nota.numero}, duplicada`} onClose={() => setAberta(null)} className="shell-connection-panel">
          <div className="wf-drawer">
            <Alert variant="error" title="Título bloqueado" description="A coordenação resolve. A nota duplicada é recusada e não vai a pagamento." />
            <ReconciliationDiff
              columns={[`Original · NF ${nota.original?.numero}`, `Duplicada · NF ${nota.numero}`]}
              fields={[
                { label: "Chave de acesso", a: nota.original?.como === "mesma chave" ? "igual" : "outra", b: nota.original?.como === "mesma chave" ? "igual" : "outra", state: nota.original?.como === "mesma chave" ? "match" : "divergent" },
                { label: "Ordem de compra", a: nota.original?.ordem, b: nota.ordem, state: "match" },
                { label: "Valor", a: reais(nota.original?.valor ?? 0), b: reais(nota.valor), state: "match" },
                { label: "Chegou por", a: nota.original?.canal, b: nota.canal },
                { label: "Data", a: dia(nota.original?.data ?? ""), b: dia(nota.data) },
              ]}
            />
            <DataList items={[{ label: "Valor barrado", value: reais(nota.risco), emphasis: true }]} />
          </div>
        </Drawer>
      ) : null}
    </Screen>
  );
}

// ———————————————————————————————————————— Doca

export function Doca({ state, aprovadas }: { state: LoadState; aprovadas: boolean }) {
  const NOTAS = useMemo(() => notasDe(aprovadas), [aprovadas]);
  const destinos = useMemo(() => [...new Set(NOTAS.filter((n) => n.data >= "2026-11-11").map((n) => n.destino))].sort(), [NOTAS]);
  const [destino, setDestino] = useState("CD-03");
  const notas = NOTAS.filter((n) => n.data >= "2026-11-11" && n.destino === destino).sort((a, b) => a.numero - b.numero);
  const aguardando = notas.filter((n) => n.situacao === "aguardando").length;

  return (
    <Screen
      title="Doca"
      subtitle="As notas que chegam hoje neste destino e o que fazer com cada caminhão. Nada é descarregado antes da decisão."
      actions={
        <div className="wf-select">
          <Select
            size="sm"
            value={destino}
            onChange={setDestino}
            options={destinos.map((d) => ({ value: d, label: d }))}
          />
        </div>
      }
      state={state}
      loadingLabel="Carregando as notas da doca…"
      errorTitle="Não consegui ler as notas desta doca agora"
      emptyLabel={`Nenhuma nota com entrega prevista hoje na ${destino}.`}
    >
      {aguardando > 0 ? (
        <Alert
          variant="warning"
          title={`${aguardando} ${aguardando === 1 ? "nota aguarda" : "notas aguardam"} aprovação.`}
          description="Segure o caminhão: a ação aparece aqui assim que a pessoa decidir."
        />
      ) : null}
      <Table
        data={notas}
        rowKey={(n) => n.id}
        size="md"
        columns={[
          notaCol,
          {
            key: "itens",
            title: "Itens",
            dataIndex: "itens",
            render: (_, n) => <Duas top={`${n.itens.length} ${n.itens.length === 1 ? "item" : "itens"}`} bottom={n.itens.map((i) => i.desc).join(", ")} />,
          },
          {
            key: "acao",
            title: "O que fazer",
            dataIndex: "acao",
            render: (_, n) =>
              n.situacao === "aguardando" ? (
                <Duas
                  top={
                    <StatusBadge size="sm" tone="waiting">
                      Aguardando aprovação
                    </StatusBadge>
                  }
                  bottom="Não descarregue ainda"
                />
              ) : (
                <Duas
                  top={
                    <StatusBadge size="sm" variant="solid" tone={ACAO_TOM[n.acao]}>
                      {ACAO[n.acao]}
                    </StatusBadge>
                  }
                  bottom={
                    n.acao === "recusar"
                      ? "Devolva o caminhão inteiro"
                      : n.acao === "receber"
                        ? "Descarregue tudo"
                        : resumo(n)
                  }
                />
              ),
          },
        ]}
      />
    </Screen>
  );
}

// ———————————————————————————————————————— Valor barrado

export function ValorBarrado({ state, aprovadas }: { state: LoadState; aprovadas: boolean }) {
  const NOTAS = useMemo(() => notasDe(aprovadas), [aprovadas]);
  const decididas = NOTAS.filter((n) => n.situacao === "aprovada" || n.situacao === "alterada");
  const barrado = decididas.reduce((s, n) => s + n.risco, 0);
  const emRisco = NOTAS.filter((n) => n.situacao === "aguardando").reduce((s, n) => s + n.risco, 0);
  const propostas = NOTAS.filter((n) => n.nivel !== "regra");
  const porDia = useMemo(() => {
    const dias = [...new Set(propostas.map((n) => n.data))].sort();
    let barradoAte = 0;
    let propostoAte = 0;
    return dias.map((d) => {
      const doDia = propostas.filter((n) => n.data === d);
      barradoAte += doDia.filter((n) => n.situacao === "aprovada").reduce((s, n) => s + n.risco, 0);
      propostoAte += doDia.filter((n) => n.situacao === "aguardando").reduce((s, n) => s + n.risco, 0);
      return { dia: dia(d), barrado: Math.round(barradoAte), proposto: Math.round(propostoAte), meta: META_MES };
    });
  }, [propostas]);
  const porExcecao = (["E6", "E7", "E5", "E8", "E2", "E1", "E3", "E4"] as const)
    .map((c) => {
      const notas = propostas.filter((n) => n.classificacao === c);
      return { key: c, label: EXCECAO[c], value: notas.reduce((s, n) => s + n.risco, 0), meta: `${notas.length} notas` };
    })
    .filter((item) => item.value > 0);

  return (
    <Screen
      title="Valor barrado"
      subtitle="Quanto a conferência impediu de pagar errado neste mês, contra os R$ 543 mil por mês que a Já Chegou pagava sem a mercadoria."
      state={state}
      loadingLabel="Somando o valor barrado…"
      errorTitle="Não consegui somar o valor barrado agora"
      emptyLabel="Nada barrado neste mês ainda. O valor aparece aqui assim que a primeira proposta for aprovada."
    >
      <StatGrid columns={3}>
        <Stat caption="Barrado em novembro" value={reaisCurto(barrado)} context="propostas aprovadas" tone="positive" />
        <Stat caption="Contra o pagar errado" value={`${Math.round((barrado / META_MES) * 100)}%`} context={`de ${reaisCurto(META_MES)} por mês; ${Math.round(((barrado + emRisco) / META_MES) * 100)}% com tudo aprovado`} />
        <Stat caption="Ainda em risco" value={reaisCurto(emRisco)} context="aguardando aprovação" tone="waiting" />
      </StatGrid>
      <Panel title="O mês contra os R$ 543 mil" size="sm">
        <ProgressBar
          max={META_MES}
          showLegend
          valueText={`${reaisCurto(barrado + emRisco)} de ${reaisCurto(META_MES)}`}
          segments={[
            { value: barrado, tone: "positive", label: "Barrado" },
            { value: emRisco, tone: "waiting", label: "Aguardando aprovação" },
          ]}
        />
      </Panel>
      <div className="wf-grid-2">
        <Panel title="Acumulado no mês" size="sm">
          <LineChart
            data={porDia}
            xKey="dia"
            series={[
              { key: "barrado", label: "Barrado (aprovado)" },
              { key: "proposto", label: "Proposto, aguardando aprovação", color: toneColor.waiting },
              { key: "meta", label: "R$ 543 mil por mês", dashed: true, color: toneColor.negative },
            ]}
            height={220}
            formatValue={reais}
            formatAxis={(v) => `${Math.round(v / 1000)} mil`}
            ariaLabel="Valor barrado acumulado por dia, contra R$ 543 mil"
          />
        </Panel>
        <Panel title="Valor em risco por tipo de divergência" size="sm">
          <RankingBars items={porExcecao} formatValue={reaisCurto} tone="positive" />
        </Panel>
      </div>
    </Screen>
  );
}
