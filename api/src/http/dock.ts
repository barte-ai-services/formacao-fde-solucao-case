/**
 * GET /api/doca (#72, #43 AC-4): a doca de um destino num dia, com a ação de cada nota.
 *
 * `destino` no formato `CD-03` ou `LJ-012`; omitido, abre no primeiro destino do dia. `data` em
 * AAAA-MM-DD; omitida, é hoje em America/Sao_Paulo. Parâmetro fora do formato responde 400 sem ecoar
 * o valor. Sem as credenciais do Supabase, 503; falha do Supabase, 502 sem detalhe.
 */
import { SupabaseRest, SupabaseRestError } from "../connectors/supabase-rest";
import { compareNumbers, dockBoard, type DockRow } from "../dock/dock-board";
import { supabaseDockSource } from "../dock/dock-source";
import { receivingPlace, type ReceivingPlace } from "../dock/receiving-place";
import type { Env } from "../env";
import { invalidCursor, pageOf, readPageQuery, sortedBy, type Key, type Ordering } from "./page";

export interface DockDeps {
  /** Monta o cliente do Supabase a partir do Env; nulo sem credenciais. Os testes injetam um fake (#72). */
  supabase?: (env: Env) => SupabaseRest | null;
  /** Hoje, em AAAA-MM-DD (#72). */
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

/** AAAA-MM-DD de um dia que existe no calendário (#72). */
function isCalendarDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Registra a falha do Supabase com a operação, a tabela e o status. O detalhe fica de fora, porque
 * traz o corpo da resposta; e nada disso sai para quem chamou (#72).
 */
function logFailure(error: unknown): null {
  const summary =
    error instanceof SupabaseRestError
      ? { operation: error.operation, table: error.table, status: error.status }
      : { error: error instanceof Error ? error.name : "desconhecido" };
  console.error("doca: leitura do Supabase falhou", summary);
  return null;
}

/** #159 A ordem da doca: o número da nota, como número, e a chave de acesso para desempatar. */
const dockOrder = (list: "doca" | "recebimento-loja"): Ordering<DockRow> => ({
  list,
  shape: ["string", "string"],
  key: (row) => [row.number, row.invoiceAccessKey],
  compare: (a: Key, b: Key) => compareNumbers(String(a[0]), String(b[0])) || (a[1] === b[1] ? 0 : (a[1] as string) < (b[1] as string) ? -1 : 1),
});

const invalid = () => Response.json({ error: "invalid_query" }, { status: 400 });

/**
 * #135 O mesmo handler serve a doca do CD (`destino`, `/api/doca`) e o recebimento na loja (`loja`,
 * `/api/recebimento-loja`). Cada um recusa, com 400, o destino do outro lugar.
 */
export function dockHandler(deps: DockDeps = {}, place: ReceivingPlace = "doca_cd"): (request: Request, env: Env) => Promise<Response> {
  const supabase = deps.supabase ?? supabaseFromEnv;
  const today = deps.today ?? (() => todayInSaoPaulo());
  // #159 São duas listas: o cursor de uma não serve na outra.
  const order = dockOrder(place === "app_loja" ? "recebimento-loja" : "doca");

  return async (request: Request, env: Env): Promise<Response> => {
    const params = new URL(request.url).searchParams;
    const query = readPageQuery(params);
    if (query.kind === "invalid") return query.response;
    const date = params.get("data") ?? today();
    const requested = params.get(place === "app_loja" ? "loja" : "destino");
    if (!isCalendarDate(date)) return invalid();
    if (requested !== null && (!DESTINATION.test(requested) || receivingPlace(requested) !== place)) return invalid();

    const rest = supabase(env);
    if (!rest) return Response.json({ error: "supabase_not_configured" }, { status: 503 });

    const source = supabaseDockSource(rest);
    const loaded = await Promise.all([source.invoicesOn(date), place === "app_loja" ? source.publishedToStores() : source.published()]).catch(logFailure);
    if (!loaded) return Response.json({ error: "supabase_unavailable" }, { status: 502 });
    const [invoices, published] = loaded;
    // #211 Quem decidiu: um erro aqui não derruba a doca; as linhas vão sem decidedBy.
    // Só as notas do destino que a tela mostra: o `in.(...)` cresce com cada chave.
    const inPlace = invoices.filter((i) => i.issuedOn === date && receivingPlace(i.store) === place);
    const shown = requested ?? [...new Set(inPlace.map((i) => i.store))].sort()[0];
    const decisions = await source.decisions(inPlace.filter((i) => i.store === shown).map((i) => i.accessKey)).catch(logFailure);
    const board = dockBoard({ invoices, published, destination: requested, date, place, decisions: decisions ?? undefined });
    if (query.kind === "whole") return Response.json(board);
    const page = pageOf(order, sortedBy(board.rows, order), query);
    if (!page) return invalidCursor();
    const { destination, date: boardDate, destinations, awaiting } = board;
    return Response.json({ destination, date: boardDate, destinations, ...page, aggregates: { awaiting } });
  };
}
