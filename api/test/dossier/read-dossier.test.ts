import { describe, expect, it, vi } from 'vitest';
import { AmountAtRisk, DockAction, Money, Proposal, type CheckContext } from '../../src/domain/index.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { readDossier } from '../../src/dossier/read-dossier.js';
import { SupabaseDossierSource } from '../../src/dossier/source.js';
import { dossierField } from '../../src/dossier/proposal-field.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { KIT_ACCESS_KEY, kitCase, kitGoodRaw } from './kit-case.js';

// #68: a leitura do dossiê sobre a NF-004 da base do kit. A saída do Claude chega pronta em
// claude_suggestions (gravada pelo job da #66) e é conferida contra o banco na hora de mostrar.

const GERADO = '2026-11-15T12:00:00.000Z';

const row = (overrides: Record<string, unknown> = {}) => ({
  task: 'dossier',
  input_key: KIT_ACCESS_KEY,
  input: { invoiceAccessKey: KIT_ACCESS_KEY },
  output: kitGoodRaw(),
  status: 'ok',
  model: 'claude-opus-5-5',
  error: null,
  updated_at: GERADO,
  ...overrides,
});

const read = async (
  rows: Record<string, unknown>[],
  loadContext?: () => Promise<CheckContext>,
  log: (event: string, detail: Record<string, unknown>) => void = () => undefined,
) => {
  const { invoice, ctx, tables } = await kitCase();
  const fake = new FakePostgrest({ claude_suggestions: rows });
  const source = new SupabaseDossierSource(
    new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch }),
  );
  const load = vi.fn(loadContext ?? (async () => ctx));
  const result = await readDossier({ invoiceAccessKey: KIT_ACCESS_KEY, invoice, loadContext: load, source, log });
  return { result, tables, fake, invoice, load };
};

const reais = (v: unknown) => `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

describe('readDossier, com a NF-004 da base do kit', () => {
  it('#38/AC-1 a sugestão ok vira o dossiê pronto, com divergências, evidência e histórico', async () => {
    const { result } = await read([row()]);
    expect(result?.status).toBe('ready');
    if (result?.status !== 'ready') return;
    expect(result.divergences.map((d) => d.classification)).toEqual(['E3']);
    expect(result.divergences[0]?.evidence.map((e) => e.key)).toEqual([
      'nota.item[F01-001].quantidade',
      'recebimento[RC-9228].item[F01-001].quantidade',
    ]);
    expect(result.supplierHistory).toMatch(/^O F01 tem 2 notas lançadas/);
    expect(result.generatedAt).toBe(GERADO);
    expect(result.model).toBe('claude-opus-5-5');
  });

  it('#38/AC-2 cada número do dossiê bate com a nota, o recebimento e o histórico no banco', async () => {
    const { result, tables } = await read([row()]);
    if (result?.status !== 'ready') throw new Error('esperava pronto');
    const item = tables.kit_nota_itens!.find((r) => r.codigo_fornecedor === 'F01-001' && r.chave === KIT_ACCESS_KEY)!;
    const contado = tables.kit_recebimento_itens!.find((r) => r.recebimento_id === 'RC-9228' && r.codigo_fornecedor === 'F01-001')!;
    const lancadas = tables.kit_notas_lancadas!.filter((r) => r.fornecedor_id === 'F01');
    const pagos = tables.kit_pagamentos!.filter((r) => r.fornecedor_id === 'F01');
    const somaLancadas = lancadas.reduce((s, r) => s + Math.round(Number(r.valor_total) * 100), 0) / 100;
    expect(result.divergences[0]?.whatDiverges).toBe(
      `Chegou menos do que a nota cobra: ${item.quantidade} ${item.unidade} faturadas a ${reais(item.preco_unitario)}, ${contado.quantidade} ${contado.unidade} contadas.`,
    );
    expect(result.supplierHistory).toBe(
      `O F01 tem ${lancadas.length} notas lançadas, somando ${reais(somaLancadas)}, e ${pagos.length} pagamento de ${reais(pagos[0]!.valor)}.`,
    );
  });

  it('#38/AC-2 número inventado na saída do Claude dá indisponível number_mismatch', async () => {
    const { result } = await read([row({ output: { ...kitGoodRaw(), summary: 'Faltaram 22 litros, R$ 107,58.' } })]);
    expect(result).toEqual({ status: 'unavailable', reason: 'number_mismatch', generatedAt: GERADO });
  });

  it('#296/AC-1 #296/AC-2 #296/AC-3 número errado registra uma linha estruturada só com a verificação, o campo, o token e o banco', async () => {
    const summary = 'Faltaram 22 litros, R$ 107,58.';
    const log = vi.fn();
    const { result } = await read([row({ output: { ...kitGoodRaw(), summary } })], undefined, log);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('dossier-number-mismatch', {
      invoiceAccessKey: KIT_ACCESS_KEY,
      check: 'loose_number',
      field: 'summary',
      cited: '22',
      bank: null,
    });
    const [, detail] = log.mock.calls[0]!;
    expect(Object.keys(detail as object).sort()).toEqual(['bank', 'check', 'cited', 'field', 'invoiceAccessKey']);
    expect(JSON.stringify(log.mock.calls)).not.toContain(summary);
    expect(result).toEqual({ status: 'unavailable', reason: 'number_mismatch', generatedAt: GERADO });
    expect(result).not.toHaveProperty('mismatch');
  });

  it('#313/AC-6 contagem de itens por extenso que não bate com a nota registra item_count_mismatch com a quantidade do banco', async () => {
    const log = vi.fn();
    const { invoice } = await kitCase();
    const real = invoice.items.length;
    const wrong = real === 2 ? 'três' : 'dois';
    await read([row({ output: { ...kitGoodRaw(), summary: `A nota tem ${wrong} itens.` } })], undefined, log);
    expect(log).toHaveBeenCalledWith('dossier-number-mismatch', {
      invoiceAccessKey: KIT_ACCESS_KEY,
      check: 'item_count_mismatch',
      field: 'summary',
      cited: wrong,
      bank: String(real),
    });
  });

  it('#296/AC-1 sem log informado, o padrão é o console.warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { invoice, ctx } = await kitCase();
      const fake = new FakePostgrest({ claude_suggestions: [row({ output: { ...kitGoodRaw(), summary: 'Faltaram 22.' } })] });
      const source = new SupabaseDossierSource(
        new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch }),
      );
      await readDossier({ invoiceAccessKey: KIT_ACCESS_KEY, invoice, loadContext: async () => ctx, source });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toBe('dossier-number-mismatch');
    } finally {
      warn.mockRestore();
    }
  });

  it('#296/AC-1 dossiê pronto e sugestão com erro não registram nada', async () => {
    const log = vi.fn();
    await read([row()], undefined, log);
    await read([row({ status: 'error', output: null, model: null, error: 'timeout' })], undefined, log);
    await read([], undefined, log);
    expect(log).not.toHaveBeenCalled();
  });

  it('#38/AC-2 chave que o banco não tem mais dá number_mismatch na hora de mostrar', async () => {
    const output = kitGoodRaw();
    output.divergences[0]!.evidence = ['recebimento[RC-0000].item[F01-001].quantidade'];
    const { result } = await read([row({ output })]);
    expect(result).toMatchObject({ status: 'unavailable', reason: 'number_mismatch' });
  });

  it('#38/AC-3 a leitura não escreve em nada e o dossiê não traz ação, nível nem valor em risco', async () => {
    const output = { ...kitGoodRaw(), acao: 'recusar', nivel: 'regra', valor_em_risco: 'R$ 0,00' };
    const { result, fake } = await read([row({ output })]);
    expect(result?.status).toBe('ready');
    expect(JSON.stringify(result)).not.toMatch(/"(acao|nivel|valor_em_risco)"/);
    expect(fake.requests.filter((r) => r.method !== 'GET')).toEqual([]);
  });

  it('#38/AC-3 o dossiê não muda a ação, o nível nem o valor em risco da proposta', async () => {
    const proposal = Proposal.register({
      classification: 'E3',
      dockAction: DockAction.receive(),
      level: 'analista',
      amountAtRisk: AmountAtRisk.of(Money.ofCents(10758), Money.ofCents(115392)),
      justification: 'regra',
    });
    proposal.awaitApproval();
    const before = JSON.stringify(proposal);
    await read([row()]);
    expect(JSON.stringify(proposal)).toBe(before);
  });

  it('#38/AC-4 sugestão com status erro dá indisponível claude_failed, e a tela diz que não há dossiê', async () => {
    const { result } = await read([row({ status: 'error', output: null, model: null, error: 'timeout' })]);
    expect(result).toEqual({ status: 'unavailable', reason: 'claude_failed', generatedAt: GERADO });
    expect(dossierField(result)).toMatchObject({
      reason: 'claude_failed',
      notice: expect.stringContaining('Não há dossiê para esta proposta: o Claude não respondeu'),
    });
  });

  it('#38/AC-4 sem sugestão gravada: null, e a tela mostra pendente', async () => {
    const { result } = await read([]);
    expect(result).toBeNull();
    expect(dossierField(result)).toMatchObject({
      status: 'unavailable',
      reason: 'pending',
      notice: expect.stringContaining('o dossiê ainda não foi gerado'),
    });
  });

  it('#68 sem sugestão gravada, o contexto da nota não é carregado', async () => {
    const { result, load } = await read([], async () => {
      throw new Error('não deveria ler o contexto');
    });
    expect(result).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it('#68 sugestão com erro também não carrega o contexto', async () => {
    const { result, load } = await read([row({ status: 'error', output: null, model: null, error: 'timeout' })]);
    expect(result).toMatchObject({ reason: 'claude_failed' });
    expect(load).not.toHaveBeenCalled();
  });

  it('#68 sugestão ok com erro ao carregar o contexto propaga o erro', async () => {
    const failing = read([row()], async () => {
      throw new Error('kit_recebimentos indisponível');
    });
    await expect(failing).rejects.toThrow('kit_recebimentos indisponível');
  });

  it('saída ok sem o model gravado ainda confere e marca o model como desconhecido', async () => {
    const { result } = await read([row({ model: null })]);
    expect(result).toMatchObject({ status: 'ready', model: 'unknown' });
  });
});
