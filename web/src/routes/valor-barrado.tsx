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
import { divergenceLabel } from "../evidence/labels";
import type { RouteProps } from "./types";
import { texts } from "../texts";

/** #71: a soma de uma exceção no mês, como `GET /api/valor-barrado` entrega. */
export interface BarredExceptionDto {
  classification: DivergenceCode;
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
  const totals = new Map<DivergenceCode, { cents: Cents; count: number }>();
  for (const item of [...panel.barred.byException, ...panel.ifApprovedAsProposed.byException]) {
    const sum = totals.get(item.classification) ?? { cents: 0, count: 0 };
    totals.set(item.classification, { cents: sum.cents + item.cents, count: sum.count + item.count });
  }
  return [...totals]
    .filter(([, sum]) => sum.cents > 0)
    .map(([code, sum]) => ({
      key: code,
      label: divergenceLabel(code),
      value: sum.cents,
      meta: texts.common.noteWord(sum.count),
    }));
}

function isEmpty(panel: BarredAmountDto): boolean {
  return panel.barred.totalCents === 0 && panel.ifApprovedAsProposed.totalCents === 0;
}

function BarredAmountView({ panel }: { panel: BarredAmountDto }): ReactElement {
  const barred = panel.barred.totalCents;
  const waiting = panel.ifApprovedAsProposed.totalCents;
  const baseline = panel.baselineCents;
  const daily = panel.daily.map((point) => ({
    day: dayLabel(point.day),
    barred: point.barredCumulativeCents,
    proposed: point.proposedCumulativeCents,
    baseline,
  }));
  const baselineLabel = formatBrlShort(baseline);

  return (
    <>
      <StatGrid columns={3}>
        <Stat
          caption={texts.valorBarrado.statBarred.caption(monthName(panel.month))}
          value={formatBrlShort(barred)}
          context={texts.valorBarrado.statBarred.context}
          tone="positive"
        />
        <Stat
          caption={texts.valorBarrado.statAgainst.caption}
          value={percentOf(barred, baseline)}
          context={texts.valorBarrado.statAgainst.context(baselineLabel, percentOf(barred + waiting, baseline))}
        />
        <Stat caption={texts.valorBarrado.statWaiting.caption} value={formatBrlShort(waiting)} context={texts.valorBarrado.statWaiting.context} tone="waiting" />
      </StatGrid>
      <Panel title={texts.valorBarrado.monthPanel(baselineLabel)} size="sm">
        <ProgressBar
          size="md"
          max={baseline}
          showLegend
          valueText={texts.valorBarrado.progressValue(formatBrlShort(barred + waiting), baselineLabel)}
          segments={[
            { value: barred, tone: "positive", label: texts.valorBarrado.segmentBarred },
            { value: waiting, tone: "waiting", label: texts.valorBarrado.segmentWaiting },
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
              { key: "barred", label: texts.valorBarrado.seriesBarred },
              { key: "proposed", label: texts.valorBarrado.seriesProposed, color: toneColor.waiting },
              { key: "baseline", label: texts.valorBarrado.seriesBaseline(baselineLabel), dashed: true, color: toneColor.negative },
            ]}
            height={220}
            formatValue={formatBrl}
            formatAxis={(cents) => texts.valorBarrado.axisThousands(Math.round(cents / 100_000))}
            ariaLabel={texts.valorBarrado.chartLabel(baselineLabel)}
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

/** /pagar/valor-barrado: o painel do valor barrado (#71). */
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
