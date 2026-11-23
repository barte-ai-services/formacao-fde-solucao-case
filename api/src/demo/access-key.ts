// Chave de acesso de 44 dígitos das notas geradas (#349). Fictícia: o CNPJ do catálogo tem dígito verificador inválido de propósito.

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

export type AccessKeyParts = {
  readonly cnpjDigits: string;
  /** Data de emissão, YYYY-MM-DD. (#349) */
  readonly issuedOn: string;
  readonly series: number;
  readonly number: number;
  /** Código numérico de 8 dígitos: é ele que torna a chave única por construção. (#349) */
  readonly code: number;
};

/** UF 35 + AAMM + CNPJ + modelo 55 + série + número + tipo de emissão 1 + código + dígito (soma dos dígitos módulo 10, como na base). (#349) */
export function accessKeyOf(parts: AccessKeyParts): string {
  const yymm = `${parts.issuedOn.slice(2, 4)}${parts.issuedOn.slice(5, 7)}`;
  const body = `35${yymm}${parts.cnpjDigits}55${pad(parts.series, 3)}${pad(parts.number, 9)}1${pad(parts.code, 8)}`;
  const check = [...body].reduce((sum, digit) => sum + Number(digit), 0) % 10;
  return `${body}${check}`;
}

export const CODE_SPACE = 100_000_000;

/** Entrega chaves que nem a base, nem o lote já usam: o código sobe até a chave inteira ficar livre. (#349) */
export class KeyAllocator {
  private readonly used: Set<string>;

  constructor(taken: ReadonlySet<string> = new Set()) {
    this.used = new Set(taken);
  }

  allocate(parts: Omit<AccessKeyParts, 'code'>, code: number): string {
    for (let attempt = 0; attempt < CODE_SPACE; attempt += 1) {
      const key = accessKeyOf({ ...parts, code: (code + attempt * 7919) % CODE_SPACE });
      if (!this.used.has(key)) {
        this.used.add(key);
        return key;
      }
    }
    throw new RangeError('KeyAllocator: sem chave livre');
  }
}
