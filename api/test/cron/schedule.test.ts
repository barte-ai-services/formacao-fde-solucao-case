// #333: o despacho do `scheduled` pelo `controller.cron`: o de 15 minutos roda o tick, o do auditor roda só o auditor, e um cron desconhecido não roda nada.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_CRON, CLAUDE_CRON, auditTick, dispatchScheduled } from '../../src/cron/schedule.js';
import type { Env } from '../../src/env.js';
import { harness } from '../supplier/supabase-support.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const NO_ENV = {} as Env;

function runners() {
  return { tick: vi.fn(async () => null), audit: vi.fn(async () => {}) };
}

describe('#333 o scheduled despacha pelo cron que disparou', () => {
  it('#333/AC-1: o cron de 15 minutos roda o tick e não o auditor', async () => {
    const r = runners();
    await dispatchScheduled({ cron: CLAUDE_CRON }, NO_ENV, undefined, r);
    expect(r.tick).toHaveBeenCalledOnce();
    expect(r.audit).not.toHaveBeenCalled();
  });

  it('#333/AC-2: o cron do auditor roda só o auditor, não o tick', async () => {
    const r = runners();
    await dispatchScheduled({ cron: AUDIT_CRON }, NO_ENV, undefined, r);
    expect(r.audit).toHaveBeenCalledOnce();
    expect(r.tick).not.toHaveBeenCalled();
  });

  it('#333/AC-4: um cron que não é nenhum dos configurados não roda nada e registra uma linha, sem segredo, dizendo que é desconhecido', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const r = runners();
    const env = { BARTE_ACADEMY_SUPABASE_URL: 'https://fake.supabase.co', BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'sb_secret_fake', BARTE_ACADEMY_ANTHROPIC_API_KEY: 'chave-de-teste' } as Env;
    await dispatchScheduled({ cron: '0 3 * * *' }, env, undefined, r);
    expect(r.tick).not.toHaveBeenCalled();
    expect(r.audit).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain('desconhecido');
    expect(line).not.toContain('sb_secret_fake');
    expect(line).not.toContain('chave-de-teste');
  });

  it('#333/AC-2: os nomes dos crons são os do wrangler.jsonc, e o do auditor é deslocado do de 15 minutos', () => {
    const text = readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8');
    const json = text.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    const config: unknown = JSON.parse(json);
    expect(config).toMatchObject({ triggers: { crons: [CLAUDE_CRON, AUDIT_CRON] } });
    expect(AUDIT_CRON).not.toBe(CLAUDE_CRON);
  });
});

describe('#333 a invocação do auditor falha fechada', () => {
  it('#333/AC-2: sem as credenciais do Supabase registra uma linha e volta, sem lançar nem chamar a rede', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(auditTick({ cron: AUDIT_CRON }, NO_ENV)).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
  });

  it('#333/AC-2: com o Supabase e sem credencial do Claude, só a linha do Claude: nenhum pedido ao banco', async () => {
    const { fake } = harness();
    vi.stubGlobal('fetch', fake.fetch);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await auditTick({ cron: AUDIT_CRON }, { BARTE_ACADEMY_SUPABASE_URL: 'https://fake.supabase.co', BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'sb_secret_fake' } as Env);
    expect(fake.requests).toEqual([]);
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('sem credencial do Claude');
  });
});
