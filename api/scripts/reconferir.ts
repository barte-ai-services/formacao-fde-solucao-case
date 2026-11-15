// #56 Ponto de entrada do workflow reconferir.yml. Lê a URL e a chave secreta do ambiente do passo
// (vindas da variável e do secret do repositório) e nunca as escreve no log.
import { SupabaseRest } from '../src/connectors/supabase-rest.js';
import { reconferir } from '../src/ops/reconferir.js';

const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const url = env.BARTE_ACADEMY_SUPABASE_URL;
const secretKey = env.BARTE_ACADEMY_SUPABASE_SECRET_KEY;
if (!url || !secretKey) throw new Error('reconferir: faltam BARTE_ACADEMY_SUPABASE_URL e BARTE_ACADEMY_SUPABASE_SECRET_KEY');

await reconferir(new SupabaseRest({ url, secretKey }), {
  BARTE_ACADEMY_SUPABASE_URL: url,
  BARTE_ACADEMY_SUPABASE_SECRET_KEY: secretKey,
});
console.log('reconferir: tabelas do domínio apagadas e notas conferidas de novo');
