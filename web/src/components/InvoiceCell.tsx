import type { CSSProperties, ReactElement, ReactNode } from "react";
import { Text } from "barte-design-system";
import { formatIsoDate } from "@barte-ai-services/barte-ui-kit";

/** #190: o número da nota: rosa e sublinhado, com ou sem clique, para a nota ter uma cara só em toda grid. */
const NUMBER_STYLE: CSSProperties = {
  color: "var(--content-brand)",
  textDecoration: "underline",
};

/** #190: o número como botão: alcançável pelo teclado, sem a moldura do botão do navegador. */
const NUMBER_BUTTON_STYLE: CSSProperties = {
  ...NUMBER_STYLE,
  background: "none",
  border: 0,
  padding: 0,
  font: "inherit",
  cursor: "pointer",
};

export interface InvoiceCellProps {
  number: string;
  /** #190: data de emissão em ISO; aparece depois do número, em tinta. */
  issuedOn?: string;
  /** #190: a segunda linha, cinza: o contexto da nota na grid (fornecedor, valor, situação). */
  bottom?: ReactNode;
  /** #190: algo que vem antes do número, como o cadeado de quem não pode aprovar. */
  prefix?: ReactNode;
  /** #190: quando a grid abre a nota pelo número, o número vira botão; o clique não chega à linha. */
  onOpen?: () => void;
  /** #190: o rótulo do botão para leitor de tela. */
  openLabel?: string;
}

/** A célula da nota fiscal das grids: "NF <número> · <data>" em cima, o contexto cinza embaixo. O nome `InvoiceCell` vem da issue #190. */
export function InvoiceCell({ number, issuedOn, bottom, prefix, onOpen, openLabel }: InvoiceCellProps): ReactElement {
  const label = `NF ${number}`;
  return (
    <span style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-2xs)" }}>
      <Text as="span" variant="body-xs" color="var(--content-primary)">
        {prefix}
        {onOpen ? (
          <button
            type="button"
            aria-label={openLabel}
            onClick={(event) => {
              // #190: a linha também abre no clique do mouse: o botão não deixa abrir duas vezes.
              event.stopPropagation();
              onOpen();
            }}
            style={NUMBER_BUTTON_STYLE}
          >
            {label}
          </button>
        ) : (
          <span style={NUMBER_STYLE}>{label}</span>
        )}
        {issuedOn ? ` · ${formatIsoDate(issuedOn)}` : null}
      </Text>
      {bottom === undefined ? null : (
        <Text as="span" variant="caption-sm" color="var(--content-tertiary)">
          {bottom}
        </Text>
      )}
    </span>
  );
}
