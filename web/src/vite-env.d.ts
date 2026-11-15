/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Onde o Shell atende. Sem ele, a moldura usa o contexto fixo (src/shell/context.ts). */
  readonly VITE_SHELL_URL?: string;
}

// As folhas de estilo dos kits: só efeito colateral, sem tipos.
declare module "barte-design-system/styles";
declare module "@barte-ai-services/barte-ui-kit/styles";
