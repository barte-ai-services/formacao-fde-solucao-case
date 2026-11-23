// #333 #356: o despacho do `scheduled` pelo `controller.cron`: o de minuto (#356) roda o tick, o do auditor roda só o auditor, e um cron desconhecido não roda nada.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_CRON, TICK_CRON, DOSSIER_CRON, auditTick, dispatchScheduled, dossierTick } from '../../src/cron/schedule.js';
import { isRecord } from '../../src/connectors/guards.js';
import type { Env } from '../../src/env.js';
import { harness } from '../supplier/supabase-support.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const NO_ENV = {} as Env;

function runners() {
  return { tick: vi.fn(async () => null), audit: vi.fn(async () => {}), dossier: vi.fn(async () => {}) };
}

describe('#333 o scheduled despacha pelo cron que disparou', () => {
  it('#356/AC-1: o cron de minuto roda o tick e não o auditor', async () => {
    const r = runners();
    await dispatchScheduled({ cron: TICK_CRON }, NO_ENV, r);
    expect(r.tick).toHaveBeenCalledOnce();
    expect(r.audit).not.toHaveBeenCalled();
  });

  it('#333/AC-2: o cron do auditor roda só o auditor, não o tick', async () => {
    const r = runners();
    await dispatchScheduled({ cron: AUDIT_CRON }, NO_ENV, r);
    expect(r.audit).toHaveBeenCalledOnce();
    expect(r.tick).not.toHaveBeenCalled();
  });

  it('#311/AC-2: o cron próprio do dossiê roda só o dossiê, nem o tick nem o auditor', async () => {
    const r = runners();
    await dispatchScheduled({ cron: DOSSIER_CRON }, NO_ENV, r);
    expect(r.dossier).toHaveBeenCalledOnce();
    expect(r.tick).not.toHaveBeenCalled();
    expect(r.audit).not.toHaveBeenCalled();
  });

  it('#311/AC-2: o cron de minuto não roda o dossiê', async () => {
    const r = runners();
    await dispatchScheduled({ cron: TICK_CRON }, NO_ENV, r);
    expect(r.dossier).not.toHaveBeenCalled();
  });

  it('#333/AC-4: um cron que não é nenhum dos configurados não roda nada e registra uma linha, sem segredo, dizendo que é desconhecido', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const r = runners();
    const env = { BARTE_ACADEMY_SUPABASE_URL: 'https://fake.supabase.co', BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'sb_secret_fake', BARTE_ACADEMY_ANTHROPIC_API_KEY: 'chave-de-teste' } as Env;
    await dispatchScheduled({ cron: '0 3 * * *' }, env, r);
    expect(r.tick).not.toHaveBeenCalled();
    expect(r.audit).not.toHaveBeenCalled();
    expect(r.dossier).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain('desconhecido');
    expect(line).not.toContain('sb_secret_fake');
    expect(line).not.toContain('chave-de-teste');
  });

  it('#333/AC-2: os nomes dos crons são os do wrangler.jsonc, e o do tick é de minuto e o do auditor e o do dossiê são deslocados de 15 em 15', () => {
    const text = readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8');
    const json = text.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    const config: unknown = JSON.parse(json);
    expect(config).toMatchObject({ triggers: { crons: [TICK_CRON, AUDIT_CRON, DOSSIER_CRON] } });
    expect(new Set([TICK_CRON, AUDIT_CRON, DOSSIER_CRON]).size).toBe(3);
    // #311 O plano gratuito permite 5 cron triggers por conta (docs da Cloudflare): este Worker usa 3.
    const crons = isRecord(config) && isRecord(config.triggers) && Array.isArray(config.triggers.crons) ? config.triggers.crons : [];
    expect(crons.length).toBeLessThanOrEqual(5);
  });
});

describe('#356/AC-1 o cron de minuto e os outros dois, no mesmo minuto, são invocações separadas', () => { // ADR-002
  it('#356/AC-1 a expressão do tick é a de todo minuto, e as outras duas seguem as de 15 em 15', () => {
    expect(TICK_CRON).toBe('* * * * *');
    expect(AUDIT_CRON).toBe('7-59/15 * * * *');
    expect(DOSSIER_CRON).toBe('11-59/15 * * * *');
  });

  it('#356/AC-1 nos minutos 7 e 11 as três invocações disparam juntas, e cada uma só chama o handler da sua expressão', async () => {
    const expected = [
      [TICK_CRON, 'tick'], [AUDIT_CRON, 'audit'], [DOSSIER_CRON, 'dossier'],
    ] as const;
    for (const [cron, handler] of expected) {
      const r = runners();
      await dispatchScheduled({ cron, scheduledTime: Date.parse('2026-11-23T10:07:00Z') }, NO_ENV, r);
      for (const name of ['tick', 'audit', 'dossier'] as const) {
        expect(r[name], `${cron} -> ${name}`).toHaveBeenCalledTimes(name === handler ? 1 : 0);
      }
    }
  });

  it('#356/AC-1 o despacho entrega ao tick o controller inteiro, com o scheduledTime que decide o ritmo', async () => {
    const r = runners();
    const controller = { cron: TICK_CRON, scheduledTime: Date.parse('2026-11-23T10:15:00Z') };
    await dispatchScheduled(controller, NO_ENV, r);
    expect(r.tick).toHaveBeenCalledWith(controller, NO_ENV);
  });

  it('#356/AC-1 o comentário do wrangler.jsonc diz o ritmo de minuto', () => {
    const text = readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8');
    expect(text).toContain('* * * * *');
    expect(text).not.toContain('A cada 15 minutos: a captura');
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

describe('#311 a invocação do dossiê falha fechada', () => {
  it('#311/AC-3: sem as credenciais do Supabase registra uma linha e volta, sem lançar nem chamar a rede', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(dossierTick({ cron: DOSSIER_CRON }, NO_ENV)).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
  });
});
