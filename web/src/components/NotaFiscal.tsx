import type { CSSProperties, ReactNode } from "react";
import { Text } from "barte-design-system";
import { formatIsoDate } from "@barte-ai-services/barte-ui-kit";

/** O número da nota: rosa e sublinhado, com ou sem clique, para a nota ter uma cara só em toda grid. */
const NUMERO: CSSProperties = {
  color: "var(--content-brand)",
  textDecoration: "underline",
};

/** O número como botão: alcançável pelo teclado, sem a moldura do botão do navegador. */
const NUMERO_BOTAO: CSSProperties = {
  ...NUMERO,
  background: "none",
  border: 0,
  padding: 0,
  font: "inherit",
  cursor: "pointer",
};

export interface NotaFiscalProps {
  number: string;
  /** Data de emissão em ISO; aparece depois do número, em tinta. */
  issuedOn?: string;
  /** A segunda linha, cinza: o contexto da nota na grid (fornecedor, valor, situação). */
  bottom?: ReactNode;
  /** Algo que vem antes do número, como o cadeado de quem não pode aprovar. */
  prefix?: ReactNode;
  /** Quando a grid abre a nota pelo número, o número vira botão; o clique não chega à linha. */
  onOpen?: () => void;
  /** O rótulo do botão para leitor de tela. */
  openLabel?: string;
}

/** A célula da nota fiscal das grids: "NF <número> · <data>" em cima, o contexto cinza embaixo. */
export function NotaFiscal({ number, issuedOn, bottom, prefix, onOpen, openLabel }: NotaFiscalProps) {
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
              // A linha também abre no clique do mouse: o botão não deixa abrir duas vezes.
              event.stopPropagation();
              onOpen();
            }}
            style={NUMERO_BOTAO}
          >
            {label}
          </button>
        ) : (
          <span style={NUMERO}>{label}</span>
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
