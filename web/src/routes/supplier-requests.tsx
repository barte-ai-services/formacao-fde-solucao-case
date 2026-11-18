import { useMemo, useRef, useState, type ReactElement } from "react";
import type { SentRequestDetailDto } from "../api/contract";
import { ConfirmRereadFailed, saveFailureOf, supplierReplyApi, supplierReplyReason, type SupplierReplyApi, type SupplierReplyReason } from "../api/supplier-reply";
import { InvoiceDrawer } from "../approval/InvoiceDrawer";
import { SupplierRequests, type DrawerShell } from "../components/SupplierRequests";
import {
  conversationOf,
  countsOf,
  draftOf,
  FILTER_OF_CHIP,
  isEmptyList,
  rereadOf,
  rowsOf,
  sendResultOf,
  todayInSaoPaulo,
} from "../components/supplier-request-map";
import { INITIAL_STATE, type ConfirmResult, type SaveResult, type SendResult } from "../components/supplier-request-state";
import type { SupplierFilter, SupplierFilterValue, SupplierRequestRow } from "../components/supplier-request-view";
import { useLoad } from "../components/useLoad";
import { useRequestDetail } from "../components/useRequestDetail";
import { texts } from "../texts";
import type { RouteProps } from "./types";

/** #21 O que a lista leu do servidor: as linhas do filtro, as contagens dos quatro chips e a chave de acesso de cada linha (a gaveta a usa). */
export interface Loaded {
  rows: SupplierRequestRow[];
  counts: Record<SupplierFilter, number>;
  accessKeys: Record<string, string>;
  empty: boolean;
}

/** #5/AC-2 Um chip é um filtro do servidor; "Ver todos" lê os quatro, que não se repetem: cada pedido cai em um só. */
export async function loadList(filter: SupplierFilterValue, signal: AbortSignal, api: Pick<SupplierReplyApi, "list"> = supplierReplyApi): Promise<Loaded> {
  const wanted = filter === "all" ? Object.values(FILTER_OF_CHIP) : [FILTER_OF_CHIP[filter]];
  const lists = await Promise.all(wanted.map((wantedFilter) => api.list(wantedFilter, signal)));
  const [first] = lists;
  if (first === undefined) throw new Error("nenhum filtro pedido");
  return {
    rows: lists.flatMap(rowsOf),
    counts: countsOf(first),
    accessKeys: Object.fromEntries(lists.flatMap((list) => list.requests.map((request) => [String(request.id), request.invoiceAccessKey] as const))),
    empty: isEmptyList(first),
  };
}

/** #5/AC-4 Envia a cobrança da linha de chave `accessKey`; sem chave não há o que enviar, e o envio não sai. */
export async function sendOf(accessKey: string | null, api: Pick<SupplierReplyApi, "sendFollowUp"> = supplierReplyApi): Promise<SentRequestDetailDto> {
  if (accessKey === null) throw new Error("linha sem chave de acesso");
  return api.sendFollowUp(accessKey);
}

/** #59 O resultado de salvar a edição da cobrança: o resultado fechado e o pedido que o servidor devolveu (salvo, ou relido num conflito), para a gaveta mostrar o texto dele. */
export interface SaveOutcome {
  result: SaveResult;
  reread: SentRequestDetailDto | null;
}

/** #59/AC-2 Salva o molde da linha de chave `accessKey` pelo PATCH; o erro vira o motivo fechado (422 `invalid`, 409 `conflict`) e o texto dele não sai daqui. */
export async function saveOf(accessKey: string | null, template: string, api: Pick<SupplierReplyApi, "saveFollowUp"> = supplierReplyApi): Promise<SaveOutcome> {
  if (accessKey === null) return { result: { ok: false, failure: "unknown" }, reread: null };
  try {
    const saved = await api.saveFollowUp(accessKey, template);
    return saved.kind === "saved" ? { result: { ok: true }, reread: saved.detail } : { result: { ok: false, failure: "conflict" }, reread: saved.detail };
  } catch (error) {
    return { result: { ok: false, failure: saveFailureOf(error) }, reread: null };
  }
}

/** #64 O resultado de confirmar o documento: o resultado fechado e o pedido que o servidor devolveu (confirmado, ou relido num conflito), para a gaveta mostrar o estado dele. */
export interface ConfirmOutcome {
  result: ConfirmResult;
  reread: SentRequestDetailDto | null;
}

/**
 * #64/AC-2 Confirma o documento citado da linha de chave `accessKey` pelo POST; o erro vira o motivo fechado (só o status decide) e o texto dele não sai daqui.
 * #64/AC-3 Um 409 que traz o pedido já confirmado (já confirmado, a primeira confirmação fica) vale como confirmado; um 409 sem a confirmação (o pedido mudou) é o conflito, com o pedido relido.
 */
export async function confirmOf(accessKey: string | null, api: Pick<SupplierReplyApi, "confirmDocument"> = supplierReplyApi): Promise<ConfirmOutcome> {
  if (accessKey === null) return { result: { ok: false, failure: "unknown" }, reread: null };
  try {
    const { kind, detail } = await api.confirmDocument(accessKey);
    return kind === "confirmed" || detail.documentConfirmation !== null ? { result: { ok: true }, reread: detail } : { result: { ok: false, failure: "conflict" }, reread: detail };
  } catch (error) {
    // #64 O 409 cuja releitura falhou: o motivo fechado do 409 decide a mensagem, e nenhuma afirma "não foi confirmado" sem saber.
    if (error instanceof ConfirmRereadFailed) return { result: { ok: false, failure: error.reason === "already_confirmed" ? "alreadyConfirmed" : "conflictUnread" }, reread: null };
    return { result: { ok: false, failure: supplierReplyReason(error) }, reread: null };
  }
}

const drawerError = (reason: SupplierReplyReason | null): string => texts.supplierRequests.drawer.errors[reason ?? "unknown"];

/** #5/AC-3 ADR-004 /pedidos-fornecedor: os pedidos ao fornecedor com a leitura da resposta (#4); a gaveta abre no bloco do pedido e "Cobrar" abre o rascunho para revisar e enviar. */
export default function SupplierRequestsRoute(_props: RouteProps): ReactElement {
  const [filter, setFilter] = useState<SupplierFilterValue>(INITIAL_STATE.filter);
  const { state, data, retry } = useLoad((signal) => loadList(filter, signal), (loaded) => loaded.empty);
  const [openId, setOpenId] = useState<string | null>(null);
  // #5/AC-4 O pedido que um envio não concluído releu (409): a gaveta mostra a leitura nova, em vez da de antes do envio.
  const [reread, setReread] = useState<SentRequestDetailDto | null>(null);
  // #64/AC-3 Relida a lista depois de confirmar, o pedido confirmado já não vem no filtro e a gaveta dele segue aberta: a chave de cada linha vista fica guardada.
  const seenKeys = useRef<Record<string, string>>({});
  if (data) Object.assign(seenKeys.current, data.accessKeys);
  const keyOf = (id: string): string | null => data?.accessKeys[id] ?? seenKeys.current[id] ?? null;
  const open = useRequestDetail(openId === null ? null : keyOf(openId), supplierReplyApi.detail);
  const today = useMemo(() => todayInSaoPaulo(), []);

  /** #21 O pedido lido só vale para a linha de que veio: trocando de linha, a gaveta espera o pedido da nova. */
  const detailOf = (row: SupplierRequestRow) => {
    const fresh = reread && reread.invoiceAccessKey === keyOf(row.id) ? reread : open.detail;
    return fresh && fresh.invoiceAccessKey === keyOf(row.id) ? fresh : undefined;
  };

  /** #5/AC-4 Abrir outra linha, ou fechar, larga o pedido relido: a gaveta que abre de novo lê o pedido da API. */
  const changeOpen = (id: string | null): void => {
    setReread(null);
    setOpenId(id);
  };

  const choose = (value: SupplierFilterValue): void => {
    setFilter(value);
    retry();
  };

  const send = async (row: SupplierRequestRow): Promise<SendResult> => {
    const detail = await sendOf(keyOf(row.id));
    setReread(rereadOf(detail));
    return sendResultOf(detail);
  };

  const save = async (row: SupplierRequestRow, template: string): Promise<SaveResult> => {
    const outcome = await saveOf(keyOf(row.id), template);
    if (outcome.reread) setReread(outcome.reread);
    return outcome.result;
  };

  /** #64/AC-3 Confirma e, feita, relê a lista: o pedido sai de "Precisam de você", entra em "Atendidos" e as contagens são as do servidor. Em conflito a lista também se relê. */
  const confirm = async (row: SupplierRequestRow): Promise<ConfirmResult> => {
    const outcome = await confirmOf(keyOf(row.id));
    if (outcome.reread) setReread(outcome.reread);
    if (outcome.reread) retry();
    return outcome.result;
  };

  // #21 A gaveta da nota (#209), a mesma das outras grids: a proposta da #3 e o bloco "Pedido ao fornecedor" dela vêm dali, e o bloco desta tela entra acima.
  const shell: DrawerShell = ({ row, title, onClose, children }) => (
    <InvoiceDrawer key={row.id} invoiceAccessKey={keyOf(row.id) ?? ""} title={() => title} onClose={onClose}>
      {children}
    </InvoiceDrawer>
  );

  return (
    <SupplierRequests
      state={state}
      rows={data?.rows ?? []}
      counts={data?.counts}
      onFilterChange={choose}
      onRetry={retry}
      conversationOf={(row) => {
        const detail = detailOf(row);
        return detail ? conversationOf(row, detail, today) : null;
      }}
      draftOf={(row) => {
        const detail = detailOf(row);
        return detail ? draftOf(detail) : null;
      }}
      send={send}
      saveDraft={save}
      confirmDocument={confirm}
      drawerState={open.state}
      drawerError={drawerError(open.reason)}
      onDrawerRetry={open.retry}
      onDrawerChange={changeOpen}
      editableDraft
      renderDrawer={shell}
    />
  );
}
