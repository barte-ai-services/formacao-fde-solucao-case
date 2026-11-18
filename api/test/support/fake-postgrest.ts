// Fake do PostgREST em memória, servido por um fetch injetado (#59). Cobre o que o cliente usa:
// #59 select paginado por Range, filtros eq, insert com on_conflict e resolution, PATCH e DELETE.
// #156 select com recurso embutido (proposals -> approvals, invoices -> divergences), pelas chaves estrangeiras.
import type { FetchFn } from '../../src/connectors/supabase-rest.js';

type Row = Record<string, unknown>;

type SelectItem = { name: string; embed?: SelectItem[] };

/** #157 O PostgREST escolhe a chave estrangeira pelo nome depois de `!` (`rel!fk_name(cols)`); o fake só tem uma por relação. */
const relationName = (name: string): string => name.split('!')[0] ?? name;

/** #157 Compara duas células da ordenação: números como números (10 depois de 9), texto como texto, nulo por último. */
function compare(a: unknown, b: unknown): number {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const x = String(a);
  const y = String(b);
  return x === y ? 0 : x < y ? -1 : 1;
}

/** #157 `order=a.desc.nullslast,b`: ordena as linhas como o PostgREST; o nulo vai por último (o fake não distingue nullsfirst).
 * #157 Difere do PostgreSQL, que no DESC põe o nulo primeiro sem a cláusula: nenhum adaptador da #157 ordena DESC numa coluna anulável
 * #157 sem `nullslast` explícito (READINGS_ORDER), então o fake e o banco concordam. Um adaptador novo que o faça deve dizer o nulo. */
function sortRows(rows: Row[], order: string): Row[] {
  const specs = order.split(',').map((spec) => {
    const [column = '', ...modifiers] = spec.split('.');
    return { column, desc: modifiers.includes('desc') };
  });
  return [...rows].sort((a, b) => {
    for (const { column, desc } of specs) {
      const nulls = a[column] == null || b[column] == null;
      const c = compare(a[column], b[column]);
      if (c !== 0) return nulls ? c : desc ? -c : c;
    }
    return 0;
  });
}

/** #156 As chaves estrangeiras que o fake sabe embutir: muitos-para-um e um-para-um dão objeto ou null; um-para-muitos, lista. */
const RELATIONS: Record<string, Record<string, { table: string; local: string; foreign: string; many: boolean }>> = {
  proposals: {
    approvals: { table: 'approvals', local: 'id', foreign: 'proposal_id', many: false },
    invoices: { table: 'invoices', local: 'invoice_access_key', foreign: 'access_key', many: false },
  },
  invoices: { divergences: { table: 'divergences', local: 'access_key', foreign: 'invoice_access_key', many: true } },
  // #157 O pedido ao fornecedor: o fornecedor (muitos-para-um) e as leituras da resposta (um-para-muitos, pela chave estrangeira do pedido).
  outbox_supplier_emails: {
    kit_fornecedores: { table: 'kit_fornecedores', local: 'supplier_id', foreign: 'fornecedor_id', many: false },
    supplier_reply_readings: { table: 'supplier_reply_readings', local: 'id', foreign: 'request_id', many: true },
  },
};

/** #156 Lê `a,b,rel(c,rel2(d))` do select do PostgREST, separando só nas vírgulas de fora dos parênteses. */
function parseSelect(select: string): SelectItem[] {
  const items: SelectItem[] = [];
  let depth = 0;
  let start = 0;
  const flush = (end: number): void => {
    const text = select.slice(start, end).trim();
    const open = text.indexOf('(');
    if (open < 0) items.push({ name: text });
    else items.push({ name: text.slice(0, open), embed: parseSelect(text.slice(open + 1, text.length - 1)) });
  };
  for (let i = 0; i < select.length; i += 1) {
    if (select[i] === '(') depth += 1;
    else if (select[i] === ')') depth -= 1;
    else if (select[i] === ',' && depth === 0) {
      flush(i);
      start = i + 1;
    }
  }
  flush(select.length);
  return items;
}

export class FakePostgrest {
  readonly tables = new Map<string, Row[]>();
  readonly requests: { method: string; url: string; headers: Record<string, string>; body: unknown }[] = [];
  private nextId = 1;
  private readonly sequences = new Map<string, number>();
  private readonly uniques: { table: string; columns: string[]; when: (row: Row) => boolean }[] = [];
  private readonly failures: { table: string; method: string; status: number; body: unknown }[] = [];

  constructor(seed: Record<string, Row[]> = {}) {
    for (const [t, rows] of Object.entries(seed)) this.tables.set(t, rows.map((r) => ({ ...r })));
  }

  rows(table: string): Row[] {
    return this.tables.get(table) ?? [];
  }

  /** #156 Uma restrição única (parcial, se `when` filtra): o POST que a viola volta 409 com o código 23505, como o PostgREST. */
  unique(table: string, columns: string[], when: (row: Row) => boolean = () => true): void {
    this.uniques.push({ table, columns, when });
  }

  /** #156 A próxima requisição da tabela e do método falha com este status e corpo (uma vez). */
  failNext(table: string, method: string, status: number, body: unknown): void {
    this.failures.push({ table, method, status, body });
  }

  readonly fetch: FetchFn = async (input, init = {}) => {
    const url = new URL(input);
    const table = url.pathname.replace(/^\/rest\/v1\//, '');
    const headers = (init.headers ?? {}) as Record<string, string>;
    const method = init.method ?? 'GET';
    const params = url.searchParams;
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    this.requests.push({ method, url: input, headers, body });
    const rows = this.tables.get(table) ?? [];
    this.tables.set(table, rows);
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
    const failureAt = this.failures.findIndex((f) => f.table === table && f.method === method);
    if (failureAt >= 0) {
      const [failure] = this.failures.splice(failureAt, 1);
      return json(failure!.status, failure!.body);
    }

    if (method === 'GET') {
      let result = rows.filter((r) => this.matches(r, params));
      const order = params.get('order');
      if (order) result = sortRows(result, order);
      const limit = params.get('limit');
      if (limit) result = result.slice(0, Number(limit));
      const range = headers.Range;
      if (range) {
        const [from, to] = range.split('-').map(Number) as [number, number];
        result = result.slice(from, to + 1);
      }
      const select = params.get('select');
      if (select && select !== '*') result = result.map((r) => this.project(table, r, parseSelect(select), params));
      return json(200, result);
    }
    if (method === 'POST') {
      const conflict = params.get('on_conflict')?.split(',');
      const prefer = headers.Prefer ?? '';
      const out: Row[] = [];
      for (const incoming of body as Row[]) {
        const existing = conflict ? rows.find((r) => conflict.every((c) => r[c] === incoming[c])) : undefined;
        if (existing) {
          if (prefer.includes('resolution=ignore-duplicates')) continue;
          if (prefer.includes('resolution=merge-duplicates')) {
            Object.assign(existing, incoming);
            out.push(existing);
            continue;
          }
          return json(409, { code: '23505', message: 'duplicate key' });
        }
        const row: Row = { ...this.defaults(table), ...incoming };
        const violated = this.uniques.some(
          (u) => u.table === table && u.when(row) && rows.some((r) => u.when(r) && u.columns.every((c) => r[c] === row[c])),
        );
        if (violated) return json(409, { code: '23505', message: 'duplicate key value violates unique constraint' });
        rows.push(row);
        out.push(row);
      }
      return json(201, out);
    }
    if (method === 'PATCH') {
      const hit = rows.filter((r) => this.matches(r, params));
      for (const r of hit) Object.assign(r, body as Row);
      return json(200, hit);
    }
    if (method === 'DELETE') {
      this.tables.set(table, rows.filter((r) => !this.matches(r, params)));
      return new Response(null, { status: 204 });
    }
    return json(405, {});
  };

  /** #156 Projeta as colunas do select e monta os recursos embutidos pelas chaves estrangeiras. */
  private project(table: string, row: Row, items: SelectItem[], params: URLSearchParams): Row {
    const out: Row = {};
    for (const item of items) {
      // #230 `*,invoices(*)`: o curinga traz todas as colunas da linha, como no PostgREST.
      if (item.name === '*') {
        Object.assign(out, row);
        continue;
      }
      if (item.embed === undefined) {
        out[item.name] = row[item.name];
        continue;
      }
      const name = relationName(item.name);
      const relation = RELATIONS[table]?.[name];
      if (!relation) throw new Error(`fake: relação não suportada ${table}.${name}`);
      // #157 `<relação>.order=` ordena o recurso embutido, como na sintaxe de filtros embutidos do PostgREST.
      const embedOrder = params.get(`${name}.order`);
      const found = this.rows(relation.table).filter((r) => r[relation.foreign] === row[relation.local]);
      const related = (embedOrder ? sortRows(found, embedOrder) : found).map((r) => this.project(relation.table, r, item.embed ?? [], params));
      out[name] = relation.many ? related : (related[0] ?? null);
    }
    return out;
  }

  private defaults(table: string): Row {
    const now = new Date().toISOString();
    // #140 A fila de devolução: o estado inicial e as colunas que a migração deixa nulas.
    if (table === 'outbox_return_notes') {
      return {
        id: this.nextId++,
        published_at: now,
        status: 'pendente',
        nfe_number: null,
        emitted_by: null,
        emitted_at: null,
        cancel_justification: null,
        cancelled_by: null,
        cancelled_at: null,
      };
    }
    // #156 O pedido ao fornecedor e a nota emitida: identidade por tabela e as colunas que a migração deixa nulas.
    if (table === 'outbox_supplier_emails') {
      return {
        id: this.sequence(table),
        status: 'draft',
        discard_reason: null,
        send_failure_reason: null,
        issued_return_note_id: null,
        channel: null,
        provider_message_id: null,
        sent_by: null,
        sent_at: null,
        discarded_by: null,
        discarded_at: null,
        send_claim: null,
        send_claimed_at: null,
        // #157 As colunas da cobrança que a migração deixa nulas.
        follow_up_draft: null,
        follow_up_rejection: null,
        follow_up_claimed_at: null,
        follow_up_claim: null,
        follow_up_sent_by: null,
        follow_up_sent_at: null,
        follow_up_channel: null,
        follow_up_provider_message_id: null,
        follow_up_failure: null,
        attachments: [],
        version: 1,
        history: [],
        created_at: now,
        updated_at: now,
      };
    }
    // #157 A caixa de entrada mock e as leituras: identidade por tabela e os defaults da migração.
    if (table === 'inbox_supplier_messages') {
      return { id: this.sequence(table), attachments_meta: [], received_at: now, read_status: 'pending', read_error: null, read_status_at: null, created_at: now };
    }
    if (table === 'supplier_reply_readings') return { id: this.sequence(table), message_id: null, supplier_document: null, injection_flag: null, read_at: now };
    if (table === 'issued_return_notes') return { id: this.sequence(table), created_at: now };
    if (table.startsWith('outbox_')) return { id: this.nextId++, published_at: now };
    if (table === 'invoices') return { captured_at: now, classification: null, checked_at: null };
    // #63 As colunas com default da migração do domínio e da aprovação.
    if (table === 'proposals') return { id: this.nextId++, state: 'registrada', regua_line: null, created_at: now };
    if (table === 'approvals') return { id: this.nextId++, dock_action: null, decided_on: null, approved_at: now };
    if (table === 'titles') return { state: 'lancado', updated_at: now };
    // #230 invoice_audits.id é identidade: o save() lê o id da linha devolvida.
    if (table === 'invoice_audits') return { id: this.nextId++ };
    // #130 dossier_requests.id é identidade: o open() lê o id da linha devolvida.
    if (table === 'dossier_requests') return { id: this.nextId++ };
    // #41 engine_decisions: a hora da decisão, o papel da linha e as tentativas têm default na migração.
    if (table === 'engine_decisions') {
      return { id: this.nextId++, role: 'cascade', decided_at: now, similar_cases: [], delegation_id: null, attempts: 1, last_attempt_at: now };
    }
    return {};
  }

  private sequence(table: string): number {
    const next = (this.sequences.get(table) ?? 0) + 1;
    this.sequences.set(table, next);
    return next;
  }

  private matches(row: Row, params: URLSearchParams): boolean {
    for (const [col, expr] of params) {
      if (['select', 'order', 'on_conflict', 'limit'].includes(col) || col.endsWith('.order')) continue;
      // #156 or=(a.is.null,b.lt.X): cada termo é `coluna.operador.valor`; o valor pode ter pontos.
      if (col === 'or') {
        const terms = /^\((.*)\)$/.exec(expr)?.[1]?.split(',') ?? [];
        if (!terms.some((term) => this.term(row, term))) return false;
        continue;
      }
      // #41 and=(col.lt."v"): o limite de cima de um período, quando a coluna já tem outro filtro.
      if (col === 'and') {
        const inner = /^\((.*)\)$/.exec(expr)?.[1] ?? '';
        for (const part of inner.split(',')) {
          const m = /^([a-z_]+)\.lt\."?([^"]*)"?$/.exec(part);
          if (!m) throw new Error(`fake: filtro and não suportado ${part}`);
          if (!(Date.parse(String(row[m[1] ?? ''])) < Date.parse(m[2] ?? ''))) return false;
        }
        continue;
      }
      if (!this.test(row, col, expr)) return false;
    }
    return true;
  }

  private term(row: Row, term: string): boolean {
    const [col = '', ...rest] = term.split('.');
    return this.test(row, col, rest.join('.'));
  }

  private test(row: Row, col: string, expr: string): boolean {
    // #71 e #157: in.(a,"b") do PostgREST, valores separados por vírgula, aspas opcionais.
    const inList = /^in\.\((.*)\)$/.exec(expr);
    if (inList) {
      const values = (inList[1] ?? '').split(',').map((v) => v.replace(/^"(.*)"$/, '$1'));
      return values.includes(String(row[col]));
    }
    // #56 not.is.null: o filtro que pega todas as linhas de uma coluna not null.
    if (expr === 'not.is.null') return row[col] !== null && row[col] !== undefined;
    // #156 is.null: a coluna sem valor.
    if (expr === 'is.null') return row[col] === null || row[col] === undefined;
    // #157 gt.: maior que, para ids numéricos (a mensagem mais nova); a coluna sem valor nunca é maior.
    if (expr.startsWith('gt.')) return typeof row[col] === 'number' && row[col] > Number(expr.slice(3));
    if (expr.startsWith('gte.')) return !(Date.parse(String(row[col])) < Date.parse(expr.slice(4)));
    // #156 lt.: menor que, em instantes (a coluna sem valor nunca é menor).
    if (expr.startsWith('lt.')) return row[col] !== null && row[col] !== undefined && Date.parse(String(row[col])) < Date.parse(expr.slice(3));
    if (!expr.startsWith('eq.')) throw new Error(`fake: filtro não suportado ${col}=${expr}`);
    return String(row[col]) === expr.slice(3);
  }
}
