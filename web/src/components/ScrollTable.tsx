import { useEffect, useRef, type ReactElement, type ReactNode } from "react";
import { Alert, Button, Text } from "barte-design-system";
import { CheckCircle, WarningCircle } from "@phosphor-icons/react";
import { RowTable, type RowTableProps } from "./RowTable";
import { texts } from "../texts";

/** #160 O que aparece abaixo da última linha: nada, o esqueleto do próximo bloco, a faixa de erro do bloco ou o fim da lista. */
export type Phase = "idle" | "loading-next" | "error-next" | "end";

type Cols<T extends object> = RowTableProps<T>["columns"];

export interface ScrollTableProps<T extends { key: string }> {
  rows: T[];
  columns: Cols<T>;
  /** #160 `total` da API: a lista inteira, a mesma em toda página. O contador e o rodapé dizem este número, nunca `rows.length`. */
  total: number;
  /** #160 Em que ponto está a busca de blocos. Quem decide é a camada de estado; a tabela só desenha. */
  phase: Phase;
  /** #160 Quantas linhas de esqueleto aparecem em `loading-next`. */
  skeletonRows?: number;
  /** #160 Uma ação da tela, à esquerda do contador (a pílula de filtro da fila). */
  toolbar?: ReactNode;
  /** #160 "Carregando…" no lugar do número, enquanto a lista recarrega do início. */
  counterBusy?: boolean;
  /** #160 Mostra o aviso de uma linha de que a lista recomeçou do início (`cursor_invalido`). */
  restarted?: boolean;
  /** #160 Cada mudança do valor leva a caixa de volta ao topo (a lista recomeçou: troca de filtro ou `cursor_invalido`). */
  resetKey?: number;
  onOpenRow: (row: T) => void;
  rowLabel: (row: T) => string;
  /** #160 Perto do fim da caixa: pede o próximo bloco pelo `nextCursor`. Sem ele, a tabela não observa nada (tela sem paginação). */
  onNearEnd?: () => void;
  /** #160 O "Tentar de novo" da faixa de erro: repete o mesmo cursor. */
  onRetry?: () => void;
  /** #160 O nome acessível da caixa que rola. */
  label: string;
}

type SkeletonRow = { key: string; skeleton: true };

/** #160 A largura de cada barra do esqueleto, em porcentagem da célula, para a fila não parecer uma grade. */
const SKELETON_WIDTHS = [78, 64, 40, 70, 52, 66, 58, 46];

const isSkeleton = (row: object): row is SkeletonRow => "skeleton" in row;

/** #160 A folga abaixo da caixa em que o bloco seguinte já é pedido, para chegar antes de a pessoa ver o fim. */
const NEAR_END_MARGIN = "0px 0px 240px 0px";

/**
 * #160 A tabela compartilhada das listas por blocos: compõe o `RowTable` da #209 (a linha abre a gaveta) com cabeçalho fixo,
 * linhas de esqueleto, contador no topo, rodapé de fim, faixa de erro do bloco e o aviso de recomeço. É apresentacional e
 * controlada por props: expõe o ponto de observação (a marca no fim da caixa, com a caixa como root do IntersectionObserver)
 * e avisa por `onNearEnd`; quem busca é a camada de estado. A rolagem é da caixa, não da página: é o que deixa o
 * `position: sticky` do cabeçalho valer, porque o `Table` do DS embrulha a tabela em dois `overflow`.
 */
export function ScrollTable<T extends { key: string }>({
  rows, columns, total, phase, skeletonRows = 3, toolbar, counterBusy, restarted, resetKey, onOpenRow, rowLabel, onNearEnd, onRetry, label,
}: ScrollTableProps<T>): ReactElement {
  const box = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  /** #160 O pedido mais recente, lido pelo observador: um `onNearEnd` novo a cada render não refaz a observação. */
  const nearEnd = useRef(onNearEnd);
  // #160 Atualizado depois de cada desenho, não durante ele.
  useEffect(() => {
    nearEnd.current = onNearEnd;
  });
  // #160 A caixa volta ao topo quando a lista recomeça; sem `resetKey`, a rolagem é de quem rola.
  useEffect(() => {
    if (resetKey !== undefined && box.current) box.current.scrollTop = 0;
  }, [resetKey]);
  const observing = onNearEnd !== undefined && phase === "idle";

  useEffect(() => {
    const root = box.current;
    const mark = sentinel.current;
    if (!observing || !root || !mark) return;
    const observer = new IntersectionObserver((entries) => entries.some((entry) => entry.isIntersecting) && nearEnd.current?.(), {
      root,
      rootMargin: NEAR_END_MARGIN,
    });
    observer.observe(mark);
    return () => observer.disconnect();
    // #160 Cada bloco novo cresce a lista e refaz a observação: se a marca ainda estiver à vista, o observador avisa de novo.
  }, [observing, rows.length]);

  const skeleton: SkeletonRow[] = phase === "loading-next" ? Array.from({ length: skeletonRows }, (_, i) => ({ key: `__skeleton${i}`, skeleton: true })) : [];
  const data: (T | SkeletonRow)[] = [...rows, ...skeleton];
  const wrapped = columns.map((column, at) => ({
    ...column,
    render: (value: unknown, row: T | SkeletonRow, index: number): ReactNode =>
      isSkeleton(row) ? (
        <span className="pagar-skeleton" style={{ width: `${SKELETON_WIDTHS[at % SKELETON_WIDTHS.length]}%` }} aria-hidden="true" />
      ) : column.render ? (
        (column.render as (v: unknown, r: T, i: number) => ReactNode)(value, row, index)
      ) : (
        (value as ReactNode)
      ),
  }));

  return (
    <div className="pagar-list">
      <div className="pagar-list-toolbar">
        <div>{toolbar}</div>
        <Text as="span" variant="body-sm" color="var(--content-secondary)" role="status">
          {counterBusy ? texts.scrollTable.counterBusy : <b className="pagar-list-counter">{texts.common.noteWord(total)}</b>}
        </Text>
      </div>
      {restarted ? <Alert variant="info" title={texts.scrollTable.restarted} showCloseButton={false} /> : null}
      <div className="pagar-scroll" ref={box} role="region" aria-label={label} tabIndex={-1}>
        <RowTable<T | SkeletonRow>
          data={data}
          // #160 O `render` embrulhado aceita também a linha de esqueleto; o `RowTable` só a conhece por este tipo.
          columns={wrapped as unknown as RowTableProps<T | SkeletonRow>["columns"]}
          rowKey={(row) => row.key}
          size="md"
          emptyText={texts.scrollTable.empty}
          rowInert={isSkeleton}
          onOpenRow={(row) => !isSkeleton(row) && onOpenRow(row)}
          rowLabel={(row) => (isSkeleton(row) ? texts.scrollTable.loadingRow : rowLabel(row))}
        />
        {phase === "error-next" ? (
          <div className="pagar-block-error" role="alert">
            <WarningCircle size={20} weight="fill" color="var(--accent-red)" />
            <div>
              <Text variant="label-sm">{texts.scrollTable.blockErrorTitle}</Text>
              <Text variant="body-xs" color="var(--content-secondary)">
                {texts.scrollTable.blockErrorDescription(rows.length)} {texts.common.errorDescription}
              </Text>
            </div>
            <Button variant="outline" size="sm" onClick={onRetry}>{texts.common.retry}</Button>
          </div>
        ) : null}
        {phase === "end" && rows.length > 0 ? (
          <div className="pagar-list-end" role="status">
            <CheckCircle size={18} weight="fill" color="var(--content-tertiary)" />
            <Text variant="body-sm" color="var(--content-tertiary)">{texts.scrollTable.endOfList(total)}</Text>
          </div>
        ) : null}
        <div ref={sentinel} className="pagar-list-sentinel" aria-hidden="true" />
      </div>
    </div>
  );
}
