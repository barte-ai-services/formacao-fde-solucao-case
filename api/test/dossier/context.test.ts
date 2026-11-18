// #38 Regra 1 no contexto do dossiê: a própria nota não entra entre as capturadas do catálogo.
import { describe, expect, it } from 'vitest';
import { supabaseConnectors } from '../../src/connectors/supabase-connectors.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { loadDossierContext } from '../../src/dossier/context.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';
import { KIT_ACCESS_KEY } from './kit-case.js';

describe('#68 regra 1 no contexto do dossiê', () => {
  it('a nota pedida sai da lista de capturadas; as outras 79 continuam lá', async () => {
    const fake = new FakePostgrest(kitTables());
    const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
    const { captureDeps } = supabaseConnectors(rest);

    const ctx = await loadDossierContext(captureDeps, KIT_ACCESS_KEY);

    expect(ctx.capturedInvoices.some((i) => i.accessKey === KIT_ACCESS_KEY)).toBe(false);
    expect(ctx.capturedInvoices).toHaveLength(79);
  });

  it('com outra chave, a lista de capturadas volta a ter todas as notas', async () => {
    const fake = new FakePostgrest(kitTables());
    const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
    const { captureDeps } = supabaseConnectors(rest);

    const ctx = await loadDossierContext(captureDeps, 'chave-que-nao-existe');

    expect(ctx.capturedInvoices).toHaveLength(80);
  });
});
