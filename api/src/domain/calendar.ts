import { DomainError } from './errors.js';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** #10: lê AAAA-MM-DD como dia UTC; recusa o que não é data do calendário (como 2026-02-30). */
export function parseIsoDate(date: string): Date {
  const match = ISO_DATE.exec(date);
  const parsed = match === null ? null : new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (parsed === null || parsed.toISOString().slice(0, 10) !== date) {
    throw new DomainError('Calendário: a data deve ser AAAA-MM-DD e existir');
  }
  return parsed;
}

/** #10: a data como o e-mail a escreve, DD/MM/AAAA. */
export function formatBrazilianDate(date: string): string {
  const [year, month, day] = parseIsoDate(date).toISOString().slice(0, 10).split('-');
  return `${day}/${month}/${year}`;
}

/**
 * #10/AC-4: soma `days` dias úteis a `date`, pulando sábado e domingo. Não há calendário de feriados:
 * um feriado conta como dia útil, limitação conhecida do prazo padrão.
 */
export function addBusinessDays(date: string, days: number): string {
  if (!Number.isSafeInteger(days) || days < 0) {
    throw new DomainError('Calendário: os dias úteis devem ser um inteiro não negativo');
  }
  let current = parseIsoDate(date);
  let remaining = days;
  while (remaining > 0) {
    current = new Date(current.getTime() + DAY_MS);
    const weekday = current.getUTCDay();
    if (weekday !== 0 && weekday !== 6) remaining -= 1;
  }
  return current.toISOString().slice(0, 10);
}
