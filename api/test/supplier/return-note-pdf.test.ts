import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { issueReturnNote } from '../../src/domain/index.js';
import { toKitNote } from '../../src/supplier/kit-note.js';
import { returnNotePdf } from '../../src/supplier/return-note-pdf.js';
import { returnNote } from '../domain/supplier-request-fixtures.js';

// #57: testes da função pura que desenha a nota de devolução em PDF (api/src/supplier/return-note-pdf.ts), chamada direto.

const kit = () => toKitNote(issueReturnNote(returnNote(), { sequence: 101, issuedOn: '2026-11-12' }));

/** #57: os textos desenhados no PDF: o conteúdo de cada operador `(...) Tj`, com o escape do PDF desfeito. */
const shown = (pdf: string): string[] =>
  [...pdf.matchAll(/\((?:\\.|[^\\)])*\) Tj/g)].map((m) =>
    m[0]
      .slice(1, -4)
      .replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)))
      .replace(/\\(.)/g, '$1'),
  );

const reais = (value: number): string => `R$ ${value.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;

describe('#57/AC-3 o PDF traz a nota no formato do kit, com os valores do JSON', () => { // ADR-002
  it('#57/AC-3: o cabeçalho traz ND-n, chave, série, emitente, fornecedor e nota referenciada', () => { // ADR-002
    const note = kit();
    const text = shown(returnNotePdf(note)).join('\n');
    expect(text).toContain(note.nota_id);
    expect(text).toContain(note.chave);
    expect(text).toContain(`série ${note.serie}`);
    expect(text).toContain(note.emitente.nome);
    expect(text).toContain(note.fornecedor_id);
    expect(text).toContain(note.nota_referenciada);
  });

  it('#57/AC-3: cada item traz código, descrição, quantidade, unidade, preço unitário e valor, e há o total', () => { // ADR-002
    const note = kit();
    const lines = shown(returnNotePdf(note));
    for (const item of note.itens) {
      expect(lines).toContain(item.codigo_fornecedor);
      expect(lines).toContain(item.descricao);
      expect(lines).toContain(`${item.quantidade} ${item.unidade}`);
      expect(lines).toContain(reais(item.preco_unitario));
      expect(lines).toContain(reais(item.valor));
    }
    expect(lines.join('\n')).toContain(`Total: ${reais(note.valor_total)}`);
  });

  it('#57/AC-3: os acentos saem em WinAnsi e o texto com parênteses e barra é escapado, sem quebrar o PDF', () => { // ADR-002
    const base = kit();
    const pdf = returnNotePdf({ ...base, itens: [{ ...base.itens[0]!, descricao: 'Açúcar (refinado) 1\\2 kg' }] });
    expect(shown(pdf)).toContain('Açúcar (refinado) 1\\2 kg');
    expect([...pdf].every((ch) => ch.codePointAt(0)! < 128)).toBe(true);
  });

  it('#57/AC-3: uma descrição longa não é cortada: sai inteira, em linhas seguidas', () => { // ADR-002
    const base = kit();
    const longDescription = 'Arroz tipo 1 agulhinha integral organico em pacote de cinco quilos reforcado';
    const pdf = returnNotePdf({ ...base, itens: [{ ...base.itens[0]!, descricao: longDescription }] });
    expect(shown(pdf).join(' ')).toContain(longDescription);
  });

  it('#57/AC-3: uma nota com muitos itens passa para outra página sem perder nenhum item', () => { // ADR-002
    const base = kit();
    const items = Array.from({ length: 80 }, (_, i) => ({ ...base.itens[0]!, codigo_fornecedor: `F02-${String(i).padStart(3, '0')}` }));
    const pdf = returnNotePdf({ ...base, itens: items });
    const pages = pdf.match(/\/Type \/Page /g) ?? [];
    expect(pages.length).toBeGreaterThan(1);
    expect(pdf).toContain(`/Count ${pages.length}`);
    for (const item of items) expect(shown(pdf)).toContain(item.codigo_fornecedor);
  });
});

describe('#57/AC-4 a geração é uma função pura, sem dependência nova', () => { // ADR-002
  it('#57/AC-4: a mesma nota dá sempre o mesmo PDF, e a nota recebida não muda', () => { // ADR-002
    const note = kit();
    const before = JSON.stringify(note);
    expect(returnNotePdf(note)).toBe(returnNotePdf(note));
    expect(JSON.stringify(note)).toBe(before);
  });

  it('#57/AC-4: é um PDF 1.4 bem formado: cabeçalho, %%EOF, tabela xref com o deslocamento de cada objeto e Length certo', () => { // ADR-002
    const pdf = returnNotePdf(kit());
    expect(pdf.startsWith('%PDF-1.4\n')).toBe(true);
    expect(pdf.endsWith('%%EOF\n')).toBe(true);
    const start = Number(/startxref\n(\d+)\n%%EOF/.exec(pdf)?.[1]);
    expect(pdf.slice(start, start + 4)).toBe('xref');
    const entries = [...pdf.slice(start).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(entries.length).toBeGreaterThan(4);
    entries.forEach((offset, i) => expect(pdf.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
    for (const m of pdf.matchAll(/\/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)) expect(m[2]!.length).toBe(Number(m[1]));
  });

  it('#57/AC-4: o package.json da API não ganhou dependência de execução nem de desenvolvimento', () => { // ADR-002
    const manifest: unknown = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    if (typeof manifest !== 'object' || manifest === null) throw new Error('package.json não é um objeto');
    const { dependencies, devDependencies } = manifest as { dependencies?: unknown; devDependencies?: unknown };
    expect(dependencies).toBeUndefined();
    expect(typeof devDependencies === 'object' && devDependencies !== null ? Object.keys(devDependencies).sort() : devDependencies).toEqual(['@cloudflare/workers-types', 'typescript', 'vitest', 'wrangler']);
  });
});
