// #356 AC-2 A rodada manual ("rodar agora") responde 202 e roda no waitUntil, que o Worker mantém vivo só ~30 s depois da resposta
// #356 (a conta que a #130 fez em dossier/on-demand.ts). Passado esse prazo o `finally` não roda: a linha de automation_runs não é
// #356 gravada e a trava (LOCK_TTL_MS, 5 min) fica presa. Aqui o relógio é falso: a rodada manual tem de ter gravado a linha e
// #356 solto a trava dentro da janela, mesmo com o banco lento ou com um passo do Claude que não responde; o que não coube fica adiado.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { descriptionMatchKey } from '../../src/connectors/claude-suggestions.js';
import { runManualRound } from '../../src/cron/tick.js';
import type { Env } from '../../src/env.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';

/** #356 AC-2 A vida do waitUntil depois da resposta (o que a #130 mediu); a rodada manual tem de caber aqui. */
const WAIT_UNTIL_MS = 30_000;
const ENV: Env = {
  BARTE_ACADEMY_SUPABASE_URL: 'https://fake.supabase.co',
  BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'sb_secret_fake',
  BARTE_ACADEMY_ANTHROPIC_API_KEY: 'sk-ant-fake',
};
const DESCRIPTION = 'Refrigerante sabor cola 2 L';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-23T10:07:30Z'));
  // #356 AC-2 O prazo dos clientes (AbortSignal.timeout) corre no relógio falso, como o do Worker corre no real.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), ms);
    return controller.signal;
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** #356 AC-2 O kit com um item sem SKU: a fila do Claude (description-match) tem trabalho, então o passo do Claude pergunta. */
async function kitWithClaudeWork(): Promise<FakePostgrest> {
  const tables = kitTables();
  const accessKey = String(tables.kit_notas?.find((n) => n.nota_id === 'NF-001')?.chave);
  const item = tables.kit_nota_itens?.find((i) => i.chave === accessKey && i.sku === 'SKU-1006');
  if (!item) throw new Error('kit: item SKU-1006 da NF-001 não encontrado');
  Object.assign(item, { sku: null, codigo_fornecedor: 'F02-X99', descricao: DESCRIPTION });
  const candidates = (tables.kit_produtos ?? []).filter((p) => p.fornecedor_id === 'F02').map((p) => String(p.descricao));
  void (await descriptionMatchKey(DESCRIPTION, candidates));
  // #356 AC-2 A rodada anterior adiou o passo do Claude: ele passa à frente e roda nesta (planRound), então é o passo que pode demorar.
  const previous = { status: 'ok', origin: 'cron', started_at: '2026-11-23T10:00:00Z', finished_at: '2026-11-23T10:00:05Z', deferred_steps: ['claude-description-match'] };
  return new FakePostgrest({ ...tables, automation_runs: [previous], demo_settings: [{ id: true, enabled: true, changed_at: '2026-11-23T09:00:00+00:00' }] });
}

/** #356 AC-2 Dispara a rodada manual e deixa correr a janela do waitUntil; diz se ela terminou dentro dela. */
async function runWithinWindow(): Promise<boolean> {
  let settled = false;
  void runManualRound(ENV).then(
    () => { settled = true; },
    () => { settled = true; },
  );
  await vi.advanceTimersByTimeAsync(WAIT_UNTIL_MS);
  return settled;
}

describe('#356/AC-2 a rodada manual cabe na vida do waitUntil', () => {
  it('#356/AC-2 com um passo do Claude que não responde, a linha é gravada e a trava solta dentro de 30 s', async () => {
    const fake = await kitWithClaudeWork();
    let asked = false;
    vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
      if (!input.includes('anthropic')) return fake.fetch(input, init);
      asked = true;
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
    });
    const settled = await runWithinWindow();
    expect(settled).toBe(true);
    expect(asked).toBe(true);
    expect(fake.rows('automation_runs')).toHaveLength(2);
    expect(fake.rows('automation_runs')[1]).toMatchObject({ origin: 'manual' });
    expect(fake.rows('automation_lock')).toEqual([]);
  });

  it('#356/AC-2 com o banco lento, a rodada para de começar passo a tempo: grava a linha, solta a trava e adia o que não coube', async () => {
    const fake = await kitWithClaudeWork();
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      await sleep(1500);
      return fake.fetch(input, init);
    });
    const settled = await runWithinWindow();
    expect(settled).toBe(true);
    expect(fake.rows('automation_runs')).toHaveLength(2);
    const row = fake.rows('automation_runs')[1];
    expect(row).toMatchObject({ origin: 'manual' });
    expect((row?.deferred_steps as string[]).length).toBeGreaterThan(0);
    expect(fake.rows('automation_lock')).toEqual([]);
  });
});
