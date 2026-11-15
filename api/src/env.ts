/** #59 Bindings e segredos que o Worker recebe. Os valores nunca ficam no git. */
export interface Env {
  /** #59 URL do projeto Supabase. Var do Worker (não é segredo); local, no `.dev.vars`. */
  BARTE_ACADEMY_SUPABASE_URL?: string;
  /** #59 Chave secreta do Supabase. Em produção via `wrangler secret put`; local, no `.dev.vars`. */
  BARTE_ACADEMY_SUPABASE_SECRET_KEY?: string;
  /**
   * Application Audience (AUD) da aplicação do Cloudflare Access (#54). Não é segredo: a esteira
   * passa com `wrangler deploy --var`, a partir da variável do repositório. Vazio: o Worker fecha.
   */
  ACCESS_AUD?: string;
  /**
   * Domínio do time do Zero Trust, como `barte-academy.cloudflareaccess.com` (#54). A esteira passa
   * com `wrangler deploy --var`. Aceita `https://` na frente e barra no fim. Vazio: o Worker fecha.
   */
  ACCESS_TEAM_DOMAIN?: string;
  /**
   * Os arquivos da tela (web/dist, #60), servidos depois do Access. Ausente nos testes e num Worker
   * publicado sem a tela: aí todo caminho fora das rotas da API responde 404.
   */
  ASSETS?: Fetcher;
}
