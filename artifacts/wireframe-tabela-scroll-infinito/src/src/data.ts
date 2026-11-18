/**
 * Dados de mentira, determinísticos, só para o desenho. A Já Chegou é fictícia.
 * Os "agregados" saem da lista inteira, como a API (#159) devolve: não dependem de quantas páginas já carregaram.
 */
export const BLOCK = 30; // `limite` padrão do contrato (#159)

const brl = (cents: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
export const money = (cents: number) => ({ cents, text: brl(cents) });

type Level = "bloqueio" | "diretoria" | "coordenacao" | "analista";
const RANK: Record<Level, number> = { bloqueio: 4, diretoria: 3, coordenacao: 2, analista: 1 };
const EXC = [
  ["E1", "Falta física na nota"],
  ["E2", "Item a mais na nota"],
  ["E3", "Quantidade a menos"],
  ["E4", "Preço fora do pedido"],
  ["E5", "Pedido não encontrado"],
  ["E6", "Título já lançado"],
] as const;
const ACT = ["receber", "receber_parcial", "recusar"] as const;
const LEVELS: Level[] = ["analista", "coordenacao", "diretoria", "analista", "coordenacao", "analista", "diretoria", "analista", "coordenacao", "bloqueio", "analista"];

export interface FilaRow {
  key: string;
  number: string;
  issuedOn: string;
  supplierId: string;
  exceptionCode: string;
  exceptionName: string;
  dockAction: (typeof ACT)[number];
  level: Level;
  requiredApproverLevel: Level;
  risk: { cents: number; text: string };
  total: { cents: number; text: string };
  canApprove: boolean;
}

function build(n: number): FilaRow[] {
  const rows = Array.from({ length: n }, (_, i): FilaRow => {
    const level = LEVELS[(i * 7 + 3) % LEVELS.length]!;
    const [code, name] = EXC[(i * 5 + 1) % EXC.length]!;
    const total = 90_000 + ((i * 7919) % 480_000);
    const risk = Math.round(total * (0.12 + ((i * 13) % 60) / 100));
    return {
      key: `3526${String(100000 + i * 37)}`,
      number: String(48210 + i * 3),
      issuedOn: `2026-11-${String(1 + (i % 17)).padStart(2, "0")}`,
      supplierId: `FORN-${String(400 + ((i * 11) % 90)).padStart(4, "0")}`,
      exceptionCode: code,
      exceptionName: name,
      dockAction: ACT[(i * 3) % 3]!,
      level,
      requiredApproverLevel: level === "bloqueio" ? "diretoria" : level,
      risk: money(risk),
      total: money(total),
      canApprove: level === "analista" || level === "coordenacao",
    };
  });
  // A ordem total do servidor (#159): nível mais severo, maior valor em risco, chave de acesso.
  return rows.sort((a, b) => RANK[b.level] - RANK[a.level] || b.risk.cents - a.risk.cents || (a.key < b.key ? -1 : 1));
}

/** A fila inteira, como o servidor a tem (132 notas). Quem rola só vê o que carregou. */
export const FILA = build(132);
export const FILA_MINE = FILA.filter((r) => r.canApprove);
export const AGG_FILA = {
  approvable: FILA_MINE.length,
  amountAtRisk: money(FILA.reduce((s, r) => s + r.risk.cents, 0)),
  blocked: FILA.filter((r) => r.level === "bloqueio").length,
};

export interface HojeRow {
  key: string;
  number: string;
  supplierId: string;
  exceptionCode: string;
  exceptionName: string;
  dockAction: (typeof ACT)[number];
  approver: string | null;
  amount: { cents: number; text: string };
  invoiceTotal: { cents: number; text: string };
}
const APPROVERS = ["regra", "regra", "Marina Prado", "regra", "Caio Mendes", "regra"];
export const HOJE: HojeRow[] = Array.from({ length: 87 }, (_, i) => {
  const [code, name] = EXC[(i * 3 + 2) % EXC.length]!;
  const total = 60_000 + ((i * 6151) % 350_000);
  const pay = Math.round(total * (0.7 + ((i * 7) % 30) / 100));
  return {
    key: `3526${String(200000 + i * 41)}`,
    number: String(51020 + i * 2),
    supplierId: `FORN-${String(400 + ((i * 17) % 90)).padStart(4, "0")}`,
    exceptionCode: code,
    exceptionName: name,
    dockAction: ACT[(i * 5) % 3]!,
    approver: APPROVERS[i % APPROVERS.length]!,
    amount: money(pay),
    invoiceTotal: money(total),
  };
}).sort((a, b) => (a.key < b.key ? -1 : 1));
export const AGG_HOJE = {
  toPay: money(HOJE.reduce((s, r) => s + r.amount.cents, 0)),
  approvedByRule: HOJE.filter((r) => r.approver === "regra").length,
};
