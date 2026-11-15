import type { ComponentType } from "react";
import type { RouteParams } from "../router";

/** O que toda rota recebe: os parâmetros do caminho (`:id` em `/pagar/fila/:id`). */
export interface RouteProps {
  params: RouteParams;
}

export interface RouteDefinition {
  /** O padrão do caminho, com `:nome` para cada parâmetro. */
  path: string;
  component: ComponentType<RouteProps>;
}
