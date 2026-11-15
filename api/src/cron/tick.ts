import { listDescriptionSuggestions, storedDescriptionSuggester } from "../connectors/claude-suggestions";
import { blockDuplicateTitles } from "../connectors/duplicate-settler";
import { supabaseConnectors } from "../connectors/supabase-connectors";
import { SupabaseRest, SupabaseRestError } from "../connectors/supabase-rest";
import type { RegistryCorrectionOutbox } from "../connectors/ports";
import type { DescriptionSuggester } from "../domain/description-match";
import type { Env } from "../env";
import { captureInvoices } from "./capture";
import { findUnreconciledReceipts } from "./unreconciled-receipts";
import { proposeChecked } from "../approval/propose-checked";
import { SupabaseApprovalStore } from "../approval/supabase-store";
import { publishDecidedDockActions } from "../dock/publish-decided";
import { lastDaysUtc, publishApprovedUnregistered } from "./publish-approved-e8";

/** #66 A janela, em dias, das decisões que o Cron manda ao Cadastro; ver `lastDaysUtc`. */
const PUBLISH_WINDOW_DAYS = 7;

/** Execução agendada: captura e confere as notas (#59). Registra uma linha, sem dado sensível. */
export async function tick(controller: Pick<ScheduledController, "cron">, env: Env): Promise<void> {
  const url = env.BARTE_ACADEMY_SUPABASE_URL;
  const secretKey = env.BARTE_ACADEMY_SUPABASE_SECRET_KEY;
  if (!url || !secretKey) {
    console.log(`cron: execução agendada (${controller.cron}); sem credenciais do Supabase, captura pulada`);
    return;
  }
  const rest = new SupabaseRest({ url, secretKey });
  const { captureDeps, registryCorrections } = supabaseConnectors(rest);
  const descriptions = await storedSuggestions(rest);
  const result = await captureInvoices(descriptions ? { ...captureDeps, descriptions } : captureDeps);
  const unreconciled = await findUnreconciledReceipts(captureDeps);
  // #63 Depois de conferir, propõe e encaminha pela régua; o match vai sozinho para a lista do dia.
  const proposals = await proposeChecked({
    rest,
    purchasing: captureDeps.purchasing,
    registry: captureDeps.registry,
    wms: captureDeps.wms,
  });
  const cadastroE8 = await publishApproved(rest, registryCorrections);
  // #43 AC-1 O que a regra aprovou agora (e o que falhou na hora da aprovação) vai para a doca.
  const dock = await publishDock(rest);
  const duplicates = await blockDuplicateTitles(rest); // #31/AC-5: o título da E6 fica bloqueado já na detecção.
  console.log(
    `cron: execução agendada (${controller.cron}); notas vistas ${result.seen}, novas ${result.inserted}, conferidas ${result.checked}, com erro ${result.failed}, propostas ${proposals.proposed}, aprovadas pela regra ${proposals.approvedByRule}, cadastro E8 ${cadastroE8}, ações publicadas na doca ${dock}, títulos duplicados bloqueados ${duplicates.blocked}, com falha ${duplicates.failed}; recebimentos sem nota [${unreconciled.noKey.join(", ")}], com chave sem nota [${unreconciled.keyWithoutInvoice.join(", ")}]`,
  );
}

/**
 * #66 As sugestões de casamento por descrição que o job claude-enrich gravou. Se a leitura falha,
 * registra uma linha (só o status, sem dado sensível) e a regra decide sozinha.
 */
async function storedSuggestions(rest: SupabaseRest): Promise<DescriptionSuggester | undefined> {
  try {
    return storedDescriptionSuggester(await listDescriptionSuggestions(rest));
  } catch (error) {
    const status = error instanceof SupabaseRestError ? `HTTP ${error.status}` : "falha na leitura";
    console.log(`cron: sugestões do Claude indisponíveis (${status}); a regra decide sozinha`);
    return undefined;
  }
}

/**
 * #35 (plano #66, AC-5) Manda ao Cadastro o E8 das propostas decididas os últimos 7 dias (UTC). Se falha, registra
 * uma linha sem dado sensível e a rodada segue: a caixa de saída é idempotente e a próxima rodada repete.
 */
async function publishApproved(
  rest: SupabaseRest,
  outbox: RegistryCorrectionOutbox,
): Promise<number> {
  try {
    const days = lastDaysUtc(new Date(), PUBLISH_WINDOW_DAYS);
    const { published } = await publishApprovedUnregistered({ store: new SupabaseApprovalStore(rest), outbox, days });
    return published;
  } catch (error) {
    const status = error instanceof SupabaseRestError ? `HTTP ${error.status}` : "falha na publicação";
    console.log(`cron: cadastro E8 indisponível (${status}); a próxima rodada repete`);
    return 0;
  }
}

/**
 * #43 AC-1 Publica na caixa de saída do WMS a ação das propostas decididas que ainda não chegou à doca.
 * Se falha, registra uma linha sem dado sensível e a rodada segue: a varredura é idempotente e a
 * próxima rodada repete.
 */
async function publishDock(rest: SupabaseRest): Promise<number> {
  try {
    return (await publishDecidedDockActions(rest)).published;
  } catch (error) {
    const status = error instanceof SupabaseRestError ? `HTTP ${error.status}` : "falha na publicação";
    console.log(`cron: doca indisponível (${status}); a próxima rodada repete`);
    return 0;
  }
}
