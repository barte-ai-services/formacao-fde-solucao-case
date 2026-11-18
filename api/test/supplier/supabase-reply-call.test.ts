import { describe, expect, it } from 'vitest';
import { SupabaseRestError } from '../../src/connectors/supabase-rest.js';
import { guarded, pgCode, refused } from '../../src/supplier/supabase-reply-call.js';
import { SupplierStoreError } from '../../src/supplier/supabase-store.js';

// #157 (ADR-003): o teste de supabase-reply-call.ts ao lado do espelho: o código do Postgres e a tradução do erro do PostgREST.

describe('#157 pgCode: só o código de 5 caracteres do corpo do erro', () => {
  it('extrai o código do corpo do PostgREST', () => {
    expect(pgCode('{"code":"23505","message":"duplicate key","details":"x"}')).toBe('23505');
    expect(pgCode('{"code": "57014", "x": 1}')).toBe('57014');
  });

  it('sem código, ou com código de outro tamanho, é null', () => {
    expect(pgCode('')).toBeNull();
    expect(pgCode('{"message":"sem código"}')).toBeNull();
    expect(pgCode('{"code":"2350"}')).toBeNull();
  });
});

describe('#157 guarded: a falha do PostgREST vira SupplierStoreError sem o corpo', () => {
  it('um erro que não é de formato vira SupplierStoreError com a operação, a tabela, o status e o código, e sem o detalhe', async () => {
    const failure = new SupabaseRestError('update', 'outbox_supplier_emails', 500, '{"code":"57014","message":"detalhe interno da conexão"}');
    const error = await guarded(() => Promise.reject(failure)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SupplierStoreError);
    expect(error).toMatchObject({ operation: 'update', table: 'outbox_supplier_emails', status: 500, code: '57014' });
    expect(String((error as Error).message) + JSON.stringify(error)).not.toContain('detalhe interno');
    expect((error as Error).cause).toBeUndefined();
  });

  it('o erro de formato (`parse`) já é nosso e passa como veio', async () => {
    const parse = new SupabaseRestError('parse', 'invoices', 0, 'a nota não foi achada');
    await expect(guarded(() => Promise.reject(parse))).rejects.toBe(parse);
  });

  it('um erro de fora do PostgREST passa como veio', async () => {
    const foreign = new TypeError('outro');
    await expect(guarded(() => Promise.reject(foreign))).rejects.toBe(foreign);
  });

  it('o valor da chamada que deu certo passa', async () => {
    await expect(guarded(() => Promise.resolve(7))).resolves.toBe(7);
  });
});

describe('#157 refused: a transição que o banco não deixou fazer, sem dado algum', () => {
  it('leva só a operação e a tabela, com status 0 e sem código', () => {
    expect(refused('mark_read', 'inbox_supplier_messages')).toMatchObject({ operation: 'mark_read', table: 'inbox_supplier_messages', status: 0, code: null });
  });
});
