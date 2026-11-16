import type { JSX } from "react";

/** #231 O modelo de visão do bloco "Agente auditor": a camada de estado o deriva da auditoria; o bloco só o desenha. */
export type AuditBlockView =
  | { kind: "pending" }
  | { kind: "not-audited"; reason: string }
  | {
      kind: "audited";
      tone: "positive" | "alert";
      verdict: string;
      raised?: string | null;
      injection?: string | null;
      justification: string;
      footer: string;
    };

/** #231 Esqueleto do componente: ainda não desenha o bloco (os testes da camada falham por isso). */
export function AuditBlock(_props: { view: AuditBlockView }): JSX.Element {
  return <></>;
}
