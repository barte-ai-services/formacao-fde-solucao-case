/**
 * GET /api/doca (#72, #43 AC-4): a doca de um destino num dia, com a ação de cada nota.
 *
 * `destino` no formato `CD-03` ou `LJ-012`; omitido, abre no primeiro destino do dia. `data` em
 * AAAA-MM-DD; omitida, é hoje em America/Sao_Paulo. Parâmetro fora do formato responde 400 sem ecoar
 * o valor. Sem as credenciais do Supabase, 503; falha do Supabase, 502 sem detalhe.
 */
import { SupabaseRest, SupabaseRestError } from "../connectors/supabase-rest";
import { dockBoard } from "../dock/dock-board";
import { supabaseDockSource } from "../dock/dock-source";
import type { Env } from "../env";

export interface DockDeps {
  /** Monta o cliente do Supabase a partir do Env; nulo sem credenciais. Os testes injetam um fake. */
  supabase?: (env: Env) => SupabaseRest | null;
  /** Hoje, em AAAA-MM-DD. */
  today?: () => string;
}

const DESTINATION = /^[A-Z]{2}-\d{2,3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_ZONE = "America/Sao_Paulo";

export function supabaseFromEnv(env: Env): SupabaseRest | null {
  const url = env.BARTE_ACADEMY_SUPABASE_URL;
  const secretKey = env.BARTE_ACADEMY_SUPABASE_SECRET_KEY;
  if (!url || !secretKey) return null;
  return new SupabaseRest({ url, secretKey });
}

/** Hoje em America/Sao_Paulo, em AAAA-MM-DD (o en-CA formata assim). */
export function todayInSaoPaulo(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** AAAA-MM-DD de um dia que existe no calendário. */
function isCalendarDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Registra a falha do Supabase com a operação, a tabela e o status. O detalhe fica de fora, porque
 * traz o corpo da resposta; e nada disso sai para quem chamou.
 */
function logFailure(error: unknown): null {
  const summary =
    error instanceof SupabaseRestError
      ? { operation: error.operation, table: error.table, status: error.status }
      : { error: error instanceof Error ? error.name : "desconhecido" };
  console.error("doca: leitura do Supabase falhou", summary);
  return null;
}

const invalid = () => Response.json({ error: "invalid_query" }, { status: 400 });

export function dockHandler(deps: DockDeps = {}) {
  const supabase = deps.supabase ?? supabaseFromEnv;
  const today = deps.today ?? (() => todayInSaoPaulo());

  return async (request: Request, env: Env): Promise<Response> => {
    const params = new URL(request.url).searchParams;
    const date = params.get("data") ?? today();
    const requested = params.get("destino");
    if (!isCalendarDate(date)) return invalid();
    if (requested !== null && !DESTINATION.test(requested)) return invalid();

    const rest = supabase(env);
    if (!rest) return Response.json({ error: "supabase_not_configured" }, { status: 503 });

    const source = supabaseDockSource(rest);
    const loaded = await Promise.all([source.invoicesOn(date), source.published()]).catch(logFailure);
    if (!loaded) return Response.json({ error: "supabase_unavailable" }, { status: 502 });
    const [invoices, published] = loaded;
    return Response.json(dockBoard({ invoices, published, destination: requested, date }));
  };
}
