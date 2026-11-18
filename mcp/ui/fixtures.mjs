// Os resultados das tools como o servidor os devolve (snake_case, dinheiro { cents, text }), para o host falso (#274).
// A tela só mostra o que está aqui: o teste confere que nenhum número aparece sem ter vindo deste arquivo (#274).

export const KEY = "35261174055489000148550010000438941174512643";
export const OTHER_KEY = "35261174055489000148550010000204601174512644";
export const THIRD_KEY = "35261174055489000148550010000599381174512645";

export const money = (cents, text) => ({ cents, text });

export function queueItem(over = {}) {
  return {
    invoice_access_key: KEY,
    number: "43894",
    supplier_id: "F02",
    store: "LJ-012",
    total: money(141856, "R$ 1.418,56"),
    classification: "E4",
    classification_name: "Unidade de medida",
    level: "analista",
    required_approver_level: "analista",
    amount_at_risk: money(141856, "R$ 1.418,56"),
    dock_action: { kind: "receber" },
    can_decide: true,
    dossier_status: null,
    engine: null,
    ...over,
  };
}

export const ITEM_E3 = queueItem({
  invoice_access_key: OTHER_KEY,
  number: "59738",
  supplier_id: "F07",
  classification: "E3",
  classification_name: "Quantidade menor",
  amount_at_risk: money(26362, "R$ 263,62"),
  dock_action: { kind: "receber_parcial" },
  engine: { outcome: "approve", confidence: 0.94, mode: "shadow" },
});

export const ITEM_BLOCKED = queueItem({
  invoice_access_key: THIRD_KEY,
  number: "20046",
  supplier_id: "F11",
  classification: "E2",
  classification_name: "Item trocado",
  level: "coordenacao",
  required_approver_level: "coordenacao",
  amount_at_risk: money(216320, "R$ 2.163,20"),
  dock_action: { kind: "receber_parcial" },
  can_decide: false,
});

// O cabeçalho vem da tool (12 propostas, R$ 84.310,20), e não é a soma das linhas da lista: a tela não soma (#274).
export function queueOutput(items = [queueItem(), ITEM_E3], over = {}) {
  return {
    approver: { email: "ana@exemplo.com", level: "analista" },
    items,
    waiting_for_you: { count: 12, amount_at_risk: money(8431020, "R$ 84.310,20") },
    ...over,
  };
}

export function proposalOutput(over = {}) {
  return {
    ...queueItem(),
    dossier_status: "ready",
    regua: { line: 5, reason: "E1 a E4 em nota de até R$ 20 mil" },
    justification: "Fator de caixa fecha a conta",
    items: [
      {
        supplier_code: "A1", sku: "SKU-1006", description: "Água 500 ml", quantity: { amount: 72, unit: "UN" },
        stock_quantity: null, unit_price: money(1970, "R$ 19,70"), total: money(141856, "R$ 1.418,56"),
      },
    ],
    divergences: [
      {
        classification: "E4", classification_name: "Unidade de medida", skus: ["SKU-1006"],
        evidence: [{ source: "erp_compras", reference: "OC-1", description: "Ordem: 6 CX · Nota: 72 UN · fator de caixa 12 → bate" }],
      },
    ],
    title: { state: "aguardando_aprovacao", amount: money(141856, "R$ 1.418,56"), due_on: "2026-12-10" },
    approval: null,
    dossier: {
      status: "ready",
      summary: "A nota cobra 72 UN e a ordem pediu 6 CX.",
      divergences: [
        {
          classification: "E4", classification_name: "Unidade de medida", what_diverges: "A unidade da nota difere da ordem.",
          evidence: [{ key: "box_factor", label: "Fator de caixa", value: "12 UN por CX", source: "erp_cadastro" }],
        },
      ],
      supplier_history: null,
      generated_at: "2026-11-18T12:00:00Z",
    },
    engine: {
      mode: "shadow", outcome: "approve", decided_by: "clef", confidence: 0.99, model_version: "clef-v1",
      reason: "A conversão pelo fator de caixa do cadastro fecha a conta.", similar_cases_count: 3,
    },
    audit: {
      status: "auditada", reason: null, classification: "E4", dock_action: { kind: "receber" }, routing: "analista",
      justification: "O fator de caixa fecha a conta.", amount_at_risk: money(141856, "R$ 1.418,56"),
      audited_at: "2026-11-18T12:05:00Z", agreement: { agrees: true, differs: [] }, raised_level: null,
      injection_flag: null, refusals: [],
    },
    proposed_partial_lines: [{ sku: "SKU-1006", quantity: { amount: 6, unit: "CX" }, disposition: "segurar" }],
    ...over,
  };
}

export function decisionOutput(over = {}) {
  return {
    approval: {
      approver: "ana@exemplo.com", approver_level: "analista", decided_at: "2026-11-18", decision: "approve",
      decided_hour: null, dock_action: { kind: "receber" }, justification: "", // #274 a API só grava o dia: a hora vem null
    },
    title_state: "na_lista_do_dia",
    ...over,
  };
}

// O resultado de uma tool como o host o entrega à tela (CallToolResult) (#274).
export function ok(structured) {
  return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured, isError: false };
}

export function fail(code, message, extra = {}) {
  const structured = { error: code, message, ...extra };
  return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured, isError: true };
}

export const SESSION_EXPIRED = "Sua sessão expirou. Entre de novo pelo Access.";
