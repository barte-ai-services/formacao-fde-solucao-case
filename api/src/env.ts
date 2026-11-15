/** #59 Bindings e segredos que o Worker recebe. Os valores nunca ficam no git. */
export interface Env {
  /** #59 URL do projeto Supabase. Var do Worker (não é segredo); local, no `.dev.vars`. */
  BARTE_ACADEMY_SUPABASE_URL?: string;
  /** #59 Chave secreta do Supabase. Em produção via `wrangler secret put`; local, no `.dev.vars`. */
  BARTE_ACADEMY_SUPABASE_SECRET_KEY?: string;
}
