/**
 * Cliente do Claude no Worker (#171), pela Messages API, com fetch puro.
 *
 * A autenticação é plugável e a escolha é do ambiente, não do código que chama:
 * - com `BARTE_ACADEMY_ANTHROPIC_API_KEY` (credencial principal), usa a chave da API no cabeçalho
 *   `x-api-key`, mesmo que o setup token também esteja definido;
 * - sem ela, com `BARTE_ACADEMY_CLAUDE_CODE_OAUTH_TOKEN` (caminho secundário), usa o setup token do Claude
 *   Code em `Authorization: Bearer` com `anthropic-beta: oauth-2025-04-20`. É uso da assinatura fora do
 *   Claude Code: a Anthropic pode limitar ou bloquear (#171).
 * Diante de um 429: com `retry-after`, é limite passageiro; sem `retry-after` no setup token, é a credencial
 * bloqueada, e a saída é pôr a chave da API. O log do Cron diferencia os dois.
 * Trocar de via muda só `credentialsFromEnv`. O resto do Worker recebe um `Ask` e não sabe qual é.
 *
 * Nenhum segredo entra em erro ou log: a mensagem do `ClaudeError` diz só o tipo e o status HTTP,
 * nunca o cabeçalho, o corpo da resposta nem o texto do modelo.
 */
import { isRecord } from './guards.js';

/** #171 Prazo de cada pergunta, do primeiro pedido à resposta final, tool use incluído. */
export const ASK_TIMEOUT_MS = 45_000;

/** #171 Modelo padrão das tarefas: rápido e barato, a regra determinística confirma depois. */
export const DEFAULT_MODEL = 'claude-haiku-5-5';

/** #171 Voltas do laço de tool use antes de desistir. */
export const MAX_TURNS = 6;

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const OAUTH_BETA = 'oauth-2025-04-20';
/** #171 O setup token só vale na Messages API com este começo de system, como no próprio Claude Code. */
const OAUTH_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";
const ANSWER_TOOL = 'responder';
const MAX_TOKENS = 1024;

export type JsonSchema = Record<string, unknown>;

export type AskOptions = {
  readonly system: string;
  readonly prompt: string;
  readonly schema: JsonSchema;
  readonly model?: string;
};

/** #171 A pergunta ao Claude, injetável: as tarefas recebem um Ask e os testes passam um falso. */
export type Ask = <T>(options: AskOptions) => Promise<T>;

/** #38 Tokens gastos numa chamada, somados de todas as respostas da Messages API (o laço pode ter várias voltas). */
export type Usage = { readonly input_tokens: number; readonly output_tokens: number };

/** #38 A resposta com o uso. `usage` é nulo quando nenhuma resposta trouxe o campo. */
export type Answered<T> = { readonly value: T; readonly usage: Usage | null };

/** #38 A variante do Ask que devolve também o uso, para o dossiê gravar em claude_suggestions.usage. */
export type AskWithUsage = <T>(options: AskOptions) => Promise<Answered<T>>;

/** #171 Uma tool do laço: a descrição e o schema vão ao modelo; o handler roda no Worker. */
export type Tool = {
  readonly name: string;
  readonly description: string;
  readonly input_schema: JsonSchema;
  readonly handler: (input: unknown) => Promise<unknown>;
};

export type ConverseOptions = AskOptions & {
  readonly tools?: readonly Tool[];
  readonly maxTurns?: number;
  /**
   * #333 Opcional: chamado no começo de cada volta (a partir de 1). Devolve os nomes das tools a oferecer nesta
   * volta, ou undefined para oferecer todas; a `responder` fica sempre. Sem ele, nada muda para as outras tarefas.
   * #335/AC-1 O que a lista tira não roda: a tool pedida fora dela volta is_error (runTools). E com uma só tool da tarefa na lista o
   * tool_choice força essa tool; com a lista vazia, força a `responder`; sem lista, segue `any`.
   */
  readonly beforeTurn?: (turn: number) => readonly string[] | undefined;
};

/** #230 O laço de tool use, injetável como o Ask: a tarefa que usa tools recebe um Converse e os testes passam um falso. */
export type Converse = (options: ConverseOptions) => Promise<unknown>;

export type ClaudeCredentials =
  | { readonly kind: 'api-key'; readonly apiKey: string }
  | { readonly kind: 'oauth'; readonly token: string };

/** #171 O que a falha foi, para o laço da rodada decidir: limite e autenticação valem para a rodada toda. */
export type ClaudeErrorKind = 'rate_limit' | 'auth' | 'api' | 'network' | 'timeout' | 'format';

/** #171 Falha da chamada ao Claude. A mensagem diz o tipo e o status, nunca segredo nem texto do modelo. */
export class ClaudeError extends Error {
  /** #38 O uso já gasto quando a falha veio depois de alguma resposta; nulo se nenhuma resposta chegou. */
  usage: Usage | null = null;

  constructor(
    readonly kind: ClaudeErrorKind,
    detail: string,
    readonly status = 0,
  ) {
    super(`claude: ${detail}`);
    this.name = 'ClaudeError';
  }

  /** #171 Limite ou credencial recusada: tentar o próximo item da rodada só repetiria a falha. */
  get isGlobal(): boolean {
    return this.kind === 'rate_limit' || this.kind === 'auth';
  }
}

export type ClaudeEnv = {
  readonly BARTE_ACADEMY_ANTHROPIC_API_KEY?: string;
  readonly BARTE_ACADEMY_CLAUDE_CODE_OAUTH_TOKEN?: string;
  /** #171 Não é do cliente: só entra na lista de redação da rodada, como no executor antigo. */
  readonly BARTE_ACADEMY_SUPABASE_SECRET_KEY?: string;
};

/** #171 A chave da API é a credencial principal e tem prioridade; o setup token é o caminho secundário. Sem nenhuma das duas, undefined: o Cron pula e a regra decide. */
export function credentialsFromEnv(env: ClaudeEnv): ClaudeCredentials | undefined {
  const apiKey = env.BARTE_ACADEMY_ANTHROPIC_API_KEY?.trim();
  if (apiKey) return { kind: 'api-key', apiKey };
  const token = env.BARTE_ACADEMY_CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (token) return { kind: 'oauth', token };
  return undefined;
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export type ClaudeClientConfig = {
  readonly credentials: ClaudeCredentials;
  readonly fetch?: FetchFn;
  readonly timeoutMs?: number;
  readonly url?: string;
};

type Block = Record<string, unknown>;
type Message = { readonly role: 'user' | 'assistant'; readonly content: string | Block[] };

/** #38 O uso que o erro carrega: o do ClaudeError que veio depois de alguma resposta; qualquer outro, nulo. */
export function spentUsage(error: unknown): Usage | null {
  return error instanceof ClaudeError ? error.usage : null;
}

/** #38 O campo `usage` de uma resposta, se vier com os dois números. */
function readUsage(parsed: Record<string, unknown>): Usage | null {
  const u = parsed.usage;
  if (!isRecord(u) || typeof u.input_tokens !== 'number' || typeof u.output_tokens !== 'number') return null;
  return { input_tokens: u.input_tokens, output_tokens: u.output_tokens };
}

function addUsage(total: Usage | null, more: Usage | null): Usage | null {
  if (!more) return total;
  if (!total) return more;
  return { input_tokens: total.input_tokens + more.input_tokens, output_tokens: total.output_tokens + more.output_tokens };
}

/**
 * #282 O 429 do setup token sem `retry-after` não é limite passageiro: é a credencial barrada, e esperar
 * não resolve. Segue `rate_limit` (e global, a rodada para), com a mensagem própria para o log do Cron.
 * Só o cabeçalho e o tipo da credencial entram na decisão; nada do corpo nem da credencial vai à mensagem.
 */
function classify(response: Response, credentials: ClaudeCredentials): ClaudeError {
  const { status } = response;
  if (status === 429) {
    const blocked = credentials.kind === 'oauth' && response.headers.get('retry-after') === null;
    const detail = blocked
      ? 'HTTP 429 (credencial bloqueada: setup token sem retry-after; use a chave da API)'
      : 'HTTP 429 (limite de uso)';
    return new ClaudeError('rate_limit', detail, status);
  }
  if (status === 401 || status === 403) return new ClaudeError('auth', `HTTP ${status} (credencial recusada)`, status);
  return new ClaudeError('api', `HTTP ${status}`, status);
}

export class ClaudeClient {
  /** #171 Quantas chamadas falharam desde que o cliente nasceu; o Cron registra no log. */
  failures = 0;
  /** #171 Quantas chamadas à API foram feitas, com sucesso ou não. */
  calls = 0;
  private readonly credentials: ClaudeCredentials;
  private readonly doFetch: FetchFn;
  private readonly timeoutMs: number;
  private readonly url: string;

  constructor(config: ClaudeClientConfig) {
    this.credentials = config.credentials;
    this.doFetch = config.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = config.timeoutMs ?? ASK_TIMEOUT_MS;
    this.url = config.url ?? MESSAGES_URL;
  }

  /** #171 O `Ask` das tarefas: pergunta com saída estruturada e sem tools. */
  readonly ask: Ask = async <T>(options: AskOptions): Promise<T> => (await this.askWithUsage<T>(options)).value;

  /** #38 O mesmo pedido do `ask`, devolvendo também o uso de tokens; quem usa é o dossiê (evento e sob demanda). */
  readonly askWithUsage: AskWithUsage = <T>(options: AskOptions): Promise<Answered<T>> =>
    this.converseWithUsage(options) as Promise<Answered<T>>;

  /** #171 O laço de tool use, devolvendo só o valor; ver `converseWithUsage`. */
  async converse(options: ConverseOptions): Promise<unknown> {
    return (await this.converseWithUsage(options)).value;
  }

  /**
   * #171 O laço de tool use. A saída estruturada é a própria tool `responder`, com o schema da tarefa:
   * o modelo a chama para terminar. Enquanto chamar outras tools, o handler roda e o resultado volta
   * ao modelo; passar de `maxTurns` ou terminar sem `responder` é falha. O prazo vale para o laço todo.
   * #38 Soma o `usage` de cada resposta. Na falha, o ClaudeError leva o uso já gasto (nulo se nada chegou).
   */
  async converseWithUsage(options: ConverseOptions): Promise<Answered<unknown>> {
    let usage: Usage | null = null;
    const record = (more: Usage | null) => {
      usage = addUsage(usage, more);
    };
    const tools = options.tools ?? [];
    const maxTurns = options.maxTurns ?? (tools.length === 0 ? 1 : MAX_TURNS);
    const signal = AbortSignal.timeout(this.timeoutMs);
    const answerDef = { name: ANSWER_TOOL, description: 'Entrega a resposta final no formato pedido.', input_schema: options.schema };
    const toolDefs = (offer: readonly string[] | undefined) => [
      ...tools.filter((t) => offer === undefined || offer.includes(t.name)).map(({ name, description, input_schema }) => ({ name, description, input_schema })),
      answerDef,
    ];
    // #335/AC-1 Sem tools, ou com a volta reduzida a uma tool (ou a nenhuma), o modelo não escolhe: a API honra a tool forçada, e `any` deixava o modelo repetir a leitura que a lista tirou.
    const toolChoiceFor = (offer: readonly string[] | undefined) => {
      if (tools.length === 0) return { type: 'tool', name: ANSWER_TOOL };
      const offered = offer === undefined ? undefined : tools.filter((t) => offer.includes(t.name));
      if (offered === undefined || offered.length > 1) return { type: 'any' };
      return { type: 'tool', name: offered[0]?.name ?? ANSWER_TOOL };
    };
    const messages: Message[] = [{ role: 'user', content: options.prompt }];
    try {
      for (let turn = 0; turn < maxTurns; turn += 1) {
        const offer = options.beforeTurn?.(turn + 1);
        const content = await this.post(
          { model: options.model ?? DEFAULT_MODEL, max_tokens: MAX_TOKENS, system: this.system(options.system), tools: toolDefs(offer), tool_choice: toolChoiceFor(offer), messages },
          signal,
          record,
        );
        const uses = content.filter((b) => b.type === 'tool_use');
        const answer = uses.find((b) => b.name === ANSWER_TOOL);
        if (answer) return { value: answer.input, usage };
        if (uses.length === 0) throw new ClaudeError('format', 'resposta sem tool_use');
        messages.push({ role: 'assistant', content });
        messages.push({ role: 'user', content: await this.runTools(uses, offer === undefined ? tools : tools.filter((t) => offer.includes(t.name))) });
      }
      throw new ClaudeError('format', `sem resposta final em ${maxTurns} voltas`);
    } catch (error) {
      this.failures += 1;
      // #171 O erro original pode trazer URL ou cabeçalhos; fica só o tipo da falha.
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      const failure =
        error instanceof ClaudeError
          ? error
          : timedOut
            ? new ClaudeError('timeout', `sem resposta em ${this.timeoutMs / 1000} s`)
            : new ClaudeError('network', 'falha de rede');
      failure.usage = usage;
      throw failure;
    }
  }

  private system(text: string): Block[] {
    const blocks: Block[] = [{ type: 'text', text }];
    if (this.credentials.kind === 'oauth') blocks.unshift({ type: 'text', text: OAUTH_SYSTEM_PREFIX });
    return blocks;
  }

  private headers(): Record<string, string> {
    const base = { 'content-type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION };
    if (this.credentials.kind === 'api-key') return { ...base, 'x-api-key': this.credentials.apiKey };
    return { ...base, authorization: `Bearer ${this.credentials.token}`, 'anthropic-beta': OAUTH_BETA };
  }

  private async post(body: unknown, signal: AbortSignal, record: (usage: Usage | null) => void): Promise<Block[]> {
    this.calls += 1;
    const response = await this.doFetch(this.url, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal });
    if (!response.ok) throw classify(response, this.credentials);
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new ClaudeError('format', 'a resposta não é JSON', response.status);
    }
    if (isRecord(parsed)) record(readUsage(parsed)); // #38 conta antes de validar: a resposta já foi cobrada.
    if (!isRecord(parsed) || !Array.isArray(parsed.content)) throw new ClaudeError('format', 'resposta sem content', response.status);
    return parsed.content.filter(isRecord);
  }

  /**
   * #171 Roda cada tool pedida. A falha do handler volta ao modelo como erro genérico, sem o texto dela.
   * #335/AC-1 `tools` são só as oferecidas na volta (converseWithUsage): a pedida fora delas não roda e volta is_error com os nomes das oferecidas (constantes da tarefa).
   */
  private async runTools(uses: readonly Block[], tools: readonly Tool[]): Promise<Block[]> {
    const results: Block[] = [];
    for (const use of uses) {
      const tool = tools.find((t) => t.name === use.name);
      let result: Block;
      if (!tool) {
        const offered = [...tools.map((t) => t.name), ANSWER_TOOL].join(', ');
        result = { type: 'tool_result', tool_use_id: use.id, content: `tool não oferecida nesta volta; chame: ${offered}`, is_error: true };
      } else {
        try {
          result = { type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(await tool.handler(use.input)) };
        } catch {
          result = { type: 'tool_result', tool_use_id: use.id, content: 'falha ao executar a tool', is_error: true };
        }
      }
      results.push(result);
    }
    return results;
  }
}
