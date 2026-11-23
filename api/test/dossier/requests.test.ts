// #311 O estado do pedido do dossiê: só `running` é geração em andamento. O `pending` do backfill espera sua vez e não trava a gaveta nem a geração.
import { describe, expect, it } from 'vitest';
import { inFlight, type DossierRequest } from '../../src/dossier/requests.js';

const NOW = new Date('2026-11-22T12:00:00.000Z');
const request = (over: Partial<DossierRequest>): DossierRequest => ({
  id: 1,
  input_key: 'k',
  requested_by: 'claude',
  requested_at: '2026-11-22T11:59:00.000Z',
  finished_at: null,
  trigger: 'event',
  status: 'running',
  reason: null,
  ...over,
});

describe('#311/AC-4 inFlight conta só o pedido running e recente', () => {
  it('running, aberto há 1 minuto: em andamento', () => {
    expect(inFlight([request({})], NOW)).toBeDefined();
  });
  it('pending, mesmo recente: não é geração em andamento', () => {
    expect(inFlight([request({ status: 'pending', requested_by: 'backfill' })], NOW)).toBeUndefined();
  });
  it('running aberto há mais de 5 minutos: abandonado', () => {
    expect(inFlight([request({ requested_at: '2026-11-22T11:50:00.000Z' })], NOW)).toBeUndefined();
  });
  it('error e done fechados não estão em andamento', () => {
    expect(inFlight([request({ status: 'error', reason: 'rate_limited', finished_at: NOW.toISOString() }), request({ status: 'done', finished_at: NOW.toISOString() })], NOW)).toBeUndefined();
  });
});
