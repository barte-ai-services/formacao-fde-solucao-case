import { describe, expect, it } from 'vitest';
import { approve, draftProposal, NotAllowedToApproveError, propose, type Approver } from '../../src/domain/approval.js';
import { ApprovalPolicy } from '../../src/domain/approval-policy.js';
import { DockAction, Money, Quantity, Title, type Invoice } from '../../src/domain/index.js';
import { checkedWith, kitInvoice, kitSupplier } from './kit.js';

const TODAY = '2026-11-15';
const analista: Approver = { email: 'analista@jachegou.test', level: 'analista' };
const coordenacao: Approver = { email: 'coordenacao@jachegou.test', level: 'coordenacao' };
const diretoria: Approver = { email: 'diretoria@jachegou.test', level: 'diretoria' };

function proposeFor(invoice: Invoice) {
  const title = Title.post({ invoiceAccessKey: invoice.accessKey, amount: invoice.total, dueOn: TODAY });
  const route = ApprovalPolicy.route(invoice, kitSupplier(invoice.supplierId));
  const proposed = propose(invoice, title, { route, ...draftProposal(invoice, null), today: TODAY });
  return { title, route, ...proposed };
}

describe('propose()', () => {
  it('AC-1: no match, a regra aprova sem pessoa e o título vai para a lista do dia', () => {
    const invoice = checkedWith(kitInvoice('NF-036'));
    const { proposal, approval, title } = proposeFor(invoice);
    expect(proposal.level).toBe('regra');
    expect(proposal.state).toBe('aprovada');
    expect(approval).toMatchObject({ approver: 'regra', approverLevel: 'regra' });
    expect(invoice.state).toBe('decidida');
    expect(title.state).toBe('na_lista_do_dia');
  });

  it('AC-6: acima da regra, a proposta aguarda quem aprova e o título fica lançado', () => {
    const invoice = checkedWith(kitInvoice('NF-008'), 'E4');
    const { proposal, approval, title } = proposeFor(invoice);
    expect(proposal.state).toBe('aguardando_aprovacao');
    expect(approval).toBeNull();
    expect(invoice.state).toBe('com_proposta');
    expect(title.state).toBe('lancado');
  });

  it('AC-12, regra 6: o valor em risco fica entre zero e o valor da nota', () => {
    const invoice = checkedWith(kitInvoice('NF-012'), 'E6');
    const { proposal } = proposeFor(invoice);
    expect(proposal.amountAtRisk.amount.equals(invoice.total)).toBe(true);
    const other = checkedWith(kitInvoice('NF-008'), 'E4');
    const title = Title.post({ invoiceAccessKey: other.accessKey, amount: other.total, dueOn: TODAY });
    const route = ApprovalPolicy.route(other);
    expect(() =>
      propose(other, title, {
        route,
        dockAction: DockAction.receive(),
        amountAtRisk: other.total.add(Money.ofCents(1)),
        justification: 'x',
        today: TODAY,
      }),
    ).toThrow();
  });

  it('regra 3: a duplicidade propõe recusar', () => {
    const { proposal } = proposeFor(checkedWith(kitInvoice('NF-012'), 'E6'));
    expect(proposal.dockAction.kind).toBe('recusar');
    expect(proposal.level).toBe('bloqueio');
  });
});

describe('approve()', () => {
  it('AC-7: uma pessoa abaixo do nível não aprova, e nada muda', () => {
    const invoice = checkedWith(kitInvoice('NF-029'), 'E5');
    const { proposal, title } = proposeFor(invoice);
    expect(() => approve(invoice, proposal, title, analista, { kind: 'aprovar' }, TODAY)).toThrow(
      NotAllowedToApproveError,
    );
    expect(proposal.state).toBe('aguardando_aprovacao');
    expect(title.state).toBe('lancado');
  });

  it('AC-7: a pessoa no nível ou acima aprova', () => {
    const invoice = checkedWith(kitInvoice('NF-008'), 'E4');
    const { proposal, title } = proposeFor(invoice);
    const approval = approve(invoice, proposal, title, diretoria, { kind: 'aprovar' }, TODAY);
    expect(approval).toMatchObject({ approver: diretoria.email, approverLevel: 'diretoria', decidedOn: TODAY });
    expect(proposal.state).toBe('aprovada');
    expect(invoice.state).toBe('decidida');
  });

  it('AC-8: a proposta é aprovada uma vez só', () => {
    const invoice = checkedWith(kitInvoice('NF-008'), 'E4');
    const { proposal, title } = proposeFor(invoice);
    approve(invoice, proposal, title, analista, { kind: 'aprovar' }, TODAY);
    expect(() => approve(invoice, proposal, title, coordenacao, { kind: 'aprovar' }, TODAY)).toThrow();
  });

  it('AC-9: alterar sem justificativa é recusado, e nada muda', () => {
    const invoice = checkedWith(kitInvoice('NF-008'), 'E4');
    const { proposal, title } = proposeFor(invoice);
    const alter = { kind: 'alterar', dockAction: DockAction.refuse(), justification: '  ' } as const;
    expect(() => approve(invoice, proposal, title, analista, alter, TODAY)).toThrow();
    expect(proposal.state).toBe('aguardando_aprovacao');
    expect(invoice.state).toBe('com_proposta');
    expect(title.state).toBe('lancado');
  });

  it('AC-10: a duplicidade, no nível bloqueio, é resolvida pela coordenação', () => {
    const invoice = checkedWith(kitInvoice('NF-012'), 'E6');
    const { proposal, title } = proposeFor(invoice);
    expect(() => approve(invoice, proposal, title, analista, { kind: 'aprovar' }, TODAY)).toThrow();
    approve(invoice, proposal, title, coordenacao, { kind: 'aprovar' }, TODAY);
    expect(proposal.state).toBe('aprovada');
    expect(title.state).toBe('bloqueado');
  });

  it('AC-11: receber libera o título e o põe na lista do dia', () => {
    const invoice = checkedWith(kitInvoice('NF-008'), 'E4');
    const { proposal, title } = proposeFor(invoice);
    approve(invoice, proposal, title, analista, { kind: 'aprovar' }, TODAY);
    expect(title.state).toBe('na_lista_do_dia');
    expect(title.amount.equals(invoice.total)).toBe(true);
  });

  it('AC-11: recusar bloqueia o título', () => {
    const invoice = checkedWith(kitInvoice('NF-008'), 'E4');
    const { proposal, title } = proposeFor(invoice);
    approve(
      invoice,
      proposal,
      title,
      analista,
      { kind: 'alterar', dockAction: DockAction.refuse(), justification: 'fornecedor reenviou a nota' },
      TODAY,
    );
    expect(proposal.state).toBe('alterada');
    expect(title.state).toBe('bloqueado');
  });

  it('AC-11: receber parcial reduz o título pelo valor das linhas retidas', () => {
    const invoice = checkedWith(kitInvoice('NF-008'), 'E4');
    const { proposal, title } = proposeFor(invoice);
    // NF-008: SKU-1024, 312 UN a R$ 7,89. Devolver 10 UN tira R$ 78,90 do título.
    const lines = [{ sku: 'SKU-1024', quantity: Quantity.of(10, 'UN'), disposition: 'devolver' as const }];
    approve(
      invoice,
      proposal,
      title,
      analista,
      { kind: 'alterar', dockAction: DockAction.partial(lines), justification: 'devolve 10 UN avariadas' },
      TODAY,
    );
    expect(title.amount.equals(invoice.total.subtract(Money.ofCents(7_890)))).toBe(true);
    expect(title.state).toBe('na_lista_do_dia');
  });

  it('AC-11: receber parcial com SKU fora da nota, unidade errada ou a nota inteira é recusado, e nada muda', () => {
    const bad = [
      [{ sku: 'SKU-9999', quantity: Quantity.of(1, 'UN'), disposition: 'devolver' as const }],
      [{ sku: 'SKU-1024', quantity: Quantity.of(1, 'CX'), disposition: 'devolver' as const }],
      [{ sku: 'SKU-1024', quantity: Quantity.of(313, 'UN'), disposition: 'segurar' as const }],
    ];
    for (const lines of bad) {
      const invoice = checkedWith(kitInvoice('NF-008'), 'E4');
      const { proposal, title } = proposeFor(invoice);
      expect(() =>
        approve(invoice, proposal, title, analista, { kind: 'alterar', dockAction: DockAction.partial(lines), justification: 'x' }, TODAY),
      ).toThrow();
      expect(proposal.state).toBe('aguardando_aprovacao');
      expect(invoice.state).toBe('com_proposta');
      expect(title.state).toBe('lancado');
    }
  });

  it('regra 7 e decisão 4: a coordenação mantém a recusa da duplicidade acima de R$ 100 mil, mas liberar exige a diretoria', () => {
    const recusa = checkedWith(kitInvoice('NF-003'), 'E6');
    const a = proposeFor(recusa);
    expect(a.proposal.level).toBe('bloqueio');
    approve(recusa, a.proposal, a.title, coordenacao, { kind: 'aprovar' }, TODAY);
    expect(a.title.state).toBe('bloqueado');

    const libera = checkedWith(kitInvoice('NF-003'), 'E6');
    const b = proposeFor(libera);
    const receive = { kind: 'alterar', dockAction: DockAction.receive(), justification: 'não é duplicada' } as const;
    expect(() => approve(libera, b.proposal, b.title, coordenacao, receive, TODAY)).toThrow(NotAllowedToApproveError);
    approve(libera, b.proposal, b.title, diretoria, receive, TODAY);
    expect(b.title.state).toBe('na_lista_do_dia');
  });

  it('regra 7 e decisão 9: duplicidade de fornecedor bloqueado (NF-080, F12) só a diretoria libera', () => {
    const invoice = checkedWith(kitInvoice('NF-080'), 'E6');
    const { proposal, title } = proposeFor(invoice);
    const supplier = kitSupplier('F12');
    const receive = { kind: 'alterar', dockAction: DockAction.receive(), justification: 'não é duplicada' } as const;
    expect(() => approve(invoice, proposal, title, coordenacao, receive, TODAY, supplier)).toThrow(NotAllowedToApproveError);
    approve(invoice, proposal, title, diretoria, receive, TODAY, supplier);
    expect(title.state).toBe('na_lista_do_dia');
  });

  it('AC-11: o mesmo SKU em duas linhas não retém mais que a nota, e retenção sem valor é recusada', () => {
    const twice = [
      { sku: 'SKU-1024', quantity: Quantity.of(200, 'UN'), disposition: 'devolver' as const },
      { sku: 'SKU-1024', quantity: Quantity.of(200, 'UN'), disposition: 'segurar' as const },
    ];
    const invoice = checkedWith(kitInvoice('NF-008'), 'E4');
    const { proposal, title } = proposeFor(invoice);
    const alter = (lines: typeof twice) => ({ kind: 'alterar', dockAction: DockAction.partial(lines), justification: 'x' }) as const;
    expect(() => approve(invoice, proposal, title, analista, alter(twice), TODAY)).toThrow();
    const tiny = [{ sku: 'SKU-1024', quantity: Quantity.of(0.0001, 'UN'), disposition: 'devolver' as const }];
    expect(() => approve(invoice, proposal, title, analista, alter(tiny), TODAY)).toThrow(/não somam valor/);
    expect(proposal.state).toBe('aguardando_aprovacao');
    expect(invoice.state).toBe('com_proposta');
    expect(title.state).toBe('lancado');
  });

  it('o título que já saiu de lançado não é decidido de novo, e a proposta não muda', () => {
    const invoice = checkedWith(kitInvoice('NF-008'), 'E4');
    const { proposal, title } = proposeFor(invoice);
    title.block();
    expect(() => approve(invoice, proposal, title, analista, { kind: 'aprovar' }, TODAY)).toThrow();
    expect(proposal.state).toBe('aguardando_aprovacao');
  });
});
