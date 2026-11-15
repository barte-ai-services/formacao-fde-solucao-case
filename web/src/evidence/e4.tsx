import { Block, DataList, Panel, ReconciliationDiff, type ComparisonField } from "@barte-ai-services/barte-ui-kit";
import { GenericEvidence } from "./GenericEvidence";
import { divergenceLabel } from "./labels";
import { registerEvidence, type EvidenceProps } from "./registry";

type Unidade = "UN" | "CX";

interface Lado {
  quantidade: number;
  unidade: Unidade;
  preco: string;
}

/** #37: o que a evidência da E4 diz de um SKU, já lido do fio. */
interface ConversaoDoSku {
  sku: string;
  ordem: string;
  nota: Lado;
  pedido: Lado;
  fator: number;
}

/**
 * #37: os três textos que `api/src/domain/checks/e4-unidade-de-medida.ts` escreve por SKU. O preço
 * vem do `Money.toString()` do domínio e só é mostrado, nunca recalculado.
 */
const PRECO = String.raw`-?R\$ \d{1,3}(?:\.\d{3})*,\d{2}`;
const NA_NOTA = new RegExp(String.raw`^Item (\S+) na nota: (\d+) (UN|CX) a (${PRECO})$`);
const NA_ORDEM = new RegExp(String.raw`^Item (\S+) na ordem: (\d+) (UN|CX) a (${PRECO})$`);
const NO_CADASTRO = /^Produto (\S+): fator de caixa (\d+); nota (\d+) UN, ordem (\d+) UN$/;

/** #37: um campo de texto de um registro do fio, que pode trazer qualquer coisa. */
function texto(item: unknown, campo: "source" | "reference" | "description"): string {
  if (typeof item !== "object" || item === null || !Object.hasOwn(item, campo)) return "";
  const valor: unknown = Reflect.get(item, campo);
  return typeof valor === "string" ? valor : "";
}

function inteiro(digitos: string | undefined): number | undefined {
  if (digitos === undefined) return undefined;
  const n = Number(digitos);
  return Number.isSafeInteger(n) ? n : undefined;
}

function unidade(sigla: string | undefined): Unidade | undefined {
  return sigla === "UN" || sigla === "CX" ? sigla : undefined;
}

function lado(m: RegExpExecArray): Lado | undefined {
  const quantidade = inteiro(m[2]);
  const u = unidade(m[3]);
  const preco = m[4];
  return quantidade === undefined || u === undefined || preco === undefined ? undefined : { quantidade, unidade: u, preco };
}

/** #37: a quantidade em UN, pela conta com o fator do cadastro. */
function emUnidades(l: Lado, fator: number): number {
  return l.unidade === "CX" ? l.quantidade * fator : l.quantidade;
}

interface Parcial {
  nota?: Lado;
  pedido?: Lado;
  ordem?: string;
  cadastro?: { fator: number; notaUn: number; ordemUn: number };
}

/**
 * #37: agrupa as evidências por SKU e monta a conversão de cada um. Qualquer evidência que não se
 * leia, SKU sem as três, unidades iguais ou fator que não fecha com as quantidades do cadastro
 * devolvem `undefined`, e a tela cai no genérico em vez de mostrar uma conta pela metade.
 */
function lerConversoes(evidence: unknown): ConversaoDoSku[] | undefined {
  if (!Array.isArray(evidence) || evidence.length === 0) return undefined;
  const registros: readonly unknown[] = evidence;
  const porSku = new Map<string, Parcial>();
  const doSku = (sku: string | undefined): Parcial | undefined => {
    if (sku === undefined) return undefined;
    const atual = porSku.get(sku) ?? {};
    porSku.set(sku, atual);
    return atual;
  };
  for (const item of registros) {
    const source = texto(item, "source");
    const description = texto(item, "description");
    const reference = texto(item, "reference");
    const nota = source === "sefaz" ? NA_NOTA.exec(description) : null;
    const ordem = source === "erp_compras" ? NA_ORDEM.exec(description) : null;
    const cadastro = source === "erp_cadastro" ? NO_CADASTRO.exec(description) : null;
    if (nota !== null) {
      const parcial = doSku(nota[1]);
      const l = lado(nota);
      if (parcial === undefined || l === undefined || parcial.nota !== undefined) return undefined;
      parcial.nota = l;
    } else if (ordem !== null) {
      const parcial = doSku(ordem[1]);
      const l = lado(ordem);
      if (parcial === undefined || l === undefined || parcial.pedido !== undefined || reference === "") return undefined;
      parcial.pedido = l;
      parcial.ordem = reference;
    } else if (cadastro !== null) {
      const parcial = doSku(cadastro[1]);
      const fator = inteiro(cadastro[2]);
      const notaUn = inteiro(cadastro[3]);
      const ordemUn = inteiro(cadastro[4]);
      if (
        parcial === undefined ||
        fator === undefined ||
        notaUn === undefined ||
        ordemUn === undefined ||
        parcial.cadastro !== undefined
      ) {
        return undefined;
      }
      parcial.cadastro = { fator, notaUn, ordemUn };
    } else {
      return undefined;
    }
  }
  const conversoes: ConversaoDoSku[] = [];
  for (const [sku, { nota, pedido, ordem, cadastro }] of porSku) {
    if (nota === undefined || pedido === undefined || ordem === undefined || cadastro === undefined) return undefined;
    if (nota.unidade === pedido.unidade || cadastro.fator <= 0) return undefined;
    if (emUnidades(nota, cadastro.fator) !== cadastro.notaUn) return undefined;
    if (emUnidades(pedido, cadastro.fator) !== cadastro.ordemUn) return undefined;
    conversoes.push({ sku, ordem, nota, pedido, fator: cadastro.fator });
  }
  return conversoes;
}

function quantidade(l: Lado): string {
  return `${l.quantidade} ${l.unidade}`;
}

/** #37: o lado em CX mostra a conta; o lado em UN, a quantidade como veio. */
function convertido(l: Lado, fator: number): string {
  return l.unidade === "CX" ? `${quantidade(l)} × fator ${fator} = ${emUnidades(l, fator)} UN` : quantidade(l);
}

function campos(c: ConversaoDoSku): ComparisonField[] {
  const bate = emUnidades(c.nota, c.fator) === emUnidades(c.pedido, c.fator);
  return [
    {
      label: "Quantidade",
      a: quantidade(c.nota),
      b: quantidade(c.pedido),
      state: "not-comparable",
      note: "unidades diferentes; a comparação é depois da conversão",
    },
    {
      label: "Convertido",
      a: convertido(c.nota, c.fator),
      b: convertido(c.pedido, c.fator),
      state: bate ? "match" : "divergent",
    },
    {
      label: "Preço",
      a: `${c.nota.preco} por ${c.nota.unidade}`,
      b: `${c.pedido.preco} por ${c.pedido.unidade}`,
      state: "not-comparable",
      note: `preço por ${c.nota.unidade} contra preço por ${c.pedido.unidade}`,
    },
  ];
}

/** #37: o fator que as quantidades da nota e da ordem sugerem, ao lado do que o cadastro tem. */
function fatorACorrigir(c: ConversaoDoSku): string {
  const caixas = c.nota.unidade === "CX" ? c.nota : c.pedido;
  const unidades = c.nota.unidade === "CX" ? c.pedido : c.nota;
  const observado =
    caixas.quantidade > 0 && unidades.quantidade % caixas.quantidade === 0
      ? `1 CX = ${unidades.quantidade / caixas.quantidade} UN`
      : `${quantidade(caixas)} para ${quantidade(unidades)}, não fecha em caixa inteira`;
  return `Cadastro: 1 CX = ${c.fator} UN · observado: ${observado}`;
}

/**
 * E4 · Unidade de medida, #37. Por SKU, a quantidade da nota contra a da ordem, a conversão pelo
 * fator do cadastro e o preço em cada unidade, e o fator a corrigir no Cadastro. O que não se lê
 * cai no genérico.
 */
export function UnidadeDeMedidaEvidence({ divergence }: EvidenceProps) {
  const conversoes = lerConversoes(divergence.evidence);
  if (conversoes === undefined || conversoes.length === 0) return <GenericEvidence divergence={divergence} />;
  const ordens = [...new Set(conversoes.map((c) => c.ordem))].join(", ");
  return (
    <Panel
      title={divergenceLabel(String(divergence.classification))}
      description={`Ordem ${ordens} e cadastro do produto`}
      size="sm"
      padding="md"
    >
      {conversoes.map((c) => (
        <ReconciliationDiff
          key={c.sku}
          ariaLabel={`Conversão do ${c.sku}`}
          fieldLabel={c.sku}
          columns={["Nota fiscal", "Ordem de compra"]}
          fields={campos(c)}
          showSummary={false}
          variant="grid"
        />
      ))}
      <Block title="Fator a corrigir no Cadastro" size="overline" headingLevel={4}>
        <DataList
          divided
          aria-label="Fator a corrigir no Cadastro"
          items={conversoes.map((c) => ({ key: c.sku, label: c.sku, value: fatorACorrigir(c), emphasis: true }))}
        />
      </Block>
    </Panel>
  );
}

registerEvidence("E4", UnidadeDeMedidaEvidence);
