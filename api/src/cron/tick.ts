import { supabaseConnectors } from "../connectors/supabase-connectors";
import { SupabaseRest } from "../connectors/supabase-rest";
import type { Env } from "../env";
import { captureInvoices } from "./capture";

/** Execução agendada: captura e confere as notas (#59). Registra uma linha, sem dado sensível. */
export async function tick(controller: Pick<ScheduledController, "cron">, env: Env): Promise<void> {
  const url = env.BARTE_ACADEMY_SUPABASE_URL;
  const secretKey = env.BARTE_ACADEMY_SUPABASE_SECRET_KEY;
  if (!url || !secretKey) {
    console.log(`cron: execução agendada (${controller.cron}); sem credenciais do Supabase, captura pulada`);
    return;
  }
  const { captureDeps } = supabaseConnectors(new SupabaseRest({ url, secretKey }));
  const result = await captureInvoices(captureDeps);
  console.log(
    `cron: execução agendada (${controller.cron}); notas vistas ${result.seen}, novas ${result.inserted}, conferidas ${result.checked}`,
  );
}
