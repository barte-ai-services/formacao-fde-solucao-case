// Monta os conectores do Supabase a partir de um cliente PostgREST (#59), para o Cron e os testes.
import type { CaptureDeps } from '../cron/capture.js';
import { BankConnector } from './bank.js';
import { registryCorrectionOutbox } from './registry-correction.js';
import { ErpRegistryConnector } from './erp-registry.js';
import { ErpPurchasingConnector } from './erp-purchasing.js';
import { ErpPayablesConnector } from './erp-payables.js';
import { erpReturnNoteOutbox } from './erp-return-note.js';
import { SupabaseInvoiceStore } from './invoice-store.js';
import { SefazConnector } from './sefaz.js';
import type { SupabaseRest } from './supabase-rest.js';
import { wmsDockActionOutbox } from './wms-dock-action.js';
import { WmsCountConnector } from './wms-count.js';

export function supabaseConnectors(rest: SupabaseRest) {
  const captureDeps: CaptureDeps = {
    sefaz: new SefazConnector(rest),
    purchasing: new ErpPurchasingConnector(rest),
    payables: new ErpPayablesConnector(rest),
    registry: new ErpRegistryConnector(rest),
    bank: new BankConnector(rest),
    wms: new WmsCountConnector(rest),
    invoices: new SupabaseInvoiceStore(rest),
  };
  return {
    captureDeps,
    dockActions: wmsDockActionOutbox(rest),
    registryCorrections: registryCorrectionOutbox(rest),
    returnNotes: erpReturnNoteOutbox(rest),
  };
}
