// #59 Tipos mínimos do Node que os testes usam para ler data/kit/*.json; o tsconfig só traz os do Worker.
declare module 'node:fs' {
  export function readFileSync(path: URL | string, encoding: 'utf8'): string;
}

interface ImportMeta {
  readonly url: string;
}
