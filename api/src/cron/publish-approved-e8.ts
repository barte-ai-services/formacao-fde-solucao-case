// #35 (plano #66, AC-5): o Cron manda ao Cadastro o item sem cadastro das propostas já aprovadas por uma pessoa.
import type { ApprovalStore } from '../approval/store.js';
import type { RegistryCorrectionMessage, RegistryCorrectionOutbox } from '../connectors/ports.js';
import { publishUnregisteredItems } from '../registry/publish-unregistered-items.js';

export type PublishApprovedDeps = {
  readonly store: Pick<ApprovalStore, 'listDecidedOn'>;
  readonly outbox: RegistryCorrectionOutbox;
  /** #66 Os dias (AAAA-MM-DD) cujas decisões entram na rodada. */
  readonly days: readonly string[];
  /**
   * #356 AC-4 O teto de pedidos à caixa por chamada (padrão: sem teto, como fora da rodada). Com teto, a chamada lê da caixa, numa
   * requisição por bloco de LOOKUP_FILES notas que o laço alcança, o que já foi publicado, e não o republica (republicar custa duas
   * requisições e não tira a mensagem da fila): assim o teto não prende as notas de trás. O primeiro bloco é o custo fixo da chamada; cada
   * bloco a mais e cada mensagem nova gasta uma unidade do teto, para o custo medido da chamada nunca passar do declarado.
   */
  readonly limit?: number;
};

/** #356 AC-4 Quantas notas entram em cada leitura da caixa (as chaves vão na URL); o laço lê o bloco seguinte quando chega nele. */
export const LOOKUP_FILES = 60;

const signature = (m: RegistryCorrectionMessage): string => JSON.stringify([m.invoiceAccessKey, m.kind, m.supplierCode, m.sku, m.detail]);

/** #356 AC-4 As mensagens que a caixa já tem das notas dadas; sem a leitura na caixa, nenhuma (publica de novo, a caixa ignora). */
async function publishedSignatures(outbox: RegistryCorrectionOutbox, keys: readonly string[]): Promise<ReadonlySet<string>> {
  if (!outbox.listFor) return new Set();
  return new Set((await outbox.listFor(keys)).map(signature));
}

/**
 * #66 Os últimos `count` dias em UTC (AAAA-MM-DD), de hoje para trás. O Cron usa 7: uma falha de até uma
 * semana, ou uma decisão tomada antes de um deploy, ainda chega ao Cadastro na rodada seguinte. Passar
 * disso perde a mensagem, e a caixa de saída idempotente (#59) é o que deixa a janela larga sem duplicar.
 */
export function lastDaysUtc(now: Date, count: number): string[] {
  return Array.from({ length: count }, (_, i) => new Date(now.getTime() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
}

/**
 * #35, AC-5: para cada processo decidido nos dias dados, com proposta aprovada ou alterada e um E8 na nota,
 * publica na caixa de saída do Cadastro. A caixa é idempotente (#59): repetir o dia não cria mensagem nova.
 */
export async function publishApprovedUnregistered(deps: PublishApprovedDeps): Promise<{ published: number }> {
  const files = (await Promise.all(deps.days.map((day) => deps.store.listDecidedOn(day)))).flat();
  const withE8 = files.filter(
    (f) =>
      (f.proposal.state === 'aprovada' || f.proposal.state === 'alterada') &&
      f.invoice.divergences.some((d) => d.classification === 'E8'),
  );
  if (withE8.length === 0) return { published: 0 };

  const limit = deps.limit ?? Number.POSITIVE_INFINITY;
  const lookup = Number.isFinite(limit);
  const known = new Set<string>();
  const readBlock = async (from: number): Promise<void> => {
    const keys = withE8.slice(from, from + LOOKUP_FILES).map((f) => f.invoice.accessKey);
    for (const sig of await publishedSignatures(deps.outbox, keys)) known.add(sig);
  };
  if (lookup) await readBlock(0);
  let published = 0;
  let requests = 0;
  for (const [index, file] of withE8.entries()) {
    if (requests >= limit) break;
    if (lookup && index > 0 && index % LOOKUP_FILES === 0) {
      await readBlock(index);
      requests += 1;
      if (requests >= limit) break;
    }
    const sent = await publishUnregisteredItems(file.invoice, file.proposal, deps.outbox, limit - requests, (m) => known.has(signature(m)));
    published += sent;
    requests += sent;
  }
  return { published };
}
