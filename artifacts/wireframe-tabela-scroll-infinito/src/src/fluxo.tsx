import type { ReactNode } from "react";
import { Alert, Table, Text } from "barte-design-system";
import { GridBadge } from "@portal/components/GridBadge";

const code = (s: string): ReactNode[] => s.split("`").map((p, i) => (i % 2 ? <code key={i}>{p}</code> : p));

function Step({ n, title, children, tone = "neutral" }: { n: string; title: string; children?: ReactNode; tone?: "neutral" | "info" | "negative" | "waiting" | "positive" }) {
  return (
    <div className="wf-step" data-tone={tone}>
      <GridBadge tone={tone}>{n}</GridBadge>
      <div>
        <Text variant="label-sm">{title}</Text>
        {children ? <Text variant="body-xs" color="var(--content-secondary)">{typeof children === "string" ? code(children) : children}</Text> : null}
      </div>
    </div>
  );
}
const Arrow = ({ label }: { label?: string }) => <div className="wf-arrow" aria-hidden="true">↓{label ? <span>{code(label)}</span> : null}</div>;

type FilterRow = { key: string; screen: string; where: string; does: string; proposal: string };
const FILTERS: FilterRow[] = [
  { key: "1", screen: "Fila", where: "routes/fila.tsx:28 (e approval/labels.ts:29-34)", does: "Ordena as notas no cliente por nível e valor em risco (`byQueueOrder`).", proposal: "Some. A ordem é a do servidor (nível, valor em risco, chave de acesso), já no contrato do #307. Ordenar o carregado no cliente só embaralha o que a pessoa já viu." },
  { key: "2", screen: "Fila", where: "routes/fila.tsx:27, 29-30 e 59-66", does: "Chip \"Todas | Minhas\": filtra por `canApprove` no cliente e conta cada chip pelo que carregou.", proposal: "DECISÃO ABERTA. (A) filtro vira parâmetro da API (`?pode_aprovar=1`), o chip \"Minhas\" usa `aggregates.approvable` e a lista recomeça do início; (B) o chip some e a linha já fica esmaecida com cadeado (#133). O #307 NÃO aceita esse parâmetro: é fronteira com o backend. Recomendo A; B é o plano se o backend não puder entrar neste ciclo." },
  { key: "3", screen: "Fila", where: "routes/fila.tsx:38-39 e 55", does: "Soma o valor em risco, conta as bloqueadas e as aguardando, no cliente.", proposal: "`aggregates.amountAtRisk`, `blocked` e `total`. Sem decisão: é o AC-4." },
  { key: "4", screen: "Lista do dia", where: "routes/lista-do-dia.tsx:32 e 53-55", does: "Conta as aprovadas pela regra e os títulos no cliente; soma vem de `data.total.cents`.", proposal: "`aggregates.approvedByRule`, `total` e `aggregates.toPay`. Atenção: `total` muda de sentido com cursor (soma sem cursor, contagem com cursor). Não há filtro nem ordem no cliente." },
  { key: "5", screen: "Duplicadas", where: "routes/duplicadas.tsx:84-85 e 108-112", does: "Soma o valor barrado e conta cada motivo no cliente. A abertura da gaveta procura a nota em `duplicates` (:86).", proposal: "`aggregates.blockedAmount` e `byReason`. A gaveta só abre linha carregada, então o `find` continua valendo. Não há filtro nem ordem." },
  { key: "6", screen: "Doca e recebimento na loja", where: "routes/doca.tsx:97-105 e 115", does: "O seletor de destino já é parâmetro (`destino`/`loja`); `awaiting` vem do topo da resposta.", proposal: "Nada no filtro: trocar o destino recomeça a lista (o cursor só vale para o destino em que nasceu). `awaiting` passa a `aggregates.awaiting`." },
  { key: "7", screen: "Todas as quatro", where: "fila.tsx:152, duplicadas.tsx:182, doca.tsx:214 (`onDecided={retry}`)", does: "Depois de decidir na gaveta, recarrega a lista inteira.", proposal: "DECISÃO ABERTA. Com blocos, recarregar tudo joga a pessoa de volta ao topo e perde o que ela rolou. Proposta: a linha decidida sai da lista carregada, o contador e os números do topo se atualizam, e a rolagem fica." },
  { key: "8", screen: "Recebimento na loja", where: "routes/recebimento-loja.tsx (reusa `ReceivingBoard`)", does: "Mesmo quadro da doca, com `loja` no lugar de `destino`.", proposal: "Igual à doca." },
  { key: "9", screen: "Busca", where: "nenhum", does: "Nenhuma das quatro telas tem campo de busca hoje.", proposal: "Fora de escopo. Se vier, é parâmetro da API como o filtro da fila." },
];

/** O fluxo entre os estados e as decisões abertas. */
export function FluxoScreen() {
  return (
    <div className="shell-home pagar-screen">
      <div className="wf-stack">
        <Text variant="label-lg">Fluxo entre os estados</Text>
        <div className="wf-flow">
          <Step n="1" title="Primeira carga" tone="info">Spinner da tela (`LoadFeedback`), `limite` padrão de 30. Os números do topo ainda não existem.</Step>
          <Arrow label="falhou" />
          <Step n="6" title="Erro na primeira carga" tone="negative">O erro de hoje, com "Tentar de novo". Volta ao passo 1.</Step>
          <Arrow label="veio vazio" />
          <Step n="5" title="Lista vazia" tone="neutral">O `EmptyState` de hoje. Não há tabela, nem contador.</Step>
          <Arrow label="veio com notas" />
          <Step n="2" title="Lista rolando" tone="positive">Cabeçalho fixo, contador "N notas" no topo, números do topo dos agregados.</Step>
          <Arrow label="chegou a 240 px do fim e há `nextCursor`" />
          <Step n="3" title="Carregando o próximo bloco" tone="waiting">Três linhas de esqueleto abaixo da última nota; o que já carregou fica como está.</Step>
          <Arrow label="o bloco chegou" />
          <Step n="2" title="Volta à lista rolando" tone="positive">Se o `nextCursor` veio nulo, vai para o passo 4.</Step>
          <Arrow label="o `nextCursor` veio nulo" />
          <Step n="4" title="Fim da lista" tone="neutral">Rodapé "Você viu todas as N notas". Nenhuma busca nova.</Step>
        </div>
        <div className="wf-flow wf-flow-side">
          <Step n="7" title="Erro ao buscar um bloco do meio" tone="negative">As notas carregadas ficam. Faixa abaixo da última linha com "Tentar de novo": pede de novo o MESMO cursor, e volta ao passo 3. Nenhum número do topo muda.</Step>
          <Step n="8" title="Muda o filtro (ou a busca)" tone="waiting">A caixa volta ao topo, a lista esvazia e recarrega do início com esqueleto; o contador diz "Carregando…" e os números do topo ficam. Volta ao passo 2.</Step>
          <Step n="8b" title="cursor_invalido (400)" tone="waiting">Acontece quando o cursor foi emitido para outro filtro, ou a lista mudou. A tela recomeça do início, uma vez, e avisa numa linha; se falhar de novo, é o passo 6.</Step>
          <Step n="9" title="Linha focada e gaveta aberta" tone="info">Tab entra na linha, Enter ou espaço abre a gaveta (#209). Fechar devolve o foco à linha. Blocos novos entram abaixo sem tirar o foco.</Step>
        </div>

        <Text variant="label-lg">Filtros, buscas e ordenações no cliente, e o que fazer com elas</Text>
        <Text variant="body-base" color="var(--content-secondary)">
          Com páginas, o cliente só vê o que carregou: filtrar ou ordenar o carregado mente sobre a lista. Cada linha abaixo é uma que existe hoje.
        </Text>
        <Table<FilterRow>
          data={FILTERS}
          rowKey={(r) => r.key}
          size="md"
          columns={[
            { key: "screen", title: "Tela", dataIndex: "screen", render: (_, r) => <b>{r.screen}</b> },
            { key: "where", title: "Onde", dataIndex: "where", render: (_, r) => code(`\`${r.where}\``) },
            { key: "does", title: "O que faz hoje", dataIndex: "does", render: (_, r) => code(r.does) },
            { key: "proposal", title: "Proposta", dataIndex: "proposal", render: (_, r) => code(r.proposal) },
          ]}
        />

        <Text variant="label-lg">Decisões abertas, para o dono do desenho</Text>
        <Alert variant="warning" title="D1. O chip “Minhas” da fila" description="Opção A: vira parâmetro da API (precisa de uma issue de backend, o #307 não o aceita). Opção B: o chip some. Hoje ele conta e filtra só o que carregou, o que não pode ficar." />
        <Alert variant="warning" title="D2. Onde a tabela rola" description="A: a própria caixa da tabela rola (a altura é a da janela menos o que está acima dela) e o cabeçalho fica fixo nela. É o que está desenhado. B: a página rola e o cabeçalho cola no topo do conteúdo; exige tirar os dois overflow do Table do DS e perde a rolagem horizontal da #222. O shell já tem uma rolagem própria (.bsk-content): A cria uma segunda dentro dela." />
        <Alert variant="warning" title="D3. Depois de decidir na gaveta" description="A linha sai da lista e os números do topo se atualizam, sem voltar ao topo (proposto). A alternativa é recarregar do início, como hoje." />
        <Alert variant="warning" title="D4. O aviso do cursor inválido" description="A tela recomeça sozinha e mostra uma linha de aviso (desenhado). A alternativa é recomeçar sem dizer nada." />
        <Alert variant="info" title="Fronteira com o backend" description="Não resolvida aqui: parâmetro de filtro da fila e um agregado para o chip “Todas” quando o filtro “Minhas” estiver ligado (o total passaria a ser o da lista filtrada). O contrato do #307 não os traz." />
      </div>
    </div>
  );
}
