// #65 Tipos mínimos do Node que o eval usa; o tsconfig só traz os do Worker.
declare module 'node:fs' {
  export function existsSync(path: URL | string): boolean;
  export function readFileSync(path: URL | string, encoding: 'utf8'): string;
  export function writeFileSync(path: URL | string, data: string): void;
  export function mkdirSync(path: URL | string, options: { recursive: true }): void;
}

declare module 'node:process' {
  export const env: Record<string, string | undefined>;
}

interface ImportMeta {
  readonly url: string;
}
