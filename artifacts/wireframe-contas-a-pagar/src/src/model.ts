// Os dados de exemplo saem do gabarito do kit (formacao-kit, t82-t84). A Já Chegou é fictícia.
import data from "./data.json";

export type Classificacao = "match" | "E1" | "E2" | "E3" | "E4" | "E5" | "E6" | "E7" | "E8";
export type Acao = "receber" | "receber_parcial" | "recusar";
export type Nivel = "regra" | "analista" | "coordenacao" | "diretoria" | "bloqueio";
export type Situacao = "aguardando" | "aprovada" | "alterada" | "regra";

export interface Item {
  desc: string;
  qtd: number;
  un: string;
  preco: number;
  valor: number;
}

export interface Original {
  numero: number;
  data: string;
  canal: string;
  ordem: string | null;
  valor: number;
  como: "mesma chave" | "mesma ordem";
}

export interface Nota {
  id: string;
  numero: number;
  chave: string;
  fornecedor: string;
  cnpj: string | null;
  bloqueado: boolean;
  destino: string;
  data: string;
  ordem: string | null;
  canal: string;
  valor: number;
  classificacao: Classificacao;
  acao: Acao;
  nivel: Nivel;
  risco: number;
  explicacao: string;
  itens: Item[];
  original?: Original;
  situacao: Situacao;
}

/** O "hoje" do wireframe: o último dia com notas no kit. */
export const HOJE = "2026-11-12";
export const META_MES = 543_000;

/**
 * O kit não traz decisões, só as propostas do gabarito. Antes da aprovação, toda proposta acima da
 * regra espera uma pessoa. No cenário "após aprovar", cada uma foi aprovada como o agente propôs.
 */
const BASE = data.notas as Omit<Nota, "situacao">[];

export function notasDe(aprovadas: boolean): Nota[] {
  return BASE.map((nota) => ({
    ...nota,
    situacao: nota.nivel === "regra" ? "regra" : aprovadas ? "aprovada" : "aguardando",
  }));
}

/** A linha dos limites de aprovação que vale para a nota (docs/domain, "Limites de aprovação"). */
export function linhaDoLimite(n: Pick<Nota, "nivel" | "classificacao">): number {
  if (n.nivel === "bloqueio") return 1;
  if (n.nivel === "diretoria") return 2;
  if (n.nivel === "coordenacao") return ["E5", "E7", "E8"].includes(n.classificacao) ? 3 : 4;
  if (n.nivel === "analista") return 5;
  return 6;
}

/** A primeira frase da explicação do gabarito, até os dois-pontos ou o ponto. */
export const resumo = (n: Pick<Nota, "explicacao">) => n.explicacao.split(/[:.](\s|$)/)[0];

export const EXCECAO: Record<Classificacao, string> = {
  match: "Confere",
  E1: "E1 · Falta física",
  E2: "E2 · Item trocado",
  E3: "E3 · Quantidade menor",
  E4: "E4 · Unidade de medida",
  E5: "E5 · Nota sem ordem",
  E6: "E6 · Duplicidade",
  E7: "E7 · Pago fora do fluxo",
  E8: "E8 · Item sem cadastro",
};

export const ACAO: Record<Acao, string> = {
  receber: "Receber",
  receber_parcial: "Receber parcial",
  recusar: "Recusar",
};

export const NIVEL: Record<Nivel, string> = {
  regra: "Regra",
  analista: "Analista",
  coordenacao: "Coordenação",
  diretoria: "Diretoria",
  bloqueio: "Bloqueio",
};

export const SITUACAO: Record<Situacao, string> = {
  aguardando: "Aguardando aprovação",
  aprovada: "Aprovada",
  alterada: "Alterada",
  regra: "Liberada pela regra",
};

export type Tom = "neutral" | "brand" | "positive" | "waiting" | "negative" | "info";

export const ACAO_TOM: Record<Acao, Tom> = { receber: "positive", receber_parcial: "waiting", recusar: "negative" };
export const NIVEL_TOM: Record<Nivel, Tom> = {
  regra: "neutral",
  analista: "info",
  coordenacao: "brand",
  diretoria: "waiting",
  bloqueio: "negative",
};
export const SITUACAO_TOM: Record<Situacao, Tom> = {
  aguardando: "waiting",
  aprovada: "positive",
  alterada: "info",
  regra: "neutral",
};

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
export const reais = (valor: number) => brl.format(valor);
export const reaisCurto = (valor: number) =>
  valor >= 1000 ? `R$ ${(valor / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 0 })} mil` : reais(valor);
export const dia = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/** A ordem da fila: o nível mais alto primeiro, depois o maior valor em risco. */
const PESO: Record<Nivel, number> = { bloqueio: 5, diretoria: 4, coordenacao: 3, analista: 2, regra: 1 };
export const naOrdemDaFila = (a: Nota, b: Nota) => PESO[b.nivel] - PESO[a.nivel] || b.risco - a.risco;

/** O nível de quem está logado no wireframe. */
export const MEU_NIVEL: Nivel = "coordenacao";
export const podeAprovar = (nivel: Nivel) =>
  nivel === "bloqueio" ? PESO[MEU_NIVEL] >= PESO.coordenacao : PESO[MEU_NIVEL] >= PESO[nivel];
