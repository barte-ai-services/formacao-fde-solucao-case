import { dispatchScheduled } from "./cron/schedule";
import type { Env } from "./env";
import { createAccessVerifier, fetchJwksOverNetwork } from "./http/access";
import { withCorrelationId } from "./http/correlation";
import { route, type RouterDeps } from "./http/router";
import { MemoryApprovalStore } from "./approval/store";
import { SupabaseApprovalStore } from "./approval/supabase-store";
import { SupabaseRest } from "./connectors/supabase-rest";
import { supabaseConnectors } from "./connectors/supabase-connectors";
import { loadDossierContext } from "./dossier/context";
import { SupabaseDossierSource } from "./dossier/source";
import { SupabaseDossierRequests } from "./dossier/requests";
import { credentialsFromEnv } from "./claude/client";
import { onDemandAskWithUsage } from "./dossier/on-demand";
import { restDb } from "./claude/db";
import { SupabaseTimelineSource } from "./automation/readers";
import { appStoreActionOutbox } from "./connectors/store-action";
import { erpReturnNoteOutbox } from "./connectors/erp-return-note";
import { wmsDockActionOutbox } from "./connectors/wms-dock-action";
import { SupabaseEngineStore } from "./engine/supabase-store";

export interface Worker {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void>;
}

/** Monta o Worker com as dependências dadas. Os testes injetam um verificador sem rede (#54). */
export function createWorker(deps: RouterDeps): Worker {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      // #293 O id de correlação envolve toda rota, e o Cron (scheduled) fica de fora.
      return withCorrelationId(request, () => route(request, env, deps, ctx));
    },
    async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
      // #311 O dossiê tem a própria invocação (o cron do dossiê), que espera cada disparo: nada fica para o waitUntil.
      await dispatchScheduled(controller, env);
    },
  } satisfies ExportedHandler<Env>;
}

// O verificador vive no escopo do módulo, então o cache das chaves do Access dura o isolate.
/** #63 A loja da aprovação nas tabelas do domínio; sem as credenciais do Supabase, vazia em memória. */
function approvalDeps(env: Env) {
  const url = env.BARTE_ACADEMY_SUPABASE_URL;
  const secretKey = env.BARTE_ACADEMY_SUPABASE_SECRET_KEY;
  if (!url || !secretKey) return { store: new MemoryApprovalStore() };
  const rest = new SupabaseRest({ url, secretKey });
  const { captureDeps } = supabaseConnectors(rest);
  return {
    store: new SupabaseApprovalStore(rest),
    // #43 AC-1: aprovar ou alterar publica a ação na doca para o WMS.
    dockOutbox: wmsDockActionOutbox(rest),
    // #135 A nota de loja vai para o app da loja.
    storeOutbox: appStoreActionOutbox(rest),
    // #156 A devolução da decisão vai para a fila das notas de devolução (#156); os recebimentos vêm do WMS.
    returnOutbox: erpReturnNoteOutbox(rest),
    receipts: () => captureDeps.wms.listReceipts(),
    // #68: o dossiê que o job do Claude gravou, conferido contra o contexto da nota.
    // #176 A unidade de estoque do receber parcial vem do fator de caixa do cadastro.
    products: () => captureDeps.registry.listProducts(),
    timeline: new SupabaseTimelineSource(rest, new SupabaseDossierSource(rest)),
    // #41 AC-4 A decisão do motor em modo sombra, ao lado da pessoa.
    engine: new SupabaseEngineStore(rest),
    dossier: {
      source: new SupabaseDossierSource(rest),
      context: (key: string) => loadDossierContext(captureDeps, key),
      // #130 O pedido da gaveta: os pedidos em dossier_requests e o Claude com a credencial do Worker (AC-7).
      requests: new SupabaseDossierRequests(rest),
      onDemand: onDemandClaude(env, rest),
    },
  };
}

/** #130 O banco e o Claude da geração sob demanda; sem credencial, sem Claude, e a geração fecha em erro. */
function onDemandClaude(env: Env, rest: SupabaseRest) {
  const credentials = credentialsFromEnv(env);
  const secret = credentials ? (credentials.kind === "api-key" ? credentials.apiKey : credentials.token) : "";
  return {
    db: restDb(rest),
    // #38 Com o uso de tokens; sem credencial, undefined explícito (o tipo exige a ligação).
    askWithUsage: credentials ? onDemandAskWithUsage(credentials) : undefined,
    secrets: [secret, env.BARTE_ACADEMY_SUPABASE_SECRET_KEY ?? ""],
  };
}

export default createWorker({
  verifier: createAccessVerifier(fetchJwksOverNetwork),
  approval: approvalDeps,
});
