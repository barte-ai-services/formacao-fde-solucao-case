import { DataList, Panel, ReconciliationDiff } from "@barte-ai-services/barte-ui-kit";
import type { EvidenceDto } from "../api/contract";
import { GenericEvidence } from "./GenericEvidence";
import { registerEvidence, type EvidenceProps } from "./registry";

/** #64: o pagamento vinculado, lido da evidência do banco que o `checkPagoForaDoFluxo` escreve. */
export interface LinkedPayment {
  id: string;
  amount: string;
  paidOn: string;
  method: string;
  origin: string;
}

// #64: o formato é o de `describeLink` em api/src/domain/checks/e7-pago-fora-do-fluxo.ts; mudou lá, muda aqui.
const LINK = /^Pagamento (\S+) de (R\$\s[\d.,]+) em (\d{4}-\d{2}-\d{2}), por (.+?) \((.+)\), sem título/;

/** #64: o pagamento da evidência do banco, ou `null` quando ela não veio no formato do E7. */
export function linkedPayment(evidence: readonly EvidenceDto[]): LinkedPayment | null {
  const bank = evidence.find((e) => e?.source === "banco");
  const match = LINK.exec(String(bank?.description ?? ""));
  if (!bank || !match) return null;
  const [, id, amount, paidOn, method, origin] = match;
  return { id: bank.reference || id!, amount: amount!, paidOn: paidOn!, method: method!, origin: origin! };
}

const brDate = (iso: string): string => iso.split("-").reverse().join("/");

/**
 * E7 · Pago fora do fluxo (#33/AC-5). Mostra o pagamento a que a nota ficou vinculada: a loja já pagou
 * no banco, sem título, e um título novo pagaria duas vezes. Sem a evidência no formato, cai no genérico.
 */
function PagoForaDoFluxoEvidence({ divergence }: EvidenceProps) {
  const payment = linkedPayment(Array.isArray(divergence.evidence) ? divergence.evidence : []);
  if (!payment) return <GenericEvidence divergence={divergence} />;
  return (
    <Panel
      title={divergence.exceptionName}
      description={`Evidência: pagamento fora do fluxo ${payment.id}. A loja já pagou esta compra no banco, sem título.`}
      size="sm"
      padding="md"
    >
      <ReconciliationDiff
        columns={["Banco · pagamento", "Nota fiscal"]}
        ariaLabel="Pagamento vinculado e nota"
        variant="grid"
        showSummary
        fields={[
          { label: "Pagamento", a: "feito pela loja", b: "título novo", state: "divergent", note: "pagaria duas vezes" },
          { label: "Valor", a: payment.amount, b: payment.amount, state: "match", note: "mesmo valor, ao centavo" },
        ]}
      />
      <DataList
        divided
        aria-label="Pagamento vinculado"
        items={[
          { key: "id", label: "Pagamento", value: <code>{payment.id}</code> },
          { key: "data", label: "Pago em", value: brDate(payment.paidOn) },
          { key: "forma", label: "Forma", value: payment.method },
          { key: "origem", label: "Origem", value: payment.origin },
        ]}
      />
    </Panel>
  );
}

registerEvidence("E7", PagoForaDoFluxoEvidence);
