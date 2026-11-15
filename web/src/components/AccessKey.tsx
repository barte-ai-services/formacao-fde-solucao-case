import { useState, type JSX } from "react";

/**
 * #129 A chave de acesso de 44 dígitos numa linha só, sem reticências. No celular, onde a gaveta não
 * a comporta, o botão de copiar aparece (a regra está em app.css).
 */
export function AccessKey({ value }: { value: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Sem permissão de área de transferência: a chave segue legível e selecionável na tela.
    }
  }
  return (
    <span className="pagar-access-key">
      <code className="pagar-access-key__value">{value}</code>
      <button type="button" className="pagar-access-key__copy" onClick={copy}>
        {copied ? "Chave copiada" : "Copiar chave"}
      </button>
    </span>
  );
}
