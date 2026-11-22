/**
 * A tabela das rotas: um caminho, um arquivo. Cada história preenche o arquivo da sua rota e não
 * precisa tocar nesta tabela, a não ser para criar uma rota nova.
 */
import Devolucoes from "./devolucoes";
import AoVivo from "./ao-vivo";
import Doca from "./doca";
import NotasDuplicadas from "./duplicadas";
import FilaDeAprovacao from "./fila";
import Recebimento from "./recebimento-loja";
import ListaDoDia from "./lista-do-dia";
import SupplierRequestsRoute from "./supplier-requests";
import Proposta from "./proposta";
import ValorBarrado from "./valor-barrado";
import type { RouteDefinition } from "./types";

export type { RouteDefinition, RouteProps } from "./types";

export const HOME = "/pagar/fila";

export const ROUTES: readonly RouteDefinition[] = [
  { path: "/pagar/fila", component: FilaDeAprovacao },
  { path: "/pagar/fila/:id", component: Proposta },
  { path: "/pagar/hoje", component: ListaDoDia },
  { path: "/pagar/duplicadas", component: NotasDuplicadas },
  { path: "/pagar/ao-vivo", component: AoVivo },
  { path: "/pagar/valor-barrado", component: ValorBarrado },
  { path: "/doca", component: Doca },
  { path: "/devolucoes", component: Devolucoes },
  { path: "/pedidos-fornecedor", component: SupplierRequestsRoute }, // ADR-004
  { path: "/recebimento/loja", component: Recebimento },
];

/** Caminhos que só levam a outro. */
export const REDIRECTS: Readonly<Record<string, string>> = { "/": HOME };
