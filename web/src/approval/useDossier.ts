// #130 O dossiê da gaveta: pedir ao Claude e ler a proposta de novo enquanto ele escreve.
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client";
import { approvalApi } from "../api/approval";
import type { DossierGeneratingDto, ProposalDossierDto } from "../api/contract";
import { texts } from "../texts";

/** #130 De quanto em quanto tempo a gaveta lê a proposta de novo enquanto o status é `generating`. */
export const DOSSIER_POLL_MS = 3_000;
/** #130 Teto da espera: a geração tem prazo de 20 s no Worker; passado isto, a gaveta para de ler. */
export const DOSSIER_POLL_LIMIT_MS = 90_000;

export interface DossierState {
  /** #130 O que a gaveta mostra: Gerando, ou o dossiê pronto anterior durante "Gerar de novo" (AC-4). */
  dossier: ProposalDossierDto | null | undefined;
  /** #130 AC-4 Uma versão nova está sendo escrita por cima de um dossiê pronto. */
  renewing: boolean;
  /** #130 O aviso do 409, do 429, de outra recusa do pedido ou da versão nova que falhou. */
  message: string | null;
  busy: boolean;
  request: () => Promise<void>;
}

/** #130 O texto da recusa do pedido, em português para quem decide. */
export function requestError(reason: unknown): string {
  if (reason instanceof ApiError && reason.status === 409) return texts.dossier.request.inFlight;
  if (reason instanceof ApiError && reason.status === 429) return texts.dossier.request.limit;
  return texts.dossier.request.other;
}

/** #130 Horário ISO em milissegundos. O Postgres manda `+00:00` com microssegundos; o Worker, `Z`: texto não compara. */
const at = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : Number.NaN);

export function useDossier(accessKey: string, initial: ProposalDossierDto | null | undefined): DossierState {
  const [dossier, setDossier] = useState(initial?.status === "generating" ? null : initial);
  const [generating, setGenerating] = useState<DossierGeneratingDto | null>(initial?.status === "generating" ? initial : null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // #130 AC-4: quando o pedido foi aceito, para saber se o dossiê pronto que voltou é o novo ou o anterior.
  const since = useRef<string | null>(null);
  // #130 O pedido em voo: o segundo clique, antes do re-render, não sai.
  const inFlight = useRef(false);

  // #130 A gaveta trocou de proposta (ou a proposta foi relida): começa do que veio.
  useEffect(() => {
    setDossier(initial?.status === "generating" ? null : initial);
    setGenerating(initial?.status === "generating" ? initial : null);
    setMessage(null);
    since.current = null;
  }, [accessKey, initial]);

  const polling = generating !== null;
  useEffect(() => {
    if (!polling) return;
    const controller = new AbortController();
    const deadline = Date.now() + DOSSIER_POLL_LIMIT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // #130 Por que a espera acabou: o dossiê voltou (pronto ou falho) ou o teto chegou com o Claude ainda escrevendo.
    const stop = (why: "done" | "timeout") => {
      // #130 No teto, a gaveta não volta calada para "Pedir ao Claude": fica em Gerando, com o aviso.
      if (why === "timeout") {
        setMessage(texts.dossier.renewTimedOut);
        return;
      }
      setGenerating(null);
      since.current = null;
    };
    // #130 O prazo vale antes de toda nova leitura, inclusive quando a API segue devolvendo `generating`.
    const again = () => {
      if (Date.now() + DOSSIER_POLL_MS > deadline) stop("timeout");
      else timer = setTimeout(tick, DOSSIER_POLL_MS);
    };
    const tick = async () => {
      try {
        const next = (await approvalApi.proposal(accessKey, controller.signal)).dossier;
        if (controller.signal.aborted) return;
        if (next?.status === "generating") {
          setGenerating(next);
          again();
          return;
        }
        // #130 AC-4 Parou de gerar e o pronto é mais velho que o pedido: a versão nova falhou, a anterior fica.
        const requested = since.current;
        const failedRenew = requested !== null && next?.status === "ready" && at(next.generatedAt) < at(requested);
        setDossier(next);
        setMessage(failedRenew ? texts.dossier.renewFailed : null);
        stop("done");
      } catch {
        // #130 Uma leitura que falhou não encerra a espera; o teto é que encerra.
        if (!controller.signal.aborted) again();
      }
    };
    again();
    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [polling, accessKey]);

  const request = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const started = await approvalApi.requestDossier(accessKey);
      since.current = started.requestedAt;
      setGenerating(started);
    } catch (reason) {
      setMessage(requestError(reason));
      // #130 409: o Claude já está escrevendo; a gaveta fica em Gerando, sem apagar um Gerando que já tem quem e quando.
      if (reason instanceof ApiError && reason.status === 409) {
        setGenerating((current) => current ?? { status: "generating", trigger: "on_demand", requestedBy: "", requestedAt: "" });
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [accessKey]);

  // #130 AC-4 Com um dossiê pronto na tela, a versão nova é escrita por trás: o pronto fica até o novo chegar.
  const renewing = generating !== null && dossier?.status === "ready";
  return { dossier: renewing ? dossier : (generating ?? dossier), renewing, message, busy, request };
}
