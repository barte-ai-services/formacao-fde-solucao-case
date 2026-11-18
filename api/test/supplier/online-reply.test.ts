// Testes online da persistência da leitura da resposta (#35, a integração da issue). Pulam sem as credenciais do Supabase.
// #35 Mesmas variáveis do online.test.ts (#59): BARTE_ACADEMY_SUPABASE_URL e _SECRET_KEY para o PostgREST; para o catálogo e o
// #35 plano, a API de gestão: BARTE_ACADEMY_SUPABASE_ACCESS_TOKEN e _PROJECT_ID. Nenhum valor é impresso, nem o corpo de um erro.
// #35 A migração 20261117170000 é aplicada pela esteira no merge; contra um banco sem ela, os testes pulam com o aviso abaixo.
import { describe, expect, it } from 'vitest';
import { SupabaseRest, SupabaseRestError } from '../../src/connectors/supabase-rest.js';

function env(name: string): string | undefined {
  const value: unknown = Reflect.get(process.env, name);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

const URL_ = env('BARTE_ACADEMY_SUPABASE_URL');
const KEY = env('BARTE_ACADEMY_SUPABASE_SECRET_KEY');
const TOKEN = env('BARTE_ACADEMY_SUPABASE_ACCESS_TOKEN');
const PROJECT = env('BARTE_ACADEMY_SUPABASE_PROJECT_ID');

const REST_ONLINE = Boolean(URL_ && KEY);
const SQL_ONLINE = REST_ONLINE && Boolean(TOKEN && PROJECT);

const rest = new SupabaseRest({ url: URL_ ?? '', secretKey: KEY ?? '' });

/** #35 Só a falta da relação ou da coluna quer dizer "migração não aplicada": 42703 e 42P01 do PostgreSQL, PGRST204 e PGRST205 do PostgREST. */
const MISSING = /42703|42P01|PGRST204|PGRST205/;

/**
 * #35 A migração desta camada está aplicada no banco das credenciais? `read_status_by` e `follow_up_claim` são as colunas mais novas
 * #35 que ela trouxe. Qualquer outro erro (chave errada ou vencida, permissão, rede) é lançado: o teste falha em vez de pular.
 */
async function migrationApplied(): Promise<boolean> {
  if (!REST_ONLINE) return false;
  try {
    await rest.select('inbox_supplier_messages', { select: 'read_status_by', limit: 1 });
    await rest.select('outbox_supplier_emails', { select: 'follow_up_claim', limit: 1 });
    return true;
  } catch (error) {
    if (error instanceof SupabaseRestError && MISSING.test(error.detail)) return false;
    throw error;
  }
}
const APPLIED = await migrationApplied();
if (REST_ONLINE && !APPLIED) {
  console.warn('#35 online: a migração 20261117170000_inbox_supplier_messages ainda não está aplicada neste banco; os testes pulam.');
}
if (REST_ONLINE && !SQL_ONLINE) {
  console.warn('#35 online: sem BARTE_ACADEMY_SUPABASE_ACCESS_TOKEN e _PROJECT_ID, o catálogo e o EXPLAIN pulam.');
}

/** #35 Uma consulta pela API de gestão do Supabase; devolve o JSON da resposta. A falha diz só o status, nunca o corpo. */
async function sql(query: string): Promise<unknown> {
  const response = await fetch(`https://api.supabase.com/v1/projects/${PROJECT ?? ''}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN ?? ''}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`a consulta ao catálogo falhou (HTTP ${response.status})`);
  return response.json();
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  return Array.isArray(result) ? result.filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null) : [];
}

/** #35 O plano de uma consulta sem varredura sequencial permitida: com poucas linhas o planejador preferiria varrer a tabela. */
const plan = async (query: string): Promise<string> =>
  JSON.stringify(await sql(`set local enable_seqscan = off; explain (format json) ${query}`));

describe.skipIf(!SQL_ONLINE || !APPLIED)('#35 catálogo e plano, no Supabase real', () => {
  it('service_role não pode UPDATE nem DELETE em supplier_reply_readings: a leitura é um log append-only', async () => {
    const [row] = rowsOf(
      await sql(`select has_table_privilege('service_role', 'public.supplier_reply_readings', 'UPDATE') as can_update,
        has_table_privilege('service_role', 'public.supplier_reply_readings', 'DELETE') as can_delete`),
    );
    expect(row).toEqual({ can_update: false, can_delete: false });
  });

  it('service_role só atualiza as colunas concedidas de inbox_supplier_messages, e não apaga', async () => {
    const columns = rowsOf(
      await sql(`select attname from pg_attribute
        where attrelid = 'public.inbox_supplier_messages'::regclass and attnum > 0 and not attisdropped
        and has_column_privilege('service_role', attrelid, attnum, 'UPDATE') order by attname`),
    ).map((r) => r.attname);
    expect(columns).toEqual(['read_error', 'read_status', 'read_status_at', 'read_status_by']);
    const [row] = rowsOf(await sql(`select has_table_privilege('service_role', 'public.inbox_supplier_messages', 'DELETE') as can_delete`));
    expect(row).toEqual({ can_delete: false });
  });

  it('QI1: a listagem das pendentes usa o índice parcial', async () => {
    const text = await plan(`select id, request_id, body from public.inbox_supplier_messages where read_status = 'pending' order by id`);
    expect(text).toContain('inbox_supplier_messages_pending_idx');
  });

  it('as leituras por pedido, na ordem da projeção, usam o índice (request_id, message_id desc)', async () => {
    const text = await plan(`select id from public.supplier_reply_readings where request_id = 1 order by message_id desc nulls last`);
    expect(text).toContain('supplier_reply_readings_request_idx');
  });
});

describe.skipIf(!REST_ONLINE || !APPLIED)('#35 a versão velha na cobrança, no Supabase real', () => {
  it('um PATCH da cobrança com a versão velha atinge 0 linhas e nada grava (PER-4)', async (ctx) => {
    const [first] = await rest.select('outbox_supplier_emails', { select: 'id', limit: 1 });
    const id = typeof first === 'object' && first !== null && 'id' in first && typeof first.id === 'number' ? first.id : null;
    // #35 Sem nenhuma linha na tabela, o PATCH não atingiria nada de qualquer jeito: a asserção passaria sem provar a guarda.
    if (id === null) ctx.skip('outbox_supplier_emails está vazia: não há linha para provar a guarda da versão velha');
    const updated = await rest.update('outbox_supplier_emails', { id: `eq.${id}`, version: 'eq.-1' }, { follow_up_failure: null });
    expect(updated).toHaveLength(0);
  });
});
