import { describe, expect, it } from 'vitest';
import {
  DOSSIER_OUTPUT_SCHEMA,
  buildFactCatalog,
  catalogKeys,
  factKey,
  dossierNotice,
  verifyAndRender,
  type DossierResult,
} from '../../src/domain/index.js';
import { ACCESS_KEY, checkedInvoice, dossierContext, goodRaw } from '../dossier/fixtures.js';

const META = { generatedAt: '2026-11-15T12:00:00.000Z', model: 'claude-opus-5-5' };

const catalog = () => buildFactCatalog(checkedInvoice(), dossierContext());
const render = (raw: unknown): DossierResult =>
  verifyAndRender(raw, catalog(), checkedInvoice().divergences, META);

const withText = (field: 'summary' | 'supplier_history', text: string) => ({ ...goodRaw(), [field]: text });

describe('catálogo de fatos', () => {
  it('#38/AC-2 traz os números da nota, da ordem e do cadastro como estão no banco', () => {
    const { facts } = catalog();
    expect(facts['nota.total']).toEqual({ label: 'Valor total da nota', value: 'R$ 1.200,00', source: 'invoice' });
    expect(facts['nota.item[A1].quantidade']?.value).toBe('12 CX');
    expect(facts['nota.item[A1].preco_unitario']?.value).toBe('R$ 100,00');
    expect(facts['nota.item[A1].total']?.value).toBe('R$ 1.200,00');
    expect(facts['ordem[OC-100].item[A1].preco_unitario']?.value).toBe('R$ 100,00');
    expect(facts['ordem[OC-100].item[A1].quantidade']?.value).toBe('12 CX');
    expect(facts['ordem[OC-100].item[A1].saldo']).toMatchObject({ value: '12 CX', source: 'purchase_order' });
    expect(facts['ordem[OC-100].total']?.value).toBe('R$ 1.200,00');
    expect(facts['cadastro.produto[SKU-1].fator_caixa']).toMatchObject({ value: '4 UN por CX', source: 'registry' });
    expect(facts['cadastro.produto[SKU-1].preco_referencia']?.value).toBe('R$ 25,00');
    expect(facts['cadastro.fornecedor.bloqueado']?.value).toBe('não');
    expect(facts['recebimento[R-1].item[A1].quantidade']?.value).toBe('10 CX');
  });

  it('#38/AC-1 traz o histórico do fornecedor, só dele', () => {
    const { facts } = catalog();
    expect(facts['historico.notas_lancadas.quantidade']).toMatchObject({ value: '2', source: 'history' });
    expect(facts['historico.notas_lancadas.valor']?.value).toBe('R$ 1.200,00');
    expect(facts['historico.pagamentos.quantidade']?.value).toBe('1');
    expect(facts['historico.pagamentos.valor']?.value).toBe('R$ 500,00');
    expect(facts['historico.notas_capturadas.quantidade']?.value).toBe('0');
  });

  it('lista os identificadores que podem aparecer sem marcador', () => {
    const { identifiers } = catalog();
    expect(identifiers).toEqual(
      expect.arrayContaining([ACCESS_KEY, 'OC-100', 'SKU-1', 'A1', 'F-001', 'L01', '2026-11-10', '12.345.678/0001-90', 'R-1', 'E1']),
    );
    // número curto só por marcador: senão "1234" passaria por quantidade.
    expect(identifiers).not.toContain('1234');
  });
});

describe('contrato das chaves', () => {
  it('#38/AC-2 toda chave do catálogo segue o esquema documentado em domain/dossier.ts', () => {
    const contract =
      /^(nota\.(numero|serie|total)|nota\.item\[[^\]]+\]\.(quantidade|preco_unitario|total)|ordem\[[^\]]+\]\.(total|status)|ordem\[[^\]]+\]\.item\[[^\]]+\]\.(quantidade|preco_unitario|saldo)|cadastro\.produto\[[^\]]+\]\.(fator_caixa|preco_referencia)|cadastro\.fornecedor\.bloqueado|recebimento\[[^\]]+\]\.item\[[^\]]+\]\.quantidade|historico\.(notas_lancadas|pagamentos)\.(quantidade|valor)|historico\.notas_capturadas\.quantidade)$/;
    const keys = catalogKeys(catalog());
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(key).toMatch(contract);
    expect(keys).toEqual([...keys].sort());
  });

  it('factKey escreve as chaves que o job do Claude copia', () => {
    expect(factKey.invoiceItem('A1', 'quantidade')).toBe('nota.item[A1].quantidade');
    expect(factKey.orderItem('OC-100', 'A1', 'saldo')).toBe('ordem[OC-100].item[A1].saldo');
    expect(factKey.receiptItem('R-1', 'A1')).toBe('recebimento[R-1].item[A1].quantidade');
    expect(factKey.productBoxFactor('SKU-1')).toBe('cadastro.produto[SKU-1].fator_caixa');
    expect(factKey.paymentValue()).toBe('historico.pagamentos.valor');
  });
});

describe('schema da saída do Claude', () => {
  it('#38/AC-3 não tem campo de ação, nível nem valor em risco', () => {
    expect(DOSSIER_OUTPUT_SCHEMA.additionalProperties).toBe(false);
    expect(Object.keys(DOSSIER_OUTPUT_SCHEMA.properties).sort()).toEqual(
      ['divergences', 'supplier_history', 'summary'].sort(),
    );
    expect(JSON.stringify(DOSSIER_OUTPUT_SCHEMA)).not.toMatch(/"(acao|nivel|valor_em_risco)"/);
  });
});

describe('verifyAndRender', () => {
  it('#38/AC-1 devolve o dossiê pronto com o que diverge, a evidência e o histórico', () => {
    const result = render(goodRaw());
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.divergences).toHaveLength(1);
    expect(result.divergences[0]?.classification).toBe('E1');
    expect(result.divergences[0]?.evidence).toEqual([
      { key: 'nota.item[A1].quantidade', label: expect.any(String), value: '12 CX', source: 'invoice' },
      { key: 'recebimento[R-1].item[A1].quantidade', label: expect.any(String), value: '10 CX', source: 'receipt' },
    ]);
    expect(result.supplierHistory).toContain('2 notas lançadas');
    expect(result.generatedAt).toBe(META.generatedAt);
    expect(result.model).toBe(META.model);
  });

  it('#38/AC-2 os números renderizados são os do banco', () => {
    const result = render(goodRaw());
    if (result.status !== 'ready') throw new Error('esperava pronto');
    expect(result.summary).toBe('A nota cobra 12 CX de SKU-1, mas o recebimento R-1 contou 10 CX.');
    expect(result.divergences[0]?.whatDiverges).toBe(
      'Faltaram caixas: a nota fatura 12 CX a R$ 100,00 e a contagem achou 10 CX.',
    );
    expect(result.supplierHistory).toBe(
      'O fornecedor F-001 tem 2 notas lançadas, somando R$ 1.200,00, e 1 pagamento.',
    );
    expect(JSON.stringify(result)).not.toContain('{{');
  });

  it('#38/AC-2 valor em reais inventado no texto torna o dossiê indisponível', () => {
    expect(render(withText('summary', 'A nota cobra R$ 999,00 a mais.'))).toMatchObject({
      status: 'unavailable',
      reason: 'number_mismatch',
    });
  });

  it('#38/AC-2 quantidade sem marcador torna o dossiê indisponível', () => {
    expect(render(withText('supplier_history', 'Faltaram 15 caixas.'))).toMatchObject({
      status: 'unavailable',
      reason: 'number_mismatch',
    });
  });

  it('#38/AC-2 número por extenso fora de marcador torna o dossiê indisponível', () => {
    // #68: comparado em minúsculas e sem acento; `um`/`uma` ficam fora da lista por serem artigo.
    expect(render(withText('supplier_history', 'Faltaram quinze caixas.'))).toMatchObject({
      status: 'unavailable',
      reason: 'number_mismatch',
    });
    expect(render(withText('summary', 'Chegaram Três caixas a menos.'))).toMatchObject({ reason: 'number_mismatch' });
  });

  it('#38/AC-2 dígito fora do ASCII fora de marcador torna o dossiê indisponível', () => {
    expect(render(withText('supplier_history', 'Faltaram １５ caixas.'))).toMatchObject({
      status: 'unavailable',
      reason: 'number_mismatch',
    });
  });

  it('#38/AC-2 número curto que só existe como identificador também precisa de marcador', () => {
    expect(render(withText('summary', 'Faltaram 1234 caixas.'))).toMatchObject({ reason: 'number_mismatch' });
  });

  it('#38/AC-2 marcador que não está no catálogo torna o dossiê indisponível', () => {
    expect(render(withText('summary', 'A nota cobra {{nota.item[A1].desconto}}.'))).toMatchObject({
      status: 'unavailable',
      reason: 'number_mismatch',
    });
  });

  it('#38/AC-2 evidência que não está no catálogo torna o dossiê indisponível', () => {
    const raw = goodRaw();
    raw.divergences[0]!.evidence = ['nota.item[A1].quantidade', 'nota.item[Z9].quantidade'];
    expect(render(raw)).toMatchObject({ status: 'unavailable', reason: 'number_mismatch' });
  });

  it('#38/AC-2 classificação que não é das divergências da nota torna o dossiê indisponível', () => {
    const raw = goodRaw();
    raw.divergences[0]!.classification = 'E6';
    expect(render(raw)).toMatchObject({ status: 'unavailable', reason: 'number_mismatch' });
  });

  it('#296/AC-1 número solto no texto: loose_number, com o campo e o token', () => {
    expect(render(withText('summary', 'Faltaram 15 caixas.'))).toEqual({
      status: 'unavailable',
      reason: 'number_mismatch',
      generatedAt: META.generatedAt,
      mismatch: { check: 'loose_number', field: 'summary', cited: '15', bank: null },
    });
  });

  it('#296/AC-1 número por extenso: spelled_number, com o token sem a pontuação de borda', () => {
    expect(render(withText('supplier_history', 'Faltaram quinze, caixas.'))).toMatchObject({
      reason: 'number_mismatch',
      mismatch: { check: 'spelled_number', field: 'supplier_history', cited: 'quinze', bank: null },
    });
  });

  it('#296/AC-1 marcador desconhecido no texto: unknown_key, com a chave', () => {
    const raw = goodRaw();
    raw.divergences[0]!.what_diverges = 'A nota cobra {{nota.item[A1].desconto}}.';
    expect(render(raw)).toMatchObject({
      reason: 'number_mismatch',
      mismatch: {
        check: 'unknown_key',
        field: 'divergences[0].what_diverges',
        cited: 'nota.item[A1].desconto',
        bank: null,
      },
    });
  });

  it('#296/AC-1 chave desconhecida em evidence: unknown_key, no campo da evidência', () => {
    const raw = goodRaw();
    raw.divergences[0]!.evidence = ['nota.item[A1].quantidade', 'nota.item[Z9].quantidade'];
    expect(render(raw)).toMatchObject({
      reason: 'number_mismatch',
      mismatch: { check: 'unknown_key', field: 'divergences[0].evidence', cited: 'nota.item[Z9].quantidade', bank: null },
    });
  });

  it('#296/AC-1 classificação que a nota não tem: unknown_classification, com as classificações do banco', () => {
    const raw = goodRaw();
    raw.divergences[0]!.classification = 'E6';
    expect(render(raw)).toMatchObject({
      reason: 'number_mismatch',
      mismatch: { check: 'unknown_classification', field: 'divergences[0].classification', cited: 'E6', bank: 'E1' },
    });
  });

  it('#296/AC-1 a primeira falha vence: o texto antes da classificação, o summary antes do histórico', () => {
    const raw = { ...goodRaw(), summary: 'Faltaram 15 caixas.', supplier_history: 'Faltaram quinze caixas.' };
    raw.divergences[0]!.classification = 'E6';
    expect(render(raw)).toMatchObject({ mismatch: { check: 'loose_number', field: 'summary' } });
  });

  it('#296/AC-1 o cited é cortado em 64 caracteres e nunca leva o texto inteiro', () => {
    const longo = '9'.repeat(100);
    const solto = render(withText('summary', `Faltaram ${longo} caixas de arroz.`));
    const chave = render(withText('summary', `A nota cobra {{${'k'.repeat(100)}}}.`));
    expect(solto).toMatchObject({ mismatch: { cited: '9'.repeat(64) } });
    expect(chave).toMatchObject({ mismatch: { check: 'unknown_key', cited: 'k'.repeat(64) } });
  });

  it('#296/AC-2 o dossiê pronto não traz mismatch', () => {
    expect(render(goodRaw())).not.toHaveProperty('mismatch');
  });

  it('#38/AC-2 identificadores e classificações podem aparecer sem marcador', () => {
    const result = render(withText('summary', `Nota ${ACCESS_KEY} da OC-100, loja L01, emitida em 2026-11-10 (E1).`));
    expect(result.status).toBe('ready');
  });

  it('forma errada torna o dossiê indisponível com invalid_shape', () => {
    for (const raw of [null, 'texto', {}, { ...goodRaw(), divergences: 'x' }, { ...goodRaw(), summary: 3 }]) {
      expect(render(raw)).toMatchObject({ status: 'unavailable', reason: 'invalid_shape' });
    }
  });

  it('divergência sem evidência é forma inválida (regra 6)', () => {
    const raw = goodRaw();
    raw.divergences[0]!.evidence = [];
    expect(render(raw)).toMatchObject({ status: 'unavailable', reason: 'invalid_shape' });
  });

  it('#38/AC-3 campos extras como ação e nível não entram no dossiê', () => {
    const result = render({ ...goodRaw(), acao: 'recusar', nivel: 'regra', valor_em_risco: 'R$ 0,00' });
    expect(result.status).toBe('ready');
    expect(Object.keys(result)).not.toEqual(expect.arrayContaining(['acao']));
    expect(JSON.stringify(result)).not.toMatch(/"(acao|nivel|valor_em_risco)"/);
  });
});

describe('dossierNotice', () => {
  it('#38/AC-4 diz à tela que não há dossiê e por quê', () => {
    expect(dossierNotice({ status: 'unavailable', reason: 'claude_failed', generatedAt: META.generatedAt })).toBe(
      'Não há dossiê para esta proposta: o Claude não respondeu. Decida pelas divergências e evidências da conferência.',
    );
    expect(dossierNotice(null)).toContain('Não há dossiê para esta proposta: o dossiê ainda não foi gerado.');
  });

  it('não tem notice quando o dossiê está pronto', () => {
    expect(dossierNotice(render(goodRaw()))).toBeNull();
  });
});
