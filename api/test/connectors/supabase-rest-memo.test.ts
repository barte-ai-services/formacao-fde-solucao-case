// #362 A leitura guardada por cliente: a mesma consulta vai ao banco uma vez; a escrita da tabela, o rpc e a falha a esquecem.
import { describe, expect, it } from 'vitest';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { FakePostgrest } from '../support/fake-postgrest.js';

function world(memoize = true) {
  const fake = new FakePostgrest({ itens: [{ id: 1 }, { id: 2 }], outros: [{ id: 9 }] });
  const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch, memoizeReads: memoize });
  return { fake, rest };
}

describe('#362 a leitura guardada do cliente da rodada', () => { // ADR-002
  it('a mesma consulta, feita duas vezes ou juntas, é uma requisição só; outra consulta é outra', async () => { // ADR-002
    const { fake, rest } = world();
    const [a, b] = await Promise.all([rest.select('itens', { order: 'id' }), rest.select('itens', { order: 'id' })]);
    await rest.select('itens', { order: 'id' });
    await rest.select('itens', { order: 'id.desc' });
    expect(a).toEqual(b);
    expect(fake.requests).toHaveLength(2);
  });

  it('quem lê recebe a sua cópia: mexer nela não muda a leitura guardada', async () => { // ADR-002
    const { rest } = world();
    (await rest.select('itens')).pop();
    expect(await rest.select('itens')).toHaveLength(2);
  });

  it('sem o memoizeReads o cliente lê toda vez, como sempre', async () => { // ADR-002
    const { fake, rest } = world(false);
    await rest.select('itens');
    await rest.select('itens');
    expect(fake.requests).toHaveLength(2);
  });

  it('a escrita da tabela esquece a leitura dela (e só a dela), e o rpc esquece todas', async () => { // ADR-002
    const { fake, rest } = world();
    await rest.select('itens');
    await rest.select('outros');
    await rest.insert('itens', [{ id: 3 }]);
    expect(await rest.select('itens')).toHaveLength(3);
    await rest.select('outros');
    expect(fake.requests.filter((r) => r.method === 'GET')).toHaveLength(3);
    await rest.update('outros', { id: 'eq.9' }, { id: 10 });
    expect(await rest.select('outros')).toEqual([{ id: 10 }]);
    await rest.rpc('qualquer', {}).catch(() => undefined);
    const before = fake.requests.length;
    await rest.select('itens');
    expect(fake.requests.length - before).toBe(1);
  });

  it('resetReads esquece tudo, e a leitura que falhou não fica guardada', async () => { // ADR-002
    let broken = true;
    const fake = new FakePostgrest({ itens: [{ id: 1 }] });
    const rest = new SupabaseRest({
      url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', memoizeReads: true,
      fetch: (input, init) => (broken ? Promise.resolve(new Response('{}', { status: 503 })) : fake.fetch(input, init)),
    });
    await expect(rest.select('itens')).rejects.toMatchObject({ status: 503 });
    broken = false;
    expect(await rest.select('itens')).toHaveLength(1);
    rest.resetReads();
    await rest.select('itens');
    expect(fake.requests).toHaveLength(2);
  });

  it('a leitura que começa com a escrita em voo não sobrevive a ela: a escrita esquece ao terminar, também quando falha', async () => { // ADR-002
    const fake = new FakePostgrest({ itens: [{ id: 1 }] });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let failWrite = false;
    const rest = new SupabaseRest({
      url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', memoizeReads: true,
      fetch: async (input, init) => {
        if (init?.method === 'POST' || init?.method === 'PATCH') {
          await gate;
          if (failWrite) return new Response('{}', { status: 503 });
        }
        return fake.fetch(input, init);
      },
    });
    const write = rest.insert('itens', [{ id: 2 }]);
    await rest.select('itens'); // #362 lida enquanto a escrita está em voo: ainda não vê o 2
    release();
    await write;
    expect(await rest.select('itens')).toHaveLength(2);

    failWrite = true;
    const failing = rest.update('itens', { id: 'eq.1' }, { id: 5 });
    await rest.select('itens', { order: 'id' });
    await expect(failing).rejects.toMatchObject({ status: 503 });
    const before = fake.requests.length;
    await rest.select('itens', { order: 'id' });
    expect(fake.requests.length - before).toBe(1);
  });
});
