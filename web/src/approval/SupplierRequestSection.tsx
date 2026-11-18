import type { JSX } from "react";
import { SupplierRequestBlock } from "./SupplierRequestBlock";
import type { SupplierRequestPort } from "./supplier-request-state";
import { useSupplierRequest } from "./useSupplierRequest";

/** #3 O que a gaveta recebe para mostrar o pedido: as chamadas (#17), quem olha e, se preciso, o intervalo da consulta. */
export interface SupplierRequestSource {
  port: SupplierRequestPort;
  /** #3/AC-4 Quem está na gaveta, para o "por você". */
  viewer: string;
  pollMs?: number;
}

/** #3/AC-1 O bloco ligado ao estado (#16): busca o pedido da nota e não desenha nada quando não há. */
export function SupplierRequestSection({ source, accessKey }: { source: SupplierRequestSource; accessKey: string }): JSX.Element | null {
  const handlers = useSupplierRequest(source.port, accessKey, source.pollMs);
  return <SupplierRequestBlock {...handlers} viewer={source.viewer} />;
}
