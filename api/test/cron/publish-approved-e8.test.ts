// História #35, plano #66 (AC-5): o Cron manda ao Cadastro os E8 das propostas já decididas por uma pessoa.
import { beforeAll, describe, expect, it } from 'vitest';
import { MemoryApprovalStore, type CaseFile } from '../../src/approval/store.js';
import type { Published, RegistryCorrectionMessage, RegistryCorrectionOutbox, RegistryPort } from '../../src/connectors/ports.js';
import { LOOKUP_FILES, lastDaysUtc, publishApprovedUnregistered } from '../../src/cron/publish-approved-e8.js';
import { propose } from '../../src/domain/approval.js';
import { ApprovalPolicy, type ApprovalRoute } from '../../src/domain/approval-policy.js';
import { amountAtRiskOfUnregistered } from '../../src/domain/checks/e8-item-sem-cadastro.js';
import type { Approval } from '../../src/domain/approval.js';
import { DockAction, Money, Proposal, Title, type Invoice } from '../../src/domain/index.js';
import { kitDomain, kitInvoice, withItems, type KitDomain } from '../support/kit-domain.js';

const DIA = '2026-11-15';

/** #35 Caixa de saída em memória e idempotente como a do Supabase (#59): a mesma nota e o mesmo item entram uma vez. */
class IdempotentOutbox implements RegistryCorrectionOutbox {
  readonly published: Published<RegistryCorrectionMessage>[] = [];
  async publish(message: RegistryCorrectionMessage): Promise<Published<RegistryCorrectionMessage>> {
    const existing = this.published.find(
      (m) => m.invoiceAccessKey === message.invoiceAccessKey && m.kind === message.kind && m.supplierCode === message.supplierCode,
    );
    if (existing) return existing;
    const row = { ...message, id: this.published.length + 1, publishedAt: '2026-11-15T00:00:00Z' };
    this.published.push(row);
    return row;
  }
  async list(): Promise<Published<RegistryCorrectionMessage>[]> {
    return [...this.published];
  }
}

/** #356 AC-4 A caixa do Supabase: sabe listar o que já publicou das notas dadas, e conta cada tentativa de publicar. */
class KnowingOutbox extends IdempotentOutbox {
  attempts = 0;
  lookups = 0;
  override async publish(message: RegistryCorrectionMessage): Promise<Published<RegistryCorrectionMessage>> {
    this.attempts += 1;
    return super.publish(message);
  }
  async listFor(keys: readonly string[]): Promise<Published<RegistryCorrectionMessage>[]> {
    this.lookups += 1;
    return this.published.filter((m) => keys.includes(m.invoiceAccessKey));
  }
}

let kit: KitDomain;
let registry: RegistryPort;
beforeAll(async () => {
  kit = await kitDomain();
  registry = { listSuppliers: async () => [...kit.ctx.suppliers], listProducts: async () => [...kit.ctx.products] };
});

function checked(invoiceId: string): Invoice {
  // #66 Uma cópia: as notas do kit são compartilhadas entre os testes e a conferência muda o estado.
  const original = kitInvoice(kit, invoiceId);
  const invoice = withItems(original, original.items);
  invoice.check(kit.ctx);
  return invoice;
}

/** #35 Nota sem divergência: a régua aprova sem pessoa e o processo entra decidido, como no #63. */
function ruleCaseFile(invoice: Invoice, route: ApprovalRoute): CaseFile {
  const title = Title.post({ invoiceAccessKey: invoice.accessKey, amount: invoice.total, dueOn: invoice.issuedOn });
  const { proposal, approval } = propose(invoice, title, {
    route,
    dockAction: DockAction.receive(),
    amountAtRisk: Money.zero(),
    justification: 'teste',
    today: DIA,
  });
  return { invoice, proposal, title, route, approval, supplierBlocked: false };
}

function caseFile(invoice: Invoice, state: 'aprovada' | 'alterada' | 'aguardando_aprovacao' | 'regra'): CaseFile {
  const route = ApprovalPolicy.route(invoice);
  if (state === 'regra') return ruleCaseFile(invoice, route);
  const proposal = Proposal.register({
    classification: invoice.classification,
    dockAction: DockAction.receive(),
    level: route.level,
    amountAtRisk: amountAtRiskOfUnregistered(invoice, kit.ctx),
    justification: 'teste',
  });
  proposal.awaitApproval();
  if (state === 'aprovada') proposal.approve();
  if (state === 'alterada') proposal.alter(DockAction.receive(), 'recebe e corrige o cadastro');
  const approval: Approval | null =
    state === 'aguardando_aprovacao'
      ? null
      : Object.freeze({
          approver: 'coordenacao@jachegou.test',
          approverLevel: 'coordenacao',
          dockAction: proposal.dockAction,
          justification: 'teste',
          decidedOn: DIA,
        });
  const title = Title.post({ invoiceAccessKey: invoice.accessKey, amount: invoice.total, dueOn: invoice.issuedOn });
  return { invoice, proposal, title, route, approval, supplierBlocked: false };
}

describe('#35 Cron: E8 aprovado vai à caixa de saída do Cadastro', () => {
  it('AC-5: a NF-009 aprovada publica uma mensagem E8 com o item F02-N27', async () => {
    const outbox = new IdempotentOutbox();
    const store = new MemoryApprovalStore([caseFile(checked('NF-009'), 'aprovada')]);

    const result = await publishApprovedUnregistered({ store, outbox, days: [DIA] });

    expect(result).toEqual({ published: 1 });
    expect(outbox.published).toHaveLength(1);
    expect(outbox.published[0]).toMatchObject({ kind: 'E8_item_sem_cadastro', supplierCode: 'F02-N27' });
  });

  it('AC-5: a proposta alterada também publica', async () => {
    const outbox = new IdempotentOutbox();
    const store = new MemoryApprovalStore([caseFile(checked('NF-009'), 'alterada')]);

    expect(await publishApprovedUnregistered({ store, outbox, days: [DIA] })).toEqual({ published: 1 });
  });

  it('AC-5: proposta aguardando aprovação não publica nada', async () => {
    const outbox = new IdempotentOutbox();
    const store = new MemoryApprovalStore([caseFile(checked('NF-009'), 'aguardando_aprovacao')]);

    expect(await publishApprovedUnregistered({ store, outbox, days: [DIA] })).toEqual({ published: 0 });
    expect(outbox.published).toHaveLength(0);
  });

  it('AC-5: nota aprovada sem E8 não publica nada', async () => {
    const outbox = new IdempotentOutbox();
    const store = new MemoryApprovalStore([caseFile(checked('NF-001'), 'regra')]);

    expect(await publishApprovedUnregistered({ store, outbox, days: [DIA] })).toEqual({ published: 0 });
    expect(outbox.published).toHaveLength(0);
  });

  it('AC-5: decidida fora dos dias pedidos não publica', async () => {
    const outbox = new IdempotentOutbox();
    const store = new MemoryApprovalStore([caseFile(checked('NF-009'), 'aprovada')]);

    expect(await publishApprovedUnregistered({ store, outbox, days: ['2026-11-01'] })).toEqual({ published: 0 });
  });

  it('AC-5: rodar duas vezes no mesmo dia deixa uma só mensagem', async () => {
    const outbox = new IdempotentOutbox();
    const store = new MemoryApprovalStore([caseFile(checked('NF-009'), 'aprovada')]);

    await publishApprovedUnregistered({ store, outbox, days: [DIA] });
    await publishApprovedUnregistered({ store, outbox, days: [DIA] });

    expect(outbox.published).toHaveLength(1);
  });

  it('AC-5: a janela são os últimos 7 dias em UTC, de hoje para trás (#66)', () => {
    expect(lastDaysUtc(new Date('2026-11-15T01:30:00Z'), 7)).toEqual([
      '2026-11-15',
      '2026-11-14',
      '2026-11-13',
      '2026-11-12',
      '2026-11-11',
      '2026-11-10',
      '2026-11-09',
    ]);
  });

  it('AC-5: uma decisão de seis dias atrás, dentro da janela, ainda chega ao Cadastro (#66)', async () => {
    const outbox = new IdempotentOutbox();
    const store = new MemoryApprovalStore([caseFile(checked('NF-009'), 'aprovada')]);
    const days = lastDaysUtc(new Date('2026-11-21T10:00:00Z'), 7);

    expect(await publishApprovedUnregistered({ store, outbox, days })).toEqual({ published: 1 });
  });
});

describe('#356/AC-4 o teto de mensagens ao Cadastro por chamada', () => { // ADR-002
  /** #356 AC-4 Os casos do kit decididos com E8, um por nota. */
  function decidedE8(): CaseFile[] {
    const ids = ['NF-009', 'NF-010', 'NF-011', 'NF-012', 'NF-013', 'NF-014', 'NF-015', 'NF-016', 'NF-017', 'NF-018', 'NF-019', 'NF-020', 'NF-021'];
    return ids
      .map((id) => caseFile(checked(id), 'aprovada'))
      .filter((f) => f.invoice.divergences.some((d) => d.classification === 'E8'));
  }

  it('com o teto, publica no máximo esse tanto de mensagens, mesmo com notas inteiras a mais', async () => { // ADR-002
    const files = decidedE8();
    expect(files.length).toBeGreaterThanOrEqual(3);
    const outbox = new IdempotentOutbox();
    const result = await publishApprovedUnregistered({ store: new MemoryApprovalStore(files), outbox, days: [DIA], limit: 2 });
    expect(result.published).toBe(2);
    expect(outbox.published).toHaveLength(2);
  });

  it('com a caixa que sabe o que já publicou, as chamadas seguintes publicam as mensagens de trás, sem republicar as da frente', async () => { // ADR-002
    const files = decidedE8();
    const outbox = new KnowingOutbox();
    const store = new MemoryApprovalStore(files);
    const total = (await publishApprovedUnregistered({ store, outbox: new IdempotentOutbox(), days: [DIA] })).published;
    const runs: number[] = [];
    for (let i = 0; i < total + 1; i += 1) runs.push((await publishApprovedUnregistered({ store, outbox, days: [DIA], limit: 2 })).published);
    expect(runs.reduce((n, v) => n + v, 0)).toBe(total);
    expect(outbox.published).toHaveLength(total);
    expect(runs.at(-1)).toBe(0);
    expect(outbox.attempts, 'nenhuma publicação repetida').toBe(total);
  });

  it('sem o teto, publica tudo, como fora da rodada', async () => { // ADR-002
    const files = decidedE8();
    const outbox = new IdempotentOutbox();
    const unlimited = await publishApprovedUnregistered({ store: new MemoryApprovalStore(files), outbox, days: [DIA] });
    const capped = new IdempotentOutbox();
    const some = await publishApprovedUnregistered({ store: new MemoryApprovalStore(files), outbox: capped, days: [DIA], limit: 1 });
    expect(unlimited.published).toBeGreaterThan(some.published);
  });

  it('com mais notas decididas que um bloco de leitura, lê a caixa dos blocos de trás e publica as de trás sem fome, sem passar do teto de pedidos', async () => { // ADR-002
    const model = decidedE8()[0];
    if (!model) throw new Error('o kit não tem nota decidida com E8');
    const copy = (n: number): CaseFile => ({ ...model, invoice: Object.create(model.invoice, { accessKey: { value: `chave-${String(n).padStart(3, '0')}` } }) as CaseFile['invoice'] });
    const published = Array.from({ length: LOOKUP_FILES + 10 }, (_, n) => copy(n));
    const all = [...published, ...Array.from({ length: 10 }, (_, n) => copy(LOOKUP_FILES + 10 + n))];
    const outbox = new KnowingOutbox();
    // #356 AC-4 as 70 da frente já estão publicadas (10 delas além do primeiro bloco de leitura): só as 10 do fim são novas
    await publishApprovedUnregistered({ store: new MemoryApprovalStore(published), outbox, days: [DIA] });
    expect(outbox.published).toHaveLength(LOOKUP_FILES + 10);
    outbox.attempts = 0;
    outbox.lookups = 0;
    const limit = 8;
    const result = await publishApprovedUnregistered({ store: new MemoryApprovalStore(all), outbox, days: [DIA], limit });
    expect(outbox.published.length - (LOOKUP_FILES + 10), 'as do fim saem, sem esperar as da frente saírem da janela').toBe(result.published);
    expect(result.published).toBeGreaterThan(0);
    expect(outbox.published.slice(LOOKUP_FILES + 10).every((m) => m.invoiceAccessKey >= 'chave-070')).toBe(true);
    expect(outbox.attempts, 'nenhuma republicada').toBe(result.published);
    expect(outbox.lookups, 'um bloco por 60 notas alcançadas').toBe(2);
    expect(outbox.lookups + outbox.attempts, 'as leituras contam no teto de pedidos da chamada').toBeLessThanOrEqual(1 + limit);
  });

  it('a chamada que não passa do primeiro bloco gasta uma só leitura da caixa', async () => { // ADR-002
    const files = decidedE8();
    const outbox = new KnowingOutbox();
    await publishApprovedUnregistered({ store: new MemoryApprovalStore(files), outbox, days: [DIA], limit: 2 });
    expect(outbox.lookups).toBe(1);
  });
});
