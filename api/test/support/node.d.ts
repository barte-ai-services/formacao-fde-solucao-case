// #59 Tipos mínimos do Node que os testes usam para ler data/kit/*.json; o tsconfig só traz os do Worker.
declare module 'node:fs' {
  export function readFileSync(path: URL | string, encoding: 'utf8'): string;
  /** #311 O teste da migração lista supabase/migrations. */
  export function readdirSync(path: URL | string): string[];
  /** #35 O eval do casamento por descrição grava o resumo com EVAL_WRITE=1. */
  export function writeFileSync(path: URL | string, data: string): void;
}

interface ImportMeta {
  readonly url: string;
}
