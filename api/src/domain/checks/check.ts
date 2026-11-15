import type { Classification } from '../classification.js';
import type { CheckContext } from '../context.js';
import type { Divergence } from '../divergence.js';
import type { Invoice } from '../invoice.js';

/** Uma verificação da conferência: pura, síncrona, sem I/O. Lê a nota e o contexto. */
export type Check = (invoice: Invoice, ctx: CheckContext) => readonly Divergence[];

export type NamedCheck = { readonly id: Classification; readonly run: Check };
