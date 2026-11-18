import { DataList, Panel, ReconciliationDiff, type ComparisonField } from "@barte-ai-services/barte-ui-kit";
import type { EvidenceDto } from "../api/contract";
import { registerEvidence, type EvidenceProps } from "./registry";
import { GenericEvidence } from "./GenericEvidence";
import { sourceLabel } from "./labels";

/** O que o contas a pagar escreve na evidência do título já lançado (domínio, `postedDuplicate`). */
const POSTED_TITLE = /nota (\S+), ordem (\S+), (.+), situação (.+)$/;
/** O que a SEFAZ escreve na evidência da nota nova. */
const NEW_INVOICE = /Nota (\S+) cobra/;

function evidenceFrom(divergence: EvidenceProps["divergence"]): EvidenceDto[] {
  return Array.isArray(divergence.evidence) ? divergence.evidence : [];
}

/** Título original contra a nota nova: a mesma ordem e o mesmo valor, cobrados de novo. */
function PostedTitle({ title, invoice }: { title: EvidenceDto; invoice: EvidenceDto | undefined }) {
  const posted = POSTED_TITLE.exec(title.description ?? "");
  const number = NEW_INVOICE.exec(invoice?.description ?? "")?.[1] ?? null;
  const fields: ComparisonField[] = [
    { label: "Número", a: posted?.[1] ?? null, b: number, state: posted?.[1] === number ? "match" : "divergent" },
    { label: "Chave de acesso", a: <code>{title.reference}</code>, b: invoice ? <code>{invoice.reference}</code> : null, ...(invoice && title.reference === invoice.reference ? { state: "match" as const, note: "a mesma nota (reenvio)" } : { state: "divergent" as const, note: "nota nova" }) },
    { label: "Ordem", a: posted?.[2] ?? null, b: posted?.[2] ?? null, state: "match", note: posted?.[2] === "sem-ordem" ? "sem ordem" : "a mesma ordem" },
    { label: "Valor", a: posted?.[3] ?? null, b: posted?.[3] ?? null, state: "match", note: "o mesmo valor" },
    { label: "Título", a: posted?.[4] ?? null, b: "bloqueado" },
  ];
  return (
    <ReconciliationDiff
      columns={[posted ? `Título original · NF ${posted[1]}` : "Título original", number ? `Nota nova · NF ${number}` : "Nota nova"]}
      fields={posted ? fields : [{ label: "Título já lançado", a: title.description, b: invoice?.description ?? null }]}
      showSummary
      variant="grid"
      ariaLabel="Título original contra a nota nova"
    />
  );
}

/**
 * E6 · Duplicidade. Dois motivos, lidos da fonte da evidência, como o domínio faz: o contas a pagar
 * já tem um título da mesma ordem e do mesmo valor (regra 3), ou a ordem de compra não tem saldo
 * para o que a nota cobra (regra 5, duplicidade suspeita).
 */
function DuplicidadeEvidence({ divergence }: EvidenceProps) {
  const evidence = evidenceFrom(divergence);
  const titles = evidence.filter((e) => e?.source === "erp_contas_a_pagar");
  const invoice = evidence.find((e) => e?.source === "sefaz");
  const orders = evidence.filter((e) => e?.source === "erp_compras");
  // Nenhum dos dois motivos: o fio veio diferente do que o domínio escreve. O genérico mostra como veio.
  if (titles.length === 0 && orders.length === 0) return <GenericEvidence divergence={divergence} />;
  const description =
    titles.length > 0
      ? `Evidência: nota ${POSTED_TITLE.exec(titles[0]!.description ?? "")?.[1] ?? titles[0]!.reference} já lançada`
      : "Evidência: duplicidade suspeita, a ordem de compra não tem saldo";
  return (
    <Panel title={divergence.exceptionName} description={description} size="sm" padding="md">
      {titles.map((title, index) => (
        <PostedTitle key={`${title.reference}-${index}`} title={title} invoice={invoice} />
      ))}
      {orders.length > 0 ? (
        <DataList
          divided
          aria-label="Ordem sem saldo"
          items={orders.map((order, index) => ({
            key: `${order.reference}-${index}`,
            label: sourceLabel("erp_compras"),
            value: (
              <>
                {order.description} <code>{order.reference}</code>
              </>
            ),
          }))}
        />
      ) : null}
    </Panel>
  );
}

registerEvidence("E6", DuplicidadeEvidence);
