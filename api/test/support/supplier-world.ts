// #156: o "mundo" dos testes do pedido ao fornecedor pela API: o Worker montado, o PostgREST falso com o kit e a fila,
// #156: o Access assinado no teste, o Cron do rascunho e as chamadas HTTP. Nenhuma rede: tudo cai no FakePostgrest.
import { ClaudeClient, type Ask } from '../../src/claude/client.js';
import { restDb } from '../../src/claude/db.js';
import { runTasks } from '../../src/claude/runner.js';
import type { Env } from '../../src/env.js';
import type { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { route } from '../../src/http/router.js';
import type { SupplierMailer } from '../../src/supplier/ports.js';
import { supplierRequestDraftTask } from '../../src/supplier/draft-task.js';
import { supplierDeps } from '../../src/supplier/supabase-deps.js';
import { tasksFor } from '../../src/claude/tasks/index.js';
import { SOURCE_KEY } from '../domain/supplier-request-fixtures.js';
import { NOW, SUPPLIER_EMAIL, fakeAsk } from '../supplier/doubles.js';
import { harness, invoiceRow, queueRow, supplierRow } from '../supplier/supabase-support.js';
import { accessEnv, accessKit } from './access-token.js';
import type { FakePostgrest } from './fake-postgrest.js';

export type WorldOptions = {
  /** #156: o e-mail da identidade do Access; vazio é um service token, sem e-mail. */
  readonly email?: string;
  readonly mailer?: SupplierMailer;
  /** #156: o `Ask` do "refazer"; sem ele, o do Env (sem credencial, nenhum). */
  readonly ask?: Ask | null;
  /** #156: `missing` simula o Worker sem as credenciais do Supabase. */
  readonly supabase?: 'ok' | 'missing';
  readonly env?: Env;
  /** #156: sem a devolução pendente na fila. */
  readonly emptyQueue?: boolean;
  /** #157: o relógio do Worker (o dia de hoje do prazo e o carimbo do envio); padrão, o dia do rascunho da #156. */
  readonly now?: Date;
};

export type Reply = { readonly status: number; readonly body: Record<string, unknown>; readonly headers: Headers };

/** #156: a resposta que não é JSON (o PDF da nota), lida como texto: o PDF do mock é só ASCII. */
export type Download = { readonly status: number; readonly headers: Headers; readonly text: string };

export type CallInit = { readonly body?: unknown; readonly json?: boolean; readonly token?: boolean; readonly raw?: string };

const JSON_TYPE = { 'Content-Type': 'application/json' };

export type SupplierWorld = {
  readonly fake: FakePostgrest;
  readonly rest: SupabaseRest;
  readonly call: (method: string, path: string, init?: CallInit) => Promise<Reply>;
  /** #156: um GET cujo corpo não é JSON, pelo mesmo roteador. */
  readonly download: (path: string) => Promise<Download>;
  readonly runCron: (ask?: Ask) => Promise<readonly string[]>;
  /** #157: muda o dia de hoje do Worker (o prazo da cobrança). */
  readonly setNow: (now: Date) => void;
  /** #157: o fornecedor responde: uma mensagem pendente na caixa de entrada mock, ligada ao pedido (o que o script de exemplo faz). */
  readonly receive: (text: string, requestId?: number) => void;
  /** #157: o laço do Cron com TODAS as tarefas registradas em tasksFor (a leitura, a cobrança e as demais); o `Ask` é o falso. */
  readonly runAllTasks: (ask: Ask) => Promise<readonly string[]>;
  readonly path: (suffix?: string, key?: string) => string;
  readonly rows: (table: string) => Record<string, unknown>[];
  readonly key: string;
};

export async function supplierWorld(options: WorldOptions = {}): Promise<SupplierWorld> {
  const { fake, rest } = harness({
    invoices: [invoiceRow()],
    kit_fornecedores: [supplierRow()],
    outbox_return_notes: options.emptyQueue ? [] : [queueRow()],
  });
  // #157: as restrições únicas da migração da leitura (#157): a caixa pela origem e o único no_reply por pedido.
  fake.unique('inbox_supplier_messages', ['source_message_id']);
  fake.unique('supplier_reply_readings', ['request_id'], (row) => row.message_id === null || row.message_id === undefined);
  const kit = await accessKit(options.email ?? 'ana@jachegou.test');
  const token = await kit.token();
  let current = options.now ?? NOW;
  const clock = { now: () => current };
  const env: Env = { ...accessEnv, ...options.env };
  const supplierRequests = {
    supabase: () => (options.supabase === 'missing' ? null : rest),
    clock,
    ...(options.mailer ? { mailer: options.mailer } : {}),
    ...(options.ask !== undefined ? { ask: () => options.ask ?? null } : {}),
  };

  /** #156: uma chamada HTTP pelo roteador de verdade; escrita leva JSON por padrão. */
  async function call(method: string, path: string, init: CallInit = {}): Promise<Reply> {
    const writing = method !== 'GET';
    const headers: Record<string, string> = { ...(init.token === false ? {} : { 'Cf-Access-Jwt-Assertion': token }) };
    if (writing && init.json !== false) Object.assign(headers, JSON_TYPE);
    const text = !writing ? undefined : (init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)));
    const request = new Request(`https://worker.test${path}`, { method, headers, ...(text === undefined ? {} : { body: text }) });
    const response = await route(request, env, { verifier: kit.verifier, supplierRequests });
    const body: unknown = await response.json();
    return { status: response.status, body: typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}, headers: response.headers };
  }

  /** #156: o GET do PDF da nota, com o Access assinado, pelo roteador de verdade. */
  async function download(path: string): Promise<Download> {
    const request = new Request(`https://worker.test${path}`, { method: 'GET', headers: { 'Cf-Access-Jwt-Assertion': token } });
    const response = await route(request, env, { verifier: kit.verifier, supplierRequests });
    return { status: response.status, headers: response.headers, text: await response.text() };
  }

  /** #156 (#156): o Cron roda a tarefa do rascunho com o Claude falso: o mesmo laço da produção, só a pergunta é nossa. */
  async function runCron(ask: Ask = fakeAsk()): Promise<readonly string[]> {
    const log: string[] = [];
    await runTasks({
      db: restDb(rest),
      ask,
      tasks: [supplierRequestDraftTask(supplierDeps(rest, { clock }))],
      log: (line) => log.push(line),
      now: clock.now,
    });
    return log;
  }

  /** #157: o mesmo laço, com o registro de tarefas de produção (tasksFor); só a pergunta ao Claude é nossa. */
  async function runAllTasks(ask: Ask): Promise<readonly string[]> {
    const log: string[] = [];
    await runTasks({ db: restDb(rest), ask, tasks: tasksFor(rest), log: (line) => log.push(line), now: clock.now });
    return log;
  }

  const setNow = (now: Date): void => {
    current = now;
  };
  let messages = 0;
  const receive = (text: string, requestId = 1): void => {
    messages += 1;
    const row = { id: messages, request_id: requestId, source_message_id: `origem-${messages}`, from_address: SUPPLIER_EMAIL, body: text, attachments_meta: [], received_at: current.toISOString(), read_status: 'pending', read_error: null, read_status_at: null, read_status_by: null, created_at: current.toISOString() };
    fake.tables.set('inbox_supplier_messages', [...fake.rows('inbox_supplier_messages'), row]);
  };

  const path = (suffix = '', key = SOURCE_KEY): string => `/api/supplier-requests/${key}${suffix}`;
  const rows = (table: string) => fake.rows(table);
  return { fake, rest, call, download, runCron, runAllTasks, setNow, receive, path, rows, key: SOURCE_KEY };
}

/** #156: um `Ask` de verdade (o cliente do Claude) sobre um fetch falso que responde com o status dado. */
export const askFailingWith = (status: number): Ask =>
  new ClaudeClient({ credentials: { kind: 'api-key', apiKey: 'chave-de-teste' }, fetch: async () => new Response('{}', { status }) }).ask;
