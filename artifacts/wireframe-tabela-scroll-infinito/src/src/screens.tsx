import type { ReactNode } from "react";
import { Alert, Drawer, Table, Text } from "barte-design-system";
import { DataList, Stat, StatGrid, formatCurrency } from "@barte-ai-services/barte-ui-kit";
import { Screen } from "@portal/components/Screen";
import { EmptyState } from "@portal/components/EmptyState";
import { GridFilter } from "@portal/components/GridFilter";
import { GridBadge } from "@portal/components/GridBadge";
import { InvoiceCell } from "@portal/components/InvoiceCell";
import { DecidedBy } from "@portal/components/DecidedBy";
import { ACTION_LABEL, ACTION_TONE, LEVEL_LABEL, LEVEL_TONE, codeLabel } from "@portal/approval/labels";
import { texts } from "@portal/texts";
import { ScrollTable, type Phase, type Scroll } from "./scroll-table";
import { AGG_FILA, AGG_HOJE, FILA, type FilaRow, type HojeRow } from "./data";

/** O que a tela precisa saber para se desenhar; no desenho estático vem do estado escolhido, ao vivo vem da carga simulada. */
export interface View<T> {
  load: "loading" | "error" | "empty" | "ready";
  rows: T[];
  total: number;
  phase: Phase;
  scroll: Scroll;
  skeletonRows: number;
  counterBusy: boolean;
  showLoaded: boolean;
  focusedKey: string | null;
  drawerKey: string | null;
  notice: ReactNode;
  live: boolean;
  nearEnd?: () => void;
  retry: () => void;
}

export type Filter = "all" | "mine";

const BRL_AGG = (cents: number) => formatCurrency(cents / 100);

function Drawn({ title, number, onClose }: { title: string; number: string; onClose: () => void }) {
  return (
    <Drawer isOpen title={title} onClose={onClose} className="shell-connection-panel">
      <div style={{ padding: "var(--spacing-lg)", display: "grid", gap: "var(--spacing-lg)" }}>
        <Alert variant="info" title="A gaveta é a da #209" description="Não muda nesta camada: a proposta, a decisão e o pedido ao fornecedor continuam como estão." showCloseButton={false} />
        <DataList items={[{ label: "Nota fiscal", value: `NF ${number}` }, { label: "Ao fechar", value: "o foco volta à linha que abriu a gaveta" }]} />
      </div>
    </Drawer>
  );
}

/** /pagar/fila com a tabela rolável. Stat e chips vêm de `aggregates`; a lista, de `items`. */
export function FilaScreen({ v, filter, onFilter, onRetryFirst, onDrawerClose }: { v: View<FilaRow>; filter: Filter; onFilter: (f: Filter) => void; onRetryFirst: () => void; onDrawerClose: () => void }) {
  const dim = (r: FilaRow, node: ReactNode): ReactNode =>
    r.canApprove ? node : <span className="pagar-dimmed" title={texts.fila.needsLevel(LEVEL_LABEL[r.requiredApproverLevel])}>{node}</span>;
  const c = texts.fila.columns;
  return (
    <>
      <Screen
        title={texts.fila.title}
        subtitle={texts.fila.subtitle}
        state={v.load}
        onRetry={onRetryFirst}
        loadingLabel={texts.fila.loading}
        errorTitle={texts.fila.error}
        emptyLabel={texts.fila.empty}
        empty={<EmptyState title={texts.emptyState.queue.title} description={texts.emptyState.queue.description} />}
      >
        {() => (
          <>
            <StatGrid columns={3}>
              <Stat caption={texts.fila.statWaiting.caption} value={FILA.length} context={texts.fila.statWaiting.context} />
              <Stat caption={texts.fila.statRisk.caption} value={BRL_AGG(AGG_FILA.amountAtRisk.cents)} context={texts.fila.statRisk.context} tone="waiting" />
              <Stat caption={texts.fila.statBlocked.caption} value={AGG_FILA.blocked} context={texts.fila.statBlocked.context} tone="negative" />
            </StatGrid>
            <ScrollTable<FilaRow>
              label="Fila de aprovação"
              rows={v.rows}
              total={v.total}
              phase={v.phase}
              skeletonRows={v.skeletonRows}
              scroll={v.scroll}
              counterBusy={v.counterBusy}
              showLoaded={v.showLoaded}
              focusedKey={v.focusedKey}
              notice={v.notice}
              onNearEnd={v.nearEnd}
              onRetry={v.retry}
              onOpenRow={() => undefined}
              rowLabel={(r) => texts.grid.openInvoice(r.number)}
              toolbar={
                <GridFilter
                  ariaLabel={texts.fila.filterLabel}
                  value={filter}
                  onChange={onFilter}
                  options={[
                    { value: "all", label: texts.fila.filterAll, count: 132 },
                    { value: "mine", label: texts.fila.filterMine, count: AGG_FILA.approvable },
                  ]}
                />
              }
              columns={[
                { key: "nota", title: c.invoice, dataIndex: "number", render: (_, r) => dim(r, <InvoiceCell number={r.number} issuedOn={r.issuedOn} bottom={r.supplierId} prefix={r.canApprove ? null : <span role="img" aria-label={texts.fila.noPermission}>🔒{" "}</span>} />) },
                { key: "classificacao", title: c.classification, dataIndex: "exceptionName", render: (_, r) => dim(r, <GridBadge tone="neutral">{r.exceptionName}</GridBadge>) },
                { key: "codigo", title: c.code, dataIndex: "exceptionCode", render: (_, r) => codeLabel(r.exceptionCode as never) },
                { key: "acao", title: c.action, dataIndex: "dockAction", render: (_, r) => dim(r, <GridBadge tone={ACTION_TONE[r.dockAction]}>{ACTION_LABEL[r.dockAction]}</GridBadge>) },
                { key: "nivel", title: c.level, dataIndex: "level", render: (_, r) => dim(r, <GridBadge tone={LEVEL_TONE[r.level]}>{LEVEL_LABEL[r.level]}</GridBadge>) },
                { key: "risco", title: c.risk, dataIndex: "risk", align: "right", render: (_, r) => dim(r, `${r.risk.text} de ${r.total.text}`) },
                { key: "encaminhada", title: c.forwardedTo, dataIndex: "requiredApproverLevel", render: (_, r) => dim(r, LEVEL_LABEL[r.requiredApproverLevel]) },
                { key: "decidedBy", title: texts.decidedBy.column, dataIndex: "key", render: (_, r) => dim(r, <GridBadge tone="waiting">{texts.decidedBy.awaiting}</GridBadge>) },
              ]}
            />
          </>
        )}
      </Screen>
      {v.drawerKey !== null ? <Drawn title={texts.fila.drawerTitle(v.rows.find((r) => r.key === v.drawerKey)?.number ?? null)} number={v.rows.find((r) => r.key === v.drawerKey)?.number ?? ""} onClose={onDrawerClose} /> : null}
    </>
  );
}

/** /pagar/hoje: a mesma tabela, sem filtro. */
export function HojeScreen({ v, onRetryFirst, onDrawerClose }: { v: View<HojeRow>; onRetryFirst: () => void; onDrawerClose: () => void }) {
  const c = texts.listaDoDia.columns;
  return (
    <>
      <Screen
        title={texts.listaDoDia.title}
        subtitle={texts.listaDoDia.subtitle}
        state={v.load}
        onRetry={onRetryFirst}
        loadingLabel={texts.listaDoDia.loading}
        errorTitle={texts.listaDoDia.error}
        emptyLabel={texts.listaDoDia.empty}
        empty={<EmptyState title={texts.emptyState.todayList.title} description={texts.emptyState.todayList.description} action={{ label: texts.emptyState.action, to: "/pagar/fila" }} />}
      >
        {() => (
          <>
            <StatGrid columns={3}>
              <Stat caption={texts.listaDoDia.statTitles.caption} value={87} context={texts.listaDoDia.statTitles.context} />
              <Stat caption={texts.listaDoDia.statToPay.caption} value={AGG_HOJE.toPay.text} context={texts.listaDoDia.statToPay.context} />
              <Stat caption={texts.listaDoDia.statByRule.caption} value={AGG_HOJE.approvedByRule} context={texts.listaDoDia.statByRule.context} tone="positive" />
            </StatGrid>
            <ScrollTable<HojeRow>
              label="Lista do dia"
              rows={v.rows}
              total={v.total}
              phase={v.phase}
              skeletonRows={v.skeletonRows}
              scroll={v.scroll}
              counterBusy={v.counterBusy}
              showLoaded={v.showLoaded}
              focusedKey={v.focusedKey}
              notice={v.notice}
              onNearEnd={v.nearEnd}
              onRetry={v.retry}
              onOpenRow={() => undefined}
              rowLabel={(r) => texts.grid.openInvoice(r.number)}
              columns={[
                { key: "nota", title: c.invoice, dataIndex: "number", render: (_, r) => <InvoiceCell number={r.number} bottom={r.supplierId} /> },
                { key: "excecao", title: c.classification, dataIndex: "exceptionName", render: (_, r) => <GridBadge tone="neutral">{r.exceptionName}</GridBadge> },
                { key: "codigo", title: c.code, dataIndex: "exceptionCode", render: (_, r) => codeLabel(r.exceptionCode as never) },
                { key: "acao", title: c.action, dataIndex: "dockAction", render: (_, r) => <GridBadge tone={ACTION_TONE[r.dockAction]}>{ACTION_LABEL[r.dockAction]}</GridBadge> },
                { key: "quem", title: c.approver, dataIndex: "approver", render: (_, r) => (r.approver === null ? "—" : <DecidedBy actor={r.approver === "regra" ? "rule" : "person"} name={r.approver === "regra" ? null : r.approver} />) },
                { key: "valor", title: c.amount, dataIndex: "amount", align: "right", render: (_, r) => `${r.amount.text} de ${r.invoiceTotal.text}` },
              ]}
            />
          </>
        )}
      </Screen>
      {v.drawerKey !== null ? <Drawn title={texts.fila.drawerTitle(v.rows.find((r) => r.key === v.drawerKey)?.number ?? null)} number={v.rows.find((r) => r.key === v.drawerKey)?.number ?? ""} onClose={onDrawerClose} /> : null}
    </>
  );
}

type ChangeRow = { key: string; screen: string; top: string; after: string; list: string; drawer: string };
const CHANGES: ChangeRow[] = [
  { key: "fila", screen: "Fila de aprovação", top: "Soma e conta o que carregou: `all.length`, `risk`, `blocked`", after: "`aggregates.approvable`, `amountAtRisk`, `blocked` e `total`", list: "Ordem do servidor; o chip \"Minhas\" precisa de decisão (ver Fluxo e decisões)", drawer: "Decidir tira a linha e atualiza os números do topo" },
  { key: "hoje", screen: "Lista do dia", top: "`items.length`, `total.cents` (soma) e as aprovadas pela regra, contadas no cliente", after: "`total` (contagem), `aggregates.toPay` e `approvedByRule`", list: "Sem filtro e sem ordem no cliente: a ordem é a chave de acesso", drawer: "Só leitura (abre a gaveta)" },
  { key: "duplicadas", screen: "Notas duplicadas", top: "`duplicates.length`, valor barrado e os dois motivos, somados no cliente", after: "`total`, `aggregates.blockedAmount` e `byReason`", list: "Sem filtro. Resposta nova: `items`, não mais `duplicates`/`count`", drawer: "`DuplicateDrawer` procura a linha em `items`; ao decidir, a lista não recomeça" },
  { key: "doca", screen: "Doca e recebimento na loja", top: "`awaiting` no alerta, vindo do topo da resposta", after: "`aggregates.awaiting` (o destino inteiro, não só o que carregou)", list: "O seletor de destino (ou loja) é parâmetro: trocar recomeça a lista do início, e o cursor não vale para outro destino", drawer: "Igual à fila: decidir tira a linha" },
];

/** O quadro do que muda nas telas que não desenhamos por inteiro: a tabela é a mesma. */
export function OutrasScreen() {
  const code = (s: string) => s.split("`").map((p, i) => (i % 2 ? <code key={i}>{p}</code> : p));
  return (
    <div className="shell-home pagar-screen">
      <div className="wf-stack">
        <Text variant="label-lg">A mesma tabela nas quatro telas e no recebimento na loja</Text>
        <Text variant="body-base" color="var(--content-secondary)">
          Fila e lista do dia estão desenhadas por inteiro nas outras abas. Duplicadas, doca e recebimento na loja têm o mesmo cabeçalho fixo, contador, linhas de esqueleto e rodapé; o que muda por tela é de onde saem os números do topo e como a gaveta reage.
        </Text>
        <Table<ChangeRow>
          data={CHANGES}
          rowKey={(r) => r.key}
          size="md"
          columns={[
            { key: "screen", title: "Tela", dataIndex: "screen", render: (_, r) => <b>{r.screen}</b> },
            { key: "top", title: "Números do topo hoje", dataIndex: "top", render: (_, r) => code(r.top) },
            { key: "after", title: "Números do topo com a paginação", dataIndex: "after", render: (_, r) => code(r.after) },
            { key: "list", title: "Filtro e ordem", dataIndex: "list", render: (_, r) => code(r.list) },
            { key: "drawer", title: "Gaveta", dataIndex: "drawer", render: (_, r) => code(r.drawer) },
          ]}
        />
        <Alert variant="warning" title="O tamanho do topo nunca pode vir da lista carregada" description="Com blocos de 30, o tamanho da lista carregada seria 30 e o número do topo mudaria a cada bloco. Todo número do topo sai de total ou de aggregates (AC-4)." />
      </div>
    </div>
  );
}
