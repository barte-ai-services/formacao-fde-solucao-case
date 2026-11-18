import type { KitReturnNote } from './kit-note.js';

// #156: o PDF da nota de devolução emitida, anexo do e-mail ao fornecedor junto do JSON (#156, história #155/#156).
// #156: função pura, sem dependência: um PDF 1.4, Helvetica em WinAnsi, A4, que desenha a nota no formato do kit (a mesma
// #156: `KitReturnNote` do JSON, então os valores batem). É uma representação da nota emulada, não um DANFE.
// #156: o PDF sai como texto só de ASCII (o que não é ASCII vai em octal do WinAnsi), um byte por caractere, que é o que o anexo
// #156: (`MailAttachment.content`, string) e a resposta HTTP levam. Ideia de PR Djegao/grupo-5-slucao#40, adaptada ao modelo da main.

type Text = readonly [x: number, y: number, size: number, text: string];
type Page = Text[];

const TOP = 800;
const BOTTOM = 60;
const LEFT = 50;
const DESCRIPTION_WIDTH = 38; // #156: caracteres da coluna Descrição, a 9 pt, antes de quebrar a linha
const LINE = 14;

const reais = (value: number): string => `R$ ${value.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;

const dayMonthYear = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/** #156: texto de PDF: escapa `\`, `(` e `)` e leva cada caractere fora do ASCII para o octal do WinAnsi (Latin-1). */
function pdfString(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63;
    if (ch === '\\' || ch === '(' || ch === ')') out += `\\${ch}`;
    else if (code >= 32 && code < 127) out += ch;
    else if (code >= 160 && code <= 255) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += '?';
  }
  return `(${out})`;
}

/** #156: quebra o texto em linhas de até `width` caracteres, nos espaços; uma palavra maior que a linha é partida. Nada se perde. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter((w) => w !== '')) {
    let rest = word;
    while (rest.length > width) {
      if (current !== '') lines.push(current);
      lines.push(rest.slice(0, width));
      rest = rest.slice(width);
      current = '';
    }
    if (current === '') current = rest;
    else if (current.length + 1 + rest.length <= width) current += ` ${rest}`;
    else {
      lines.push(current);
      current = rest;
    }
  }
  if (current !== '') lines.push(current);
  return lines.length === 0 ? [''] : lines;
}

/** #156: a folha em montagem: as páginas, a página corrente e a altura em que a próxima linha entra. */
class Sheet {
  y = TOP;
  private current: Page = [];
  readonly pages: Page[] = [this.current];

  add(x: number, size: number, text: string): void {
    this.current.push([x, this.y, size, text]);
  }

  down(amount: number): void {
    this.y -= amount;
  }

  nextPage(): void {
    this.current = [];
    this.pages.push(this.current);
    this.y = TOP;
  }
}

const COLUMNS = [[LEFT, 'Código'], [130, 'Descrição'], [360, 'Qtd.'], [420, 'Preço unit.'], [500, 'Valor']] as const;

function drawColumns(sheet: Sheet): void {
  for (const [x, label] of COLUMNS) sheet.add(x, 10, label);
  sheet.down(16);
}

function drawHeader(sheet: Sheet, note: KitReturnNote): void {
  const rows: readonly (readonly [size: number, text: string, gapAfter: number])[] = [
    [16, `Nota de devolução ${note.nota_id}`, 18],
    [9, 'Emissão emulada (demonstração) · sem valor fiscal', 26],
    [10, `Número ${note.numero} · série ${note.serie} · emitida em ${dayMonthYear(note.data_emissao)}`, LINE],
    [10, `Chave de acesso: ${note.chave}`, LINE],
    [10, `Emitente: ${note.emitente.nome} · destino ${note.emitente.destino}`, LINE],
    [10, `Fornecedor: ${note.fornecedor_id}`, LINE],
    [10, `Nota referenciada: ${note.nota_referenciada}`, LINE],
    [10, `Natureza: ${note.natureza}`, 28],
  ];
  for (const [size, text, gapAfter] of rows) {
    sheet.add(LEFT, size, text);
    sheet.down(gapAfter);
  }
}

function drawItems(sheet: Sheet, note: KitReturnNote): void {
  for (const item of note.itens) {
    const description = wrap(item.descricao, DESCRIPTION_WIDTH);
    if (sheet.y - (description.length - 1) * LINE < BOTTOM) {
      sheet.nextPage();
      drawColumns(sheet);
    }
    sheet.add(LEFT, 9, item.codigo_fornecedor);
    sheet.add(360, 9, `${item.quantidade} ${item.unidade}`);
    sheet.add(420, 9, reais(item.preco_unitario));
    sheet.add(500, 9, reais(item.valor));
    for (const part of description) {
      sheet.add(130, 9, part);
      sheet.down(LINE);
    }
  }
}

function drawTotal(sheet: Sheet, note: KitReturnNote): void {
  sheet.down(12);
  if (sheet.y < BOTTOM) {
    sheet.nextPage();
    drawColumns(sheet);
  }
  sheet.add(420, 11, `Total: ${reais(note.valor_total)}`);
}

/** #156: as páginas: o cabeçalho da nota, os itens (passam de página sem perder nenhum) e o total. */
function layout(note: KitReturnNote): Page[] {
  const sheet = new Sheet();
  drawHeader(sheet, note);
  drawColumns(sheet);
  drawItems(sheet, note);
  drawTotal(sheet, note);
  return sheet.pages;
}

const contentOf = (page: Page): string =>
  page.map(([x, y, size, text]) => `BT /F1 ${size} Tf ${x} ${y} Td ${pdfString(text)} Tj ET`).join('\n');

/** #156: o PDF da nota como texto ASCII (um byte por caractere). Dois objetos por página: a página e o conteúdo dela. */
export function returnNotePdf(note: KitReturnNote): string {
  const pages = layout(note);
  const firstPageObject = 4;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${firstPageObject + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  pages.forEach((page, i) => {
    const content = contentOf(page);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${firstPageObject + i * 2 + 1} 0 R >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    );
  });
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}
