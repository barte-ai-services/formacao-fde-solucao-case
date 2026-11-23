// #157: o guarda da conta de subrequests das duas invocações agendadas (#333): mede cada rodada de verdade, com as tarefas de tasksFor (a rodada de 15 minutos) ou de auditTasksFor (a do auditor) e a fila cheia de cada uma.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CRON_LIMIT, runAuditRound, runClaudeRound } from '../../src/claude/cron.js';
import { restDb } from '../../src/claude/db.js';
import { AUDIT_NOTES_PER_RUN, auditTasksFor, tasksFor } from '../../src/claude/tasks/index.js';
import { AUDIT_FIXED_WORST, AUDIT_MAX_READS, AUDIT_MAX_TURNS, AUDIT_PER_NOTE_WORST, AUDIT_PRE_READS } from '../../src/claude/tasks/invoice-audit.js';
import { AUDIT_CALLS_PER_NOTE, ENV, fullWorld, messagesApi } from '../support/budget-world.js';

/** #157: os 50 subrequests do plano gratuito do Worker, contados aqui só para a varredura e a rodada do Claude (api/src/claude/cron.ts). */
const SUBREQUEST_LIMIT = 50;
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Measure = { readonly sweep: number; readonly reads: number; readonly messages: number; readonly total: number };

/**
 * #157/#333: a rodada de 15 minutos (a varredura no teto e a rodada do Claude, sem o auditor) ou a do auditor (só ele,
 * sem varredura), com a fila cheia de cada tarefa, contadas fetch a fetch.
 */
async function measureRound(round: 'principal' | 'auditor' = 'principal', auditTurns = AUDIT_CALLS_PER_NOTE): Promise<Measure> {
  const { world: w, sweep: swept } = await fullWorld();
  const audit = round === 'auditor';
  const sweep = audit ? 0 : swept;
  const tasks = audit ? auditTasksFor(w.rest) : tasksFor(w.rest);
  // #157: a precondição: toda tarefa tem na fila ao menos o que a rodada atende, senão a medida não é o pior caso.
  const queued = await Promise.all(tasks.map(async (t) => [t.name, (await t.pending(restDb(w.rest))).requests.length, Math.min(t.limit ?? CRON_LIMIT, t.maxPerRun ?? CRON_LIMIT, CRON_LIMIT)] as const));
  for (const [name, pending, limit] of queued) expect(pending, `fila de ${name}`).toBeGreaterThanOrEqual(limit);
  const api = messagesApi((key) => w.fake.rows('proposals').find((row) => row.invoice_access_key === key), auditTurns);
  const start = w.fake.requests.length;
  const result = await (audit ? runAuditRound : runClaudeRound)(w.rest, ENV, { fetch: api.fetch, log: () => {} });
  const reads = w.fake.requests.length - start;
  expect(result.failedTasks).toEqual([]);
  expect(api.calls(), 'cada tarefa pergunta ao Claude até o limite dela').toBe(queued.reduce((sum, [name, , limit]) => sum + (name === 'invoice-audit' ? auditTurns : 1) * limit, 0));
  return { sweep, reads, messages: api.calls(), total: sweep + reads + api.calls() };
}

/** #157: o gasto de antes da #157, com a tarefa da cobrança no Cron (varredura 4, PostgREST 47, Messages API 6). */
const BEFORE_58 = 57;

/** #333: o gasto medido da rodada de 15 minutos (varredura 6 + rodada do Claude 44), sem o auditor; quem acrescenta uma leitura ou uma tarefa muda este número e vê o teste cair. */
const MEASURED_TOTAL = 50;

/** #333 #337/AC-6: o gasto medido da invocação do auditor (2 chamadas à Messages API e 10 ao banco: as 4 leituras de antes do laço entre elas, com a ordem citada), com a fila cheia e 1 nota por invocação (AUDIT_NOTES_PER_RUN). */
const AUDITOR_SUBREQUESTS = 12;

/** #333/AC-7, AC-9: o gasto medido da invocação do auditor no pior caso do teto de voltas dele (18 chamadas à Messages API, as 4 leituras de antes do laço, as 12 leituras que passam e 6 ao banco, da gravação e do laço; a conta de 42 fica acima dos 40 medidos). */
const AUDITOR_WORST_MEASURED = 40;

describe('#157 a conta das subrequests da rodada do Cron, medida na rodada de verdade', () => {
  it('#333/AC-1: a varredura e a rodada do Claude, com a fila cheia de cada tarefa de tasksFor, gastam o que está medido, e uma leitura a mais ou uma tarefa nova faz o teste cair', async () => {
    const m = await measureRound();
    expect(m.total).toBe(MEASURED_TOTAL);
  });

  it('#333/AC-1: a rodada de 15 minutos não roda o auditor: 5 chamadas ao Claude, uma por tarefa do #157, e nenhuma delas é a auditoria', async () => {
    const m = await measureRound();
    expect(m.total).toBeLessThan(BEFORE_58);
    expect(m.messages).toBe(5);
  });

  it('#333/AC-1, AC-3: a varredura e a rodada do Claude cabem nos 50 subrequests do plano gratuito', async () => {
    const m = await measureRound();
    expect(m.total).toBeLessThanOrEqual(SUBREQUEST_LIMIT);
  });
});

describe('#333 a conta das subrequests da invocação do auditor, medida pelo mesmo método', () => {
  it('#333/AC-2: a invocação do auditor, com a fila cheia, gasta o que está medido e cabe nos 50 subrequests', async () => {
    const m = await measureRound('auditor');
    expect(m.total).toBe(AUDITOR_SUBREQUESTS);
    expect(m.total).toBeLessThanOrEqual(SUBREQUEST_LIMIT);
    expect(m.messages).toBe(AUDIT_CALLS_PER_NOTE * AUDIT_NOTES_PER_RUN);
  });

  it('#333/AC-2, AC-9: o pior caso do auditor (42 no primeiro, 38 por nota a mais, de invoice-audit.ts, com o teto de voltas e de leituras próprios da #333) cabe nos 50 com as notas por invocação escolhidas', () => {
    const worstCase = AUDIT_FIXED_WORST + AUDIT_PER_NOTE_WORST * AUDIT_NOTES_PER_RUN;
    expect(AUDIT_NOTES_PER_RUN).toBeGreaterThanOrEqual(1);
    expect(worstCase).toBeLessThanOrEqual(SUBREQUEST_LIMIT);
    // #337/AC-6 38 da #333 mais as AUDIT_PRE_READS = 4 leituras de antes do laço (duplicidade por número e por ordem, pagamento fora do fluxo e o saldo da ordem citada).
    expect(AUDIT_PRE_READS).toBe(4);
    expect(AUDIT_FIXED_WORST + AUDIT_PER_NOTE_WORST).toBe(42);
  });

  it('#333/AC-7: a invocação do auditor no pior caso do teto de voltas novo (todas as voltas, as 12 leituras e a gravação) gasta no máximo 50 subrequests e a nota é auditada', async () => {
    const m = await measureRound('auditor', AUDIT_MAX_TURNS);
    expect(m.messages).toBe(AUDIT_MAX_TURNS * AUDIT_NOTES_PER_RUN);
    expect(m.total).toBe(AUDITOR_WORST_MEASURED);
    expect(m.total).toBeLessThanOrEqual(AUDIT_FIXED_WORST + AUDIT_PER_NOTE_WORST * AUDIT_NOTES_PER_RUN);
    expect(m.total).toBeLessThanOrEqual(SUBREQUEST_LIMIT);
  });

  it('#333/AC-7, AC-9: a conta de pior caso do auditor deriva dos tetos: voltas + leituras + 4 por nota e 4 fixas, e o teto escolhido deixa folga nos 50', () => {
    expect(AUDIT_MAX_TURNS).toBeGreaterThan(6);
    expect(AUDIT_PER_NOTE_WORST).toBe(AUDIT_MAX_TURNS + AUDIT_PRE_READS + AUDIT_MAX_READS + 4);
    expect(AUDIT_FIXED_WORST + AUDIT_PER_NOTE_WORST * AUDIT_NOTES_PER_RUN).toBeLessThanOrEqual(SUBREQUEST_LIMIT);
    // #333/AC-9 #337/AC-6 O maior teto que ainda caberia seria 26 voltas (com 12 leituras e as 4 de antes do laço); o escolhido (18, o que se mediu) deixa 8 de folga.
    expect(SUBREQUEST_LIMIT - AUDIT_FIXED_WORST - (AUDIT_PRE_READS + AUDIT_MAX_READS + 4) * AUDIT_NOTES_PER_RUN).toBe(26);
    expect(AUDIT_MAX_TURNS).toBeLessThanOrEqual(26 - 8);
  });
});
