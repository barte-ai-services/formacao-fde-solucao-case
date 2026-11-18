import { useEffect, useRef, type ReactElement, type ReactNode } from "react";
import { Button, Text } from "barte-design-system";
import { CheckCircle, WarningCircle } from "@phosphor-icons/react";
import { RowTable, type RowTableProps } from "@portal/components/RowTable";
import { texts } from "@portal/texts";

/** Onde a caixa de rolagem está parada no desenho: o estado pede o topo, o meio ou o fim da lista. */
export type Scroll = "top" | "middle" | "bottom";

/** Em que ponto está o carregamento de blocos (o que aparece abaixo da última linha). */
export type Phase = "idle" | "loading-next" | "error-next" | "end";

type Cols<T extends object> = RowTableProps<T>["columns"];

export interface ScrollTableProps<T extends { key: string }> {
  rows: T[];
  columns: Cols<T>;
  /** #160 `total` da API: a lista inteira, a mesma em toda página. */
  total: number;
  phase: Phase;
  /** #160 Quantas linhas de esqueleto, em `loading-next` (e na recarga do início). */
  skeletonRows?: number;
  scroll?: Scroll;
  /** #160 O texto de uma ação da tela, à esquerda do contador (a pílula de filtro da fila). */
  toolbar?: ReactNode;
  /** #160 Mostra "Carregando…" no lugar do número, enquanto a lista recarrega do início. */
  counterBusy?: boolean;
  /** #160 O que o contador diz do que está na tela ("30 de 132"). */
  showLoaded?: boolean;
  /** #160 A chave da linha que o teclado focou (e que a gaveta abriu). */
  focusedKey?: string | null;
  onOpenRow: (row: T) => void;
  rowLabel: (row: T) => string;
  /** #160 Perto do fim: pede o próximo bloco pelo `nextCursor`. */
  onNearEnd?: () => void;
  onRetry?: () => void;
  /** #160 Recado acima da tabela, dentro da área de rolagem não: ela não rola junto (o aviso do `cursor_invalido`). */
  notice?: ReactNode;
  label: string;
}

type SkelRow = { key: string; skeleton: true };

/**
 * PROPOSTA do componente compartilhado (#160). Compõe o `RowTable` da #209 (a linha abre a gaveta) com o que o kit não tem:
 * cabeçalho fixo, linhas de esqueleto, rodapé de fim da lista, faixa de erro do bloco e o contador no topo.
 * A rolagem é da caixa da tabela (não da página): é a única maneira de o cabeçalho ficar fixo, porque o `Table` do DS
 * embrulha a tabela em dois `overflow` que prendem o `position: sticky`.
 */
export function ScrollTable<T extends { key: string }>({
  rows, columns, total, phase, skeletonRows = 3, scroll = "top", toolbar, counterBusy, showLoaded, focusedKey,
  onOpenRow, rowLabel, onNearEnd, onRetry, notice, label,
}: ScrollTableProps<T>): ReactElement {
  const box = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  // #160 O desenho estático para a caixa no ponto que o estado mostra; ao vivo, quem rola é a pessoa.
  useEffect(() => {
    const el = box.current;
    if (!el || onNearEnd) return;
    el.scrollTop = scroll === "top" ? 0 : scroll === "bottom" ? el.scrollHeight : Math.round(el.scrollHeight / 4);
  }, [scroll, rows.length, phase, onNearEnd]);

  // A linha focada pelo teclado (#209): o realce do `:focus-visible`, também quando o foco é programático.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.querySelectorAll("[data-wf-focus]").forEach((tr) => tr.removeAttribute("data-wf-focus"));
    if (focusedKey == null) return;
    const index = rows.findIndex((r) => r.key === focusedKey);
    const tr = el.querySelectorAll<HTMLElement>("tbody tr")[index];
    tr?.setAttribute("data-wf-focus", "");
  });

  // #160 O gatilho: o IntersectionObserver olha uma marca no fim da lista, com 240 px de folga, para o bloco chegar antes do fim.
  useEffect(() => {
    if (!onNearEnd || phase !== "idle" || !sentinel.current || !box.current) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && onNearEnd(), {
      root: box.current,
      rootMargin: "0px 0px 240px 0px",
    });
    io.observe(sentinel.current);
    return () => io.disconnect();
  }, [onNearEnd, phase, rows.length]);

  const skeleton: SkelRow[] = phase === "loading-next" ? Array.from({ length: skeletonRows }, (_, i) => ({ key: `__sk${i}`, skeleton: true })) : [];
  const data = [...rows, ...skeleton] as (T | SkelRow)[];
  const isSkeleton = (r: T | SkelRow): r is SkelRow => "skeleton" in r;
  const wrapped = columns.map((c, ci) => ({
    ...c,
    render: (value: unknown, r: T | SkelRow, index: number) =>
      isSkeleton(r) ? <span className="wf-skel" style={{ width: `${[78, 64, 40, 70, 52, 66, 58, 46][ci % 8]}%` }} aria-hidden="true" /> : c.render ? (c.render as (v: unknown, r: T, i: number) => ReactNode)(value, r, index) : (value as ReactNode),
  }));

  return (
    <div className="wf-list">
      <div className="wf-toolbar">
        <div className="wf-toolbar-left">{toolbar}</div>
        <Text as="span" variant="body-sm" color="var(--content-secondary)" className="wf-counter" role="status">
          {counterBusy ? "Carregando…" : (
            <>
              <b>{texts.common.noteWord(total)}</b>
              {showLoaded && phase !== "end" ? <span className="wf-counter-loaded"> · {rows.length} carregadas</span> : null}
            </>
          )}
        </Text>
      </div>
      {notice}
      <div className="wf-scroll" ref={box} aria-label={label} tabIndex={-1}>
        <RowTable<T | SkelRow>
          data={data}
          // #160 o `render` embrulhado aceita também a linha de esqueleto; o `RowTable` só conhece `T | SkelRow` por esse tipo
          columns={wrapped as unknown as RowTableProps<T | SkelRow>["columns"]}
          rowKey={(r) => r.key}
          size="md"
          onOpenRow={(r) => !isSkeleton(r) && onOpenRow(r)}
          rowLabel={(r) => (isSkeleton(r) ? "Carregando mais notas" : rowLabel(r))}
        />
        {phase === "error-next" ? (
          <div className="wf-block-error" role="alert">
            <WarningCircle size={20} weight="fill" color="var(--accent-red)" />
            <div>
              <Text variant="label-sm">Não consegui carregar as próximas notas</Text>
              <Text variant="body-xs" color="var(--content-secondary)">
                As {rows.length} que já carregaram continuam aqui. {texts.common.errorDescription}
              </Text>
            </div>
            <Button variant="outline" size="sm" onClick={onRetry}>{texts.common.retry}</Button>
          </div>
        ) : null}
        {phase === "end" ? (
          <div className="wf-end" role="status">
            <CheckCircle size={18} weight="fill" color="var(--content-tertiary)" />
            <Text variant="body-sm" color="var(--content-tertiary)">Você viu todas as {total} notas</Text>
          </div>
        ) : null}
        <div ref={sentinel} className="wf-sentinel" aria-hidden="true" />
      </div>
    </div>
  );
}
