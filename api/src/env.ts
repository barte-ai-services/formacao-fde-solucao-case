/** Bindings e segredos que o Worker recebe. Os valores nunca ficam no git. */
export interface Env {
  /** Chave secreta do Supabase. Em produção via `wrangler secret put`; local, no `.dev.vars`. */
  BARTE_ACADEMY_SUPABASE_SECRET_KEY?: string;
}
