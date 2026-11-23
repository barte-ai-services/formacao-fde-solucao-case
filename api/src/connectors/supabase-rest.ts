// Cliente mínimo do PostgREST do Supabase, com fetch puro (#59, AC-1). Nunca registra a chave.

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export type SupabaseRestConfig = {
  readonly url: string;
  readonly secretKey: string;
  readonly fetch?: FetchFn;
  /** #59 Linhas por página no select. */
  readonly pageSize?: number;
  /** #59 REL-1: tempo máximo de cada requisição, em milissegundos. */
  readonly timeoutMs?: number;
  /**
   * #362 Guarda a leitura por cliente (o da rodada): a mesma leitura (tabela, colunas, ordem, filtros) feita de novo devolve o que a
   * primeira trouxe, sem outra requisição. É a foto da rodada: a trava deixa uma rodada só escrever, e o que uma pessoa grava no meio
   * chega na rodada seguinte. Toda escrita da tabela por este cliente (e qualquer `rpc`) esquece o que se guardou dela ao terminar, com
   * sucesso ou erro, então um passo nunca deixa de ver o que a própria rodada gravou. A rodada não lê e escreve a mesma tabela em
   * paralelo (os passos correm em sequência); se um dia correr, a leitura que começou com a escrita em voo também é esquecida no fim.
   */
  readonly memoizeReads?: boolean;
};

export type Row = Record<string, unknown>;

/** #59 Filtros no formato do PostgREST: { chave: 'eq.X' }. */
export type Filters = Readonly<Record<string, string>>;

export type SelectOptions = {
  readonly select?: string;
  readonly order?: string;
  readonly filters?: Filters;
  /** #211 Só as primeiras N linhas (uma requisição, sem paginar). */
  readonly limit?: number;
};

export type InsertOptions = {
  /** #59 Colunas da restrição única que decide a duplicada. */
  readonly onConflict?: string;
  /** #59 true: a duplicada é ignorada (resolution=ignore-duplicates). */
  readonly ignoreDuplicates?: boolean;
};

export type RestOperation = 'select' | 'insert' | 'upsert' | 'update' | 'delete' | 'rpc' | 'network' | 'parse';

/** #59 Falha do PostgREST. A mensagem diz a operação, a tabela e o status; nunca a chave nem os dados. */
export class SupabaseRestError extends Error {
  constructor(
    readonly operation: RestOperation,
    readonly table: string,
    readonly status: number,
    readonly detail: string,
    /** #230 O `code` do PostgREST (SQLSTATE, ex.: 23505), só quando o corpo da falha o traz como texto curto. */
    readonly code?: string,
  ) {
    super(`supabase-rest: ${operation} em ${table} falhou (HTTP ${status}) ${detail}`.trim());
    this.name = 'SupabaseRestError';
  }
}

/** #230 O `code` do corpo de erro do PostgREST (cinco caracteres do SQLSTATE ou PGRST…), ou undefined. */
function postgrestCode(text: string): string | undefined {
  try {
    const body: unknown = JSON.parse(text);
    const code = typeof body === 'object' && body !== null && 'code' in body ? body.code : undefined;
    return typeof code === 'string' && /^[A-Za-z0-9]{5,8}$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * #42 O código do Postgres (SQLSTATE, ex.: `23505`) e a mensagem que o PostgREST devolve no corpo do erro. O corpo
 * vem cortado em `detail`; o código e a mensagem são lidos à parte, sem depender do JSON inteiro. Nulo quando o
 * erro não veio do banco.
 */
export function postgresErrorOf(error: unknown): { readonly code: string; readonly message: string } | null {
  if (!(error instanceof SupabaseRestError)) return null;
  const code = /"code"\s*:\s*"([0-9A-Z]{5})"/.exec(error.detail)?.[1];
  if (!code) return null;
  const message = /"message"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(error.detail)?.[1] ?? '';
  return { code, message };
}

/** #356 Os códigos de um objeto que o banco ainda não tem: tabela (PGRST205, 42P01), função (PGRST202), coluna (PGRST204, 42703). */
const MISSING_SCHEMA_CODES: ReadonlySet<string> = new Set(['PGRST202', 'PGRST204', 'PGRST205', '42703', '42P01']);

/**
 * #356 A falha é "o objeto não existe": a migração que o cria ainda não foi aplicada (o deploy do Worker e o do Supabase correm em
 * paralelo). Quem lê um objeto novo trata isto como o estado de antes da migração; qualquer outra falha sobe.
 */
export function isMissingSchema(error: unknown): boolean {
  return error instanceof SupabaseRestError && error.code !== undefined && MISSING_SCHEMA_CODES.has(error.code);
}

const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_DETAIL = 300;

export class SupabaseRest {
  private readonly base: string;
  private readonly secretKey: string;
  private readonly doFetch: FetchFn;
  private readonly pageSize: number;
  private readonly timeoutMs: number;
  private readonly memoizes: boolean;
  /** #362 A leitura em curso ou pronta de cada (tabela, opções); a promessa é guardada, então duas leituras juntas fazem uma requisição. */
  private readonly memo = new Map<string, Promise<unknown[]>>();

  constructor(config: SupabaseRestConfig) {
    this.base = config.url.replace(/\/+$/, '') + '/rest/v1/';
    this.secretKey = config.secretKey;
    this.doFetch = config.fetch ?? ((input, init) => fetch(input, init));
    this.pageSize = config.pageSize ?? DEFAULT_PAGE_SIZE;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.memoizes = config.memoizeReads ?? false;
  }

  /** #59 Lê a tabela inteira, paginando pelo cabeçalho Range. As linhas saem sem tipo: quem lê valida. */
  async select(table: string, options: SelectOptions = {}): Promise<unknown[]> {
    if (!this.memoizes) return this.selectNow(table, options);
    const key = `${table}\u0000${JSON.stringify(options)}`;
    let pending = this.memo.get(key);
    if (!pending) {
      pending = this.selectNow(table, options);
      this.memo.set(key, pending);
      // #362 A leitura que falhou não fica guardada: a chamada seguinte tenta de novo.
      void pending.catch(() => this.memo.delete(key));
    }
    return [...(await pending)];
  }

  /** #362 Esquece tudo o que se guardou: a próxima leitura vai ao banco (o teste mede o custo de um passo sozinho, sem o que o passo de antes já leu). */
  resetReads(): void {
    this.forget(null);
  }

  /** #362 O que uma escrita muda deixa de valer: esquece o que se guardou da tabela (o `rpc` não diz qual, esquece tudo). */
  private forget(table: string | null): void {
    for (const key of [...this.memo.keys()]) if (table === null || key.startsWith(`${table}\u0000`)) this.memo.delete(key);
  }

  /** #362 Faz a escrita e esquece a leitura guardada DEPOIS dela, também quando falha: a leitura que começou com a escrita em voo não fica. */
  private async forgetAfter<T>(table: string | null, write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } finally {
      this.forget(table);
    }
  }

  private async selectNow(table: string, options: SelectOptions): Promise<unknown[]> {
    const params = new URLSearchParams({ select: options.select ?? '*' });
    if (options.order) params.set('order', options.order);
    for (const [column, expr] of Object.entries(options.filters ?? {})) params.append(column, expr);
    if (options.limit !== undefined) {
      params.set('limit', String(options.limit));
      return this.request('select', table, 'GET', params, undefined, {});
    }
    const rows: unknown[] = [];
    for (let start = 0; ; start += this.pageSize) {
      const page = await this.request('select', table, 'GET', params, undefined, {
        'Range-Unit': 'items',
        Range: `${start}-${start + this.pageSize - 1}`,
      });
      rows.push(...page);
      if (page.length < this.pageSize) return rows;
    }
  }

  /**
   * #59 Insere e devolve só as linhas que entraram de fato. Com ignoreDuplicates (o padrão), a linha
   * que bate na restrição de onConflict é ignorada sem erro.
   */
  async insert(table: string, rows: readonly Row[], options: InsertOptions = {}): Promise<unknown[]> {
    if (rows.length === 0) return [];
    const params = new URLSearchParams();
    if (options.onConflict) params.set('on_conflict', options.onConflict);
    const prefer = ['return=representation'];
    if (options.ignoreDuplicates ?? true) prefer.push('resolution=ignore-duplicates');
    return this.forgetAfter(table, () => this.request('insert', table, 'POST', params, rows, { Prefer: prefer.join(',') }));
  }

  /** #59 Insere ou atualiza pela restrição de onConflict (resolution=merge-duplicates). */
  async upsert(table: string, rows: readonly Row[], onConflict: string): Promise<unknown[]> {
    if (rows.length === 0) return [];
    const params = new URLSearchParams({ on_conflict: onConflict });
    return this.forgetAfter(table, () =>
      this.request('upsert', table, 'POST', params, rows, { Prefer: 'return=representation,resolution=merge-duplicates' }),
    );
  }

  /** #59 Atualiza as linhas que passam nos filtros. Exige ao menos um filtro. */
  async update(table: string, filters: Filters, patch: Row): Promise<unknown[]> {
    const params = this.requireFilters('update', table, filters);
    return this.forgetAfter(table, () => this.request('update', table, 'PATCH', params, patch, { Prefer: 'return=representation' }));
  }

  /** #59 Apaga as linhas que passam nos filtros. Exige ao menos um filtro. */
  async delete(table: string, filters: Filters): Promise<void> {
    const params = this.requireFilters('delete', table, filters);
    await this.forgetAfter(table, () => this.request('delete', table, 'DELETE', params, undefined, { Prefer: 'return=minimal' }));
  }

  /**
   * #230 Chama uma função do banco (POST /rest/v1/rpc/<nome>): uma requisição, uma transação. Devolve o valor que a
   * função devolve (texto, número, null...), sem tipo: quem chama valida. Falha com o mesmo SupabaseRestError.
   */
  async rpc(fn: string, args: Row): Promise<unknown> {
    return this.forgetAfter(null, () => this.requestJson('rpc', `rpc/${fn}`, 'POST', new URLSearchParams(), args, {}));
  }

  private requireFilters(operation: RestOperation, table: string, filters: Filters): URLSearchParams {
    const entries = Object.entries(filters);
    if (entries.length === 0) {
      throw new SupabaseRestError(operation, table, 0, 'sem filtro: recusado para não atingir a tabela inteira');
    }
    return new URLSearchParams(entries);
  }

  private async request(
    operation: RestOperation,
    table: string,
    method: string,
    params: URLSearchParams,
    body: unknown,
    extra: Record<string, string>,
  ): Promise<unknown[]> {
    const parsed = await this.requestJson(operation, table, method, params, body, extra);
    if (parsed === undefined) return [];
    if (!Array.isArray(parsed)) {
      throw new SupabaseRestError('parse', table, 0, 'a resposta não é uma lista');
    }
    return parsed;
  }

  /** #230 A requisição e o JSON da resposta; undefined quando o corpo vem vazio. */
  private async requestJson(
    operation: RestOperation,
    table: string,
    method: string,
    params: URLSearchParams,
    body: unknown,
    extra: Record<string, string>,
  ): Promise<unknown> {
    const headers: Record<string, string> = { apikey: this.secretKey, 'Content-Type': 'application/json', ...extra };
    // #59 Chave nova (sb_...) vai só no apikey; a legada (JWT) também vai no Authorization.
    if (!this.secretKey.startsWith('sb_')) headers.Authorization = `Bearer ${this.secretKey}`;
    const query = params.toString();
    const url = `${this.base}${table}${query ? `?${query}` : ''}`;
    let response: Response;
    let text: string;
    try {
      response = await this.doFetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await response.text();
    } catch (error) {
      // #59 REL-1: o aborto por tempo e a falha de rede viram o mesmo tipo de erro, sem a chave.
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      const detail = timedOut ? `sem resposta em ${this.timeoutMs} ms` : 'falha de rede';
      throw new SupabaseRestError('network', table, 0, detail);
    }
    if (!response.ok) {
      throw new SupabaseRestError(operation, table, response.status, text.slice(0, MAX_DETAIL), postgrestCode(text));
    }
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw new SupabaseRestError('parse', table, response.status, 'a resposta não é JSON');
    }
  }
}
