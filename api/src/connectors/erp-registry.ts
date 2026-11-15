// Conector ERP Cadastro: fornecedores (kit_fornecedores) e produtos (kit_produtos) (#59).
import type { Product, Supplier } from '../domain/index.js';
import { money, unit, type KitFornecedor, type KitProduto } from './kit-rows.js';
import type { RegistryPort } from './ports.js';
import type { SupabaseRest } from './supabase-rest.js';

export class ErpRegistryConnector implements RegistryPort {
  constructor(private readonly rest: SupabaseRest) {}

  async listSuppliers(): Promise<Supplier[]> {
    const rows = await this.rest.select<KitFornecedor>('kit_fornecedores', { order: 'fornecedor_id' });
    return rows.map((f) => ({
      id: f.fornecedor_id,
      legalName: f.razao_social,
      cnpj: f.cnpj,
      paymentBlocked: f.bloqueado,
      blockReason: f.motivo_bloqueio,
    }));
  }

  async listProducts(): Promise<Product[]> {
    const rows = await this.rest.select<KitProduto>('kit_produtos', { order: 'sku' });
    return rows.map((p) => ({
      sku: p.sku,
      description: p.descricao,
      supplierId: p.fornecedor_id,
      supplierCode: p.codigo_fornecedor,
      baseUnit: unit(p.unidade_base),
      boxFactor: p.fator_caixa,
      referenceUnitPrice: money(p.preco_referencia_un),
    }));
  }
}
