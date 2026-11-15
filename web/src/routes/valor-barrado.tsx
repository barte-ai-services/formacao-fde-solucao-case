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
import { Screen } from "../components/Screen";
import { useLoad } from "../components/useLoad";
import { divergenceLabel } from "../evidence/labels";
import type { RouteProps } from "./types";

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
  /** `AAAA-MM-DD`, no fuso de Brasília. */
  day: string;
  barredCumulativeCents: Cents;
  proposedCumulativeCents: Cents;
}

/** #71: `GET /api/valor-barrado`, o painel do valor barrado no mês contra a linha de base. */
export interface BarredAmountDto {
  /** `AAAA-MM`. */
  month: string;
  /** #71/AC-2: R$ 543 mil por mês, em centavos. */
  baselineCents: Cents;
  /** #71/AC-1, AC-3: decididas no mês com recusar ou receber parcial. */
  barred: BarredBreakdownDto;
  /** Aguardando aprovação: o que seria barrado se aprovadas como propostas. */
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

/** Reais por extenso a partir de centavos inteiros: a divisão por 100 só acontece aqui, na exibição. */
export function reais(cents: Cents): string {
  return BRL.format(cents / 100);
}

/** Reais curtos (`R$ 543 mil`) a partir de centavos inteiros; abaixo de R$ 1.000, por extenso. */
export function reaisCurto(cents: Cents): string {
  if (cents < 100_000) return reais(cents);
  return `R$ ${Math.round(cents / 100_000).toLocaleString("pt-BR")} mil`;
}

/** A parte de `cents` sobre `baselineCents`, em porcentagem inteira; sem base, um traço. */
export function percentOf(cents: Cents, baselineCents: Cents): string {
  if (baselineCents <= 0) return "—";
  return `${Math.round((cents * 100) / baselineCents)}%`;
}

/** `2026-11` vira `novembro`; um mês que não se lê volta como veio. */
export function monthName(month: string): string {
  const index = Number(month.slice(5, 7)) - 1;
  return MONTH_NAME[index] ?? month;
}

/** `2026-11-03` vira `03/11`. */
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
      meta: sum.count === 1 ? "1 nota" : `${sum.count} notas`,
    }));
}

function isEmpty(panel: BarredAmountDto): boolean {
  return panel.barred.totalCents === 0 && panel.ifApprovedAsProposed.totalCents === 0;
}

function Painel({ panel }: { panel: BarredAmountDto }) {
  const barred = panel.barred.totalCents;
  const waiting = panel.ifApprovedAsProposed.totalCents;
  const baseline = panel.baselineCents;
  const daily = panel.daily.map((point) => ({
    dia: dayLabel(point.day),
    barrado: point.barredCumulativeCents,
    proposto: point.proposedCumulativeCents,
    meta: baseline,
  }));
  const baselineLabel = reaisCurto(baseline);

  return (
    <>
      <StatGrid columns={3}>
        <Stat
          caption={`Barrado em ${monthName(panel.month)}`}
          value={reaisCurto(barred)}
          context="propostas aprovadas"
          tone="positive"
        />
        <Stat
          caption="Contra o pagar errado"
          value={percentOf(barred, baseline)}
          context={`de ${baselineLabel} por mês; ${percentOf(barred + waiting, baseline)} com tudo aprovado`}
        />
        <Stat caption="Ainda em risco" value={reaisCurto(waiting)} context="aguardando aprovação" tone="waiting" />
      </StatGrid>
      <Panel title={`O mês contra os ${baselineLabel}`} size="sm">
        <ProgressBar
          max={baseline}
          showLegend
          valueText={`${reaisCurto(barred + waiting)} de ${baselineLabel}`}
          segments={[
            { value: barred, tone: "positive", label: "Barrado" },
            { value: waiting, tone: "waiting", label: "Aguardando aprovação" },
          ]}
        />
      </Panel>
      <div style={{ display: "grid", gap: "var(--spacing-xl)", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))" }}>
        <Panel title="Acumulado no mês" size="sm">
          <LineChart
            data={daily}
            xKey="dia"
            series={[
              { key: "barrado", label: "Barrado (aprovado)" },
              { key: "proposto", label: "Proposto, aguardando aprovação", color: toneColor.waiting },
              { key: "meta", label: `${baselineLabel} por mês`, dashed: true, color: toneColor.negative },
            ]}
            height={220}
            formatValue={reais}
            formatAxis={(cents) => `${Math.round(cents / 100_000)} mil`}
            ariaLabel={`Valor barrado acumulado por dia, contra ${baselineLabel}`}
          />
        </Panel>
        <Panel title="Valor em risco por tipo de divergência" size="sm">
          <RankingBars items={rankingByException(panel)} formatValue={reaisCurto} tone="positive" />
        </Panel>
      </div>
    </>
  );
}

/** /pagar/valor-barrado: o painel do valor barrado (#71). */
export default function ValorBarrado(_props: RouteProps) {
  const { state, data, retry } = useLoad(
    (signal) => apiGet<BarredAmountDto>("/api/valor-barrado", { signal }),
    isEmpty,
  );
  return (
    <Screen
      title="Valor barrado"
      subtitle="Quanto a conferência impediu de pagar errado neste mês, contra os R$ 543 mil por mês que a Já Chegou pagava sem a mercadoria."
      state={state}
      onRetry={retry}
      loadingLabel="Somando o valor barrado…"
      errorTitle="Não consegui somar o valor barrado agora"
      emptyLabel="Nada barrado neste mês ainda. O valor aparece aqui assim que a primeira proposta for aprovada."
    >
      {() => (data ? <Painel panel={data} /> : null)}
    </Screen>
  );
}
