import type { ReactElement } from "react";
import {
  LineChart,
  Panel,
  ProgressBar,
  RankingBars,
  Stat,
  StatGrid,
  toneColor,
  type RankingItem,
} from "@barte-ai-services/barte-ui-kit";
import { apiGet } from "../api";
import type { Cents, DivergenceCode } from "../api/contract";
import { EmptyState } from "../components/EmptyState";
import { Screen } from "../components/Screen";
import { useLoad } from "../components/useLoad";
import type { RouteProps } from "./types";
import { texts } from "../texts";

/** #71: a soma de uma exceção no mês, como `GET /api/valor-barrado` entrega. */
export interface BarredExceptionDto {
  classification: DivergenceCode;
  exceptionCode: DivergenceCode;
  exceptionName: string;
  cents: Cents;
  count: number;
}

export interface BarredBreakdownDto {
  totalCents: Cents;
  byException: BarredExceptionDto[];
}

export interface BarredDailyPointDto {
  /** #71: `AAAA-MM-DD`, no fuso de Brasília. */
  day: string;
  barredCumulativeCents: Cents;
  proposedCumulativeCents: Cents;
}

/** #71: `GET /api/valor-barrado`, o painel do valor barrado no mês contra a linha de base. */
export interface BarredAmountDto {
  /** #71: `AAAA-MM`. */
  month: string;
  /** #71/AC-2: R$ 543 mil por mês, em centavos. */
  baselineCents: Cents;
  /** #71/AC-1, AC-3: decididas no mês com recusar ou receber parcial. */
  barred: BarredBreakdownDto;
  /** #71: aguardando aprovação: o que seria barrado se aprovadas como propostas. */
  ifApprovedAsProposed: BarredBreakdownDto;
  daily: BarredDailyPointDto[];
}

const MONTH_NAME = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

/** #71: reais por extenso a partir de centavos inteiros: a divisão por 100 só acontece aqui, na exibição. */
export function formatBrl(cents: Cents): string {
  return BRL.format(cents / 100);
}

/** #71: reais curtos (`R$ 543 mil`) a partir de centavos inteiros; abaixo de R$ 1.000, por extenso. */
export function formatBrlShort(cents: Cents): string {
  if (cents < 100_000) return formatBrl(cents);
  return `R$ ${Math.round(cents / 100_000).toLocaleString("pt-BR")} mil`;
}

/** #71: a parte de `cents` sobre `baselineCents`, em porcentagem inteira; sem base, um traço. */
export function percentOf(cents: Cents, baselineCents: Cents): string {
  if (baselineCents <= 0) return "—";
  return `${Math.round((cents * 100) / baselineCents)}%`;
}

/** #71: `2026-11` vira `novembro`; um mês que não se lê volta como veio. */
export function monthName(month: string): string {
  const index = Number(month.slice(5, 7)) - 1;
  return MONTH_NAME[index] ?? month;
}

/** #71: `2026-11-03` vira `03/11`. */
function dayLabel(day: string): string {
  return `${day.slice(8, 10)}/${day.slice(5, 7)}`;
}

/** #71/AC-1: barrado e aguardando, somados por exceção em centavos inteiros. */
export function rankingByException(panel: BarredAmountDto): RankingItem[] {
  const totals = new Map<DivergenceCode, { name: string; cents: Cents; count: number }>();
  for (const item of [...panel.barred.byException, ...panel.ifApprovedAsProposed.byException]) {
    const sum = totals.get(item.exceptionCode) ?? { name: item.exceptionName, cents: 0, count: 0 };
    totals.set(item.exceptionCode, { name: item.exceptionName, cents: sum.cents + item.cents, count: sum.count + item.count });
  }
  return [...totals]
    .filter(([, sum]) => sum.cents > 0)
    .map(([code, sum]) => ({
      key: code,
      label: sum.name,
      value: sum.cents,
      meta: texts.common.noteWord(sum.count),
    }));
}

function isEmpty(panel: BarredAmountDto): boolean {
  return panel.barred.totalCents === 0 && panel.ifApprovedAsProposed.totalCents === 0;
}

/** #125 pergunta 5: duplicidade (E6) e pago fora do fluxo (E7) são pagar duas vezes, e não pagar sem mercadoria (P1). */
const DOUBLE_PAYMENT: readonly DivergenceCode[] = ["E6", "E7"];

/** #125: a parte de um painel que é pagamento em dobro, em centavos. */
export function doublePaymentCents(breakdown: BarredBreakdownDto): number {
  return breakdown.byException.filter((e) => DOUBLE_PAYMENT.includes(e.classification)).reduce((sum, e) => sum + e.cents, 0);
}

function BarredAmountView({ panel }: { panel: BarredAmountDto }): ReactElement {
  const doubleBarred = doublePaymentCents(panel.barred);
  const doubleWaiting = doublePaymentCents(panel.ifApprovedAsProposed);
  const barred = panel.barred.totalCents - doubleBarred;
  const waiting = panel.ifApprovedAsProposed.totalCents - doubleWaiting;
  const baseline = panel.baselineCents;
  const daily = panel.daily.map((point) => ({
    day: dayLabel(point.day),
    barred: point.barredCumulativeCents,
    proposed: point.proposedCumulativeCents,
  }));
  const baselineLabel = formatBrlShort(baseline);

  return (
    <>
      <StatGrid columns={3}>
        <Stat
          caption={texts.valorBarrado.statAvoided.caption(monthName(panel.month))}
          value={formatBrlShort(barred)}
          context={texts.valorBarrado.statAvoided.context(percentOf(barred, baseline))}
          tone="positive"
        />
        <Stat
          caption={texts.valorBarrado.statLoss.caption}
          value={baselineLabel}
          context={texts.valorBarrado.statLoss.context}
        />
        <Stat
          caption={texts.valorBarrado.statDeciding.caption}
          value={formatBrlShort(waiting)}
          context={texts.valorBarrado.statDeciding.context(percentOf(waiting, baseline))}
          tone="waiting"
        />
      </StatGrid>
      <StatGrid columns={3}>
        <Stat
          caption={texts.valorBarrado.statDouble.caption}
          value={formatBrlShort(doubleBarred)}
          context={`${texts.valorBarrado.statDouble.context}${doubleWaiting > 0 ? texts.valorBarrado.statDouble.decidingExtra(formatBrlShort(doubleWaiting)) : ""}`}
          tone="positive"
        />
      </StatGrid>
      <Panel title={texts.valorBarrado.monthPanel(baselineLabel)} size="sm">
        <ProgressBar
          size="md"
          max={baseline}
          showLegend
          valueText={texts.valorBarrado.progressValue(formatBrlShort(barred + waiting), baselineLabel)}
          segments={[
            { value: barred, tone: "positive", label: texts.valorBarrado.segmentAvoided },
            { value: waiting, tone: "waiting", label: texts.valorBarrado.segmentDeciding },
          ]}
        />
      </Panel>
      <div style={{ display: "grid", gap: "var(--spacing-xl)", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))" }}>
        <Panel title={texts.valorBarrado.cumulativePanel} size="sm">
          <div className="pagar-line-chart">
            <LineChart
              data={daily}
              xKey="day"
              series={[
                { key: "barred", label: texts.valorBarrado.seriesAvoided },
                { key: "proposed", label: texts.valorBarrado.seriesDeciding, color: toneColor.waiting },
              ]}
              height={220}
              formatValue={formatBrl}
              formatAxis={(cents) => texts.valorBarrado.axisThousands(Math.round(cents / 100_000))}
              ariaLabel={texts.valorBarrado.chartLabel}
            />
          </div>
        </Panel>
        <Panel title={texts.valorBarrado.rankingPanel} size="sm">
          <div className="pagar-ranking">
            <RankingBars items={rankingByException(panel)} formatValue={formatBrlShort} tone="positive" />
          </div>
        </Panel>
      </div>
    </>
  );
}

/** /pagar/valor-barrado: o painel do pagamento errado evitado (#71, #125). */
export default function BarredAmountRoute(_props: RouteProps): ReactElement {
  const { state, data, retry } = useLoad(
    (signal) => apiGet<BarredAmountDto>("/api/valor-barrado", { signal }),
    isEmpty,
  );
  return (
    <Screen
      title={texts.valorBarrado.title}
      subtitle={texts.valorBarrado.subtitle}
      state={state}
      onRetry={retry}
      loadingLabel={texts.valorBarrado.loading}
      errorTitle={texts.valorBarrado.error}
      emptyLabel={texts.valorBarrado.empty}
      empty={
        <EmptyState
          title={texts.emptyState.valorBarrado.title}
          description={texts.emptyState.valorBarrado.description(data ? formatBrlShort(data.baselineCents) : "")}
          action={{ label: texts.emptyState.action, to: "/pagar/fila" }}
        />
      }
    >
      {() => (data ? <BarredAmountView panel={data} /> : null)}
    </Screen>
  );
}
