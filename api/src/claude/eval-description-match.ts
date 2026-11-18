/**
 * O conjunto do eval do casamento de descrição (#66, AC-6). Monta o conjunto só a partir do kit
 * (data/kit/notas.json e data/kit/produtos.json), nunca de data/kit/excecoes.json nem de outro gabarito,
 * e pergunta ao Claude pelo mesmo run da tarefa description-match, sem gravar nada no banco.
 * Sem Node: o que lê o kit e chama o Claude está em eval/description-match-claude.eval.ts (#171).
 */
import type { Ask } from './client.js';
import { partitionRows } from './guards.js';
import { isKitNotaWithItems, isKitProduto, type KitNotaWithItems, type KitProduto } from './kit-rows.js';
import { descriptionMatch, sortCandidates, type DescriptionMatchInput } from './tasks/description-match.js';

export type EvalCase = { readonly variant: string; readonly input: DescriptionMatchInput; readonly expected: string | null };
export type EvalResult = { readonly variant: string; readonly expected: string | null; readonly answer: string | null; readonly failed: boolean };

const MEASURE = /^(.*\S)\s+(\d+(?:,\d+)?)\s+(L|ml|kg|g|un)$/;
const NOISE_SUFFIX = ' cx c/12';
const CONCURRENCY = 4;

function parseNumber(text: string): number {
  return Number(text.replace(',', '.'));
}

function formatNumber(value: number): string {
  return String(Number(value.toFixed(6))).replace('.', ',');
}

/** #66 Separa a medida do fim da descrição ("Refrigerante cola 2 L" → palavras + "2" "L"). */
function splitMeasure(description: string): { words: string[]; amount?: string; unit?: string } {
  const m = MEASURE.exec(description);
  if (!m) return { words: description.split(/\s+/) };
  return { words: m[1]!.split(/\s+/), amount: m[2]!, unit: m[3]! };
}

const CONVERSION: Record<string, { unit: string; factor: number }> = {
  L: { unit: 'ml', factor: 1000 },
  ml: { unit: 'L', factor: 1 / 1000 },
  kg: { unit: 'g', factor: 1000 },
  g: { unit: 'kg', factor: 1 / 1000 },
};

/** #66 As variantes determinísticas de uma descrição do kit; a que não se aplica fica de fora. */
export function variants(description: string): { variant: string; description: string }[] {
  const { words, amount, unit } = splitMeasure(description);
  const measure = amount && unit ? `${amount} ${unit}` : undefined;
  const join = (ws: string[]) => [...ws, ...(measure ? [measure] : [])].join(' ');
  const out: { variant: string; description: string }[] = [];

  const longIndex = words.findIndex((w) => /^\p{L}{6,}$/u.test(w));
  if (longIndex >= 0) {
    const cut = words[longIndex]!.slice(0, 5);
    out.push({ variant: 'abreviacao-com-ponto', description: join(words.map((w, i) => (i === longIndex ? `${cut}.` : w))) });
    out.push({ variant: 'abreviacao-sem-ponto', description: join(words.map((w, i) => (i === longIndex ? cut : w))) });
  }
  if (measure) {
    out.push({ variant: 'palavras-reordenadas', description: `${measure} ${words.join(' ')}` });
  } else if (words.length >= 2) {
    out.push({ variant: 'palavras-reordenadas', description: [words[1]!, words[0]!, ...words.slice(2)].join(' ') });
  }
  const conversion = unit ? CONVERSION[unit] : undefined;
  if (amount && conversion) {
    const rewritten = `${formatNumber(parseNumber(amount) * conversion.factor)} ${conversion.unit}`;
    out.push({ variant: 'medida-reescrita', description: `${words.join(' ')} ${rewritten}` });
  }
  out.push({ variant: 'sufixo-ruido', description: `${description}${NOISE_SUFFIX}` });
  if (words.length >= 2) out.push({ variant: 'ultima-palavra-removida', description: join(words.slice(0, -1)) });
  return out;
}

/** #66 A mesma descrição com o número do tamanho dobrado; sem número, não há variante. */
function doubledSize(description: string): string | undefined {
  const { words, amount, unit } = splitMeasure(description);
  if (amount && unit) return `${words.join(' ')} ${formatNumber(parseNumber(amount) * 2)} ${unit}`;
  const m = /^(.*\D)?(\d+(?:,\d+)?)(\D*)$/.exec(description);
  if (!m) return undefined;
  return `${m[1] ?? ''}${formatNumber(parseNumber(m[2]!) * 2)}${m[3] ?? ''}`;
}

/**
 * #66 Positivos: as variantes de cada item de nota cujo sku existe no cadastro, esperando a descrição
 * do produto entre os candidatos do fornecedor. Negativos: os itens sem sku e cada produto com o
 * tamanho dobrado, esperando null.
 */
export function buildEvalDataset(invoices: readonly KitNotaWithItems[], products: readonly KitProduto[]): EvalCase[] {
  const bySku = new Map(products.map((p) => [p.sku, p]));
  const candidatesBySupplier = new Map<string, string[]>();
  for (const p of products) candidatesBySupplier.set(p.fornecedor_id, [...(candidatesBySupplier.get(p.fornecedor_id) ?? []), p.descricao]);
  const candidates = (supplier: string) => sortCandidates(candidatesBySupplier.get(supplier) ?? []);

  const positives: EvalCase[] = [];
  const seen = new Set<string>();
  const negatives: EvalCase[] = [];
  for (const invoice of invoices) {
    const list = candidates(invoice.fornecedor_id);
    if (list.length === 0) continue;
    for (const item of invoice.itens) {
      if (item.sku === null) {
        negatives.push({ variant: 'sem-cadastro', input: { description: item.descricao, candidates: list }, expected: null });
        continue;
      }
      const product = bySku.get(item.sku);
      if (!product || seen.has(`${item.sku}\u0000${item.descricao}`)) continue;
      seen.add(`${item.sku}\u0000${item.descricao}`);
      for (const v of variants(item.descricao)) {
        positives.push({ variant: v.variant, input: { description: v.description, candidates: list }, expected: product.descricao });
      }
    }
  }
  for (const p of products) {
    const doubled = doubledSize(p.descricao);
    if (doubled) negatives.push({ variant: 'medida-dobrada', input: { description: doubled, candidates: candidates(p.fornecedor_id) }, expected: null });
  }
  return [...positives, ...negatives];
}

export type EvalSummary = {
  readonly total: number;
  readonly positives: number;
  readonly negatives: number;
  readonly accuracy: number;
  readonly precision: number;
  readonly recall: number;
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falsePositivesOnNegatives: number;
  readonly claudeFailures: number;
  readonly byVariant: Record<string, { total: number; correct: number; accuracy: number }>;
};

const ratio = (a: number, b: number) => (b === 0 ? 0 : a / b);

/** #66 A falha do Claude conta como resposta null: é o que o Worker faria sem sugestão (fail-closed). */
export function summarize(results: readonly EvalResult[]): EvalSummary {
  const positives = results.filter((r) => r.expected !== null);
  const truePositives = positives.filter((r) => r.answer === r.expected).length;
  const falsePositives = results.filter((r) => r.answer !== null && r.answer !== r.expected).length;
  const byVariant: EvalSummary['byVariant'] = {};
  for (const r of results) {
    const v = (byVariant[r.variant] ??= { total: 0, correct: 0, accuracy: 0 });
    v.total += 1;
    if (r.answer === r.expected) v.correct += 1;
    v.accuracy = ratio(v.correct, v.total);
  }
  return {
    total: results.length,
    positives: positives.length,
    negatives: results.length - positives.length,
    accuracy: ratio(results.filter((r) => r.answer === r.expected).length, results.length),
    precision: ratio(truePositives, truePositives + falsePositives),
    recall: ratio(truePositives, positives.length),
    truePositives,
    falsePositives,
    falsePositivesOnNegatives: results.filter((r) => r.expected === null && r.answer !== null).length,
    claudeFailures: results.filter((r) => r.failed).length,
    byVariant,
  };
}

/** #66 Pergunta caso a caso pelo run da tarefa, com poucas chamadas em paralelo. */
export async function runEval(cases: readonly EvalCase[], ask: Ask, concurrency = CONCURRENCY): Promise<EvalResult[]> {
  const results: EvalResult[] = new Array(cases.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < cases.length; i = next++) {
      const c = cases[i]!;
      try {
        const { match } = await descriptionMatch.run(c.input, ask);
        results[i] = { variant: c.variant, expected: c.expected, answer: match, failed: false };
      } catch {
        results[i] = { variant: c.variant, expected: c.expected, answer: null, failed: true };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, worker));
  return results;
}


export const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function asList(value: unknown, file: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`data/kit/${file} não é uma lista`);
  return value;
}

export type NarrowedKit = {
  readonly notas: KitNotaWithItems[]; // ADR-001
  readonly produtos: KitProduto[]; // ADR-001
  readonly dropped: number;
};

/** #66 Estreita o JSON do kit por guard: a linha fora do formato é descartada e contada. */
export function narrowKit(rawInvoices: unknown, rawProducts: unknown): NarrowedKit {
  const invoices = partitionRows(asList(rawInvoices, 'notas.json'), isKitNotaWithItems);
  const products = partitionRows(asList(rawProducts, 'produtos.json'), isKitProduto);
  return { notas: invoices.valid, produtos: products.valid, dropped: invoices.dropped + products.dropped };
}
