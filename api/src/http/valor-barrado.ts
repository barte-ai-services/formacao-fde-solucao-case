import { SupabaseRest, SupabaseRestError } from "../connectors/supabase-rest";
import type { Env } from "../env";
import { currentMonth, parseMonth, summarizeBarredAmount } from "../panel/barred-amount";
import { readProposalRecords } from "../panel/proposals-reader";
import type { Identity } from "./access";

/**
 * GET /api/valor-barrado?mes=AAAA-MM (#71, história #39): o valor barrado no mês, por exceção,
 * contra a linha de base de R$ 543 mil. Sem `mes`, o mês corrente em Brasília.
 */
export async function valorBarrado(_identity: Identity, request: Request, env: Env): Promise<Response> {
  const param = new URL(request.url).searchParams.get("mes");
  const month = param === null ? currentMonth(new Date()) : parseMonth(param);
  if (!month) return Response.json({ error: "mes_invalido" }, { status: 400 });

  const url = env.BARTE_ACADEMY_SUPABASE_URL;
  const secretKey = env.BARTE_ACADEMY_SUPABASE_SECRET_KEY;
  if (!url || !secretKey) return Response.json({ error: "supabase_nao_configurado" }, { status: 503 });

  let records;
  try {
    records = await readProposalRecords(new SupabaseRest({ url, secretKey }));
  } catch (error) {
    if (!(error instanceof SupabaseRestError)) throw error;
    // A mensagem do SupabaseRestError diz operação, tabela e status; nunca a chave.
    console.error(`valor-barrado: ${error.message}`);
    return Response.json({ error: "supabase_indisponivel" }, { status: 502 });
  }

  const { panel, ignoredMatchProposalIds } = summarizeBarredAmount(records, month);
  if (ignoredMatchProposalIds.length > 0) {
    console.warn(
      `valor-barrado: ${ignoredMatchProposalIds.length} proposta(s) MATCH com ação que barra, fora da soma: ${ignoredMatchProposalIds.join(", ")}`,
    );
  }
  return Response.json(panel);
}
