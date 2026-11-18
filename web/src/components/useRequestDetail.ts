import { useCallback, useEffect, useState } from "react";
import type { LoadState } from "@barte-ai-services/barte-ui-kit";
import type { SentRequestDetailDto } from "../api/contract";
import { supplierReplyReason, type SupplierReplyReason } from "../api/supplier-reply";

export interface RequestDetail {
  /** #21 `ready` só quando o pedido carregado é o da chave pedida; trocando de linha, volta a `loading`. */
  state: LoadState;
  detail: SentRequestDetailDto | undefined;
  /** #21 O motivo fechado da falha (nunca o erro em si), em `error`. */
  reason: SupplierReplyReason | null;
  retry: () => void;
}

interface Settled {
  key: string;
  detail: SentRequestDetailDto | undefined;
  reason: SupplierReplyReason | null;
}

/**
 * #21 Lê o pedido enviado da gaveta (`GET /api/supplier-requests/{accessKey}`) sempre que a chave muda; sem chave, nada.
 * Uma resposta que chega depois de a gaveta trocar de linha ou fechar é descartada (o sinal cancela a leitura que ficou para trás).
 */
export function useRequestDetail(accessKey: string | null, load: (accessKey: string, signal: AbortSignal) => Promise<SentRequestDetailDto>): RequestDetail {
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<Settled | null>(null);

  useEffect(() => {
    if (accessKey === null) {
      setSettled(null);
      return undefined;
    }
    const controller = new AbortController();
    load(accessKey, controller.signal)
      .then((detail) => {
        if (!controller.signal.aborted) setSettled({ key: accessKey, detail, reason: null });
      })
      // #21 Só o motivo fechado fica: o erro em si, com o corpo da resposta, não é guardado nem mostrado (layer-exposure).
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setSettled({ key: accessKey, detail: undefined, reason: supplierReplyReason(error) });
      });
    return () => controller.abort();
    // #21 `load` é estável (o fio da API): a leitura se refaz só com a chave ou com o "Tentar de novo".
  }, [accessKey, attempt]);

  const retry = useCallback(() => {
    setSettled(null);
    setAttempt((n) => n + 1);
  }, []);

  if (accessKey === null || settled === null || settled.key !== accessKey) return { state: "loading", detail: undefined, reason: null, retry };
  if (settled.detail === undefined) return { state: "error", detail: undefined, reason: settled.reason, retry };
  return { state: "ready", detail: settled.detail, reason: null, retry };
}
