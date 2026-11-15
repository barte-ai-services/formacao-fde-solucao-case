import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DossierField } from "../src/api/contract";
import { Dossier } from "../src/components/Dossier";

const READY: DossierField = {
  status: "ready",
  summary: "A nota cobra 10 caixas e o recebimento contou 8.",
  divergences: [
    {
      classification: "E3",
      exceptionName: "Quantidade menor",
      whatDiverges: "Faltam 2 caixas do item da ordem.",
      evidence: [
        { key: "qtd_nota", label: "Quantidade na nota", value: "10 caixas", source: "invoice" },
        { key: "qtd_recebida", label: "Quantidade recebida", value: "8 caixas", source: "receipt" },
      ],
    },
  ],
  supplierHistory: "Duas faltas parecidas nos últimos 90 dias.",
  generatedAt: "2026-11-15T12:00:00Z",
  model: "claude-exemplo",
};

const DEFAULT_NOTICE = "Dossiê ainda não gerado. Decida pelas evidências da conferência.";

describe("#38/AC-1 o dossiê pronto mostra divergência, evidência e histórico", () => {
  it("#38/AC-1 mostra o resumo, a divergência com as evidências e o histórico do fornecedor", () => {
    render(<Dossier dossier={READY} />);
    expect(screen.getByText("Dossiê do Claude")).toBeTruthy();
    expect(screen.getByText("Claude")).toBeTruthy();
    expect(screen.getByText(READY.summary)).toBeTruthy();
    expect(screen.getByText("Quantidade menor")).toBeTruthy();
    expect(screen.getByText("Faltam 2 caixas do item da ordem.")).toBeTruthy();
    expect(screen.getByText("Quantidade na nota")).toBeTruthy();
    expect(screen.getByText("10 caixas")).toBeTruthy();
    expect(screen.getByText("Nota fiscal")).toBeTruthy();
    expect(screen.getByText("Quantidade recebida")).toBeTruthy();
    expect(screen.getByText("8 caixas")).toBeTruthy();
    expect(screen.getByText("Recebimento")).toBeTruthy();
    expect(screen.getByText("Histórico do fornecedor")).toBeTruthy();
    expect(screen.getByText("Duas faltas parecidas nos últimos 90 dias.")).toBeTruthy();
  });

  it("#38/AC-1 deixa claro que o Claude explica e quem decide é a regra ou a pessoa", () => {
    render(<Dossier dossier={READY} />);
    expect(screen.getByText(/Quem decide é a regra ou você/)).toBeTruthy();
    expect(screen.getByText(/a ação, o nível e o valor vêm da regra/i)).toBeTruthy();
  });

  it("classificação e fonte que a tela não conhece aparecem como vieram", () => {
    const unknownValues = {
      ...READY,
      divergences: [
        { classification: "E9", whatDiverges: "?", evidence: [{ key: "x", label: "Campo", value: "1", source: "satelite" }] },
      ],
    } as unknown as DossierField; // #68: o fio pode trazer classificação e fonte que o tipo não conhece; o teste força esse valor.
    render(<Dossier dossier={unknownValues} />);
    expect(screen.getByText("E9")).toBeTruthy();
    expect(screen.getByText("satelite")).toBeTruthy();
  });
});

describe("#38/AC-4 sem dossiê, a gaveta avisa e a decisão segue pela conferência", () => {
  it("#38/AC-4 #130 dossiê que não deu certo mostra a mensagem do motivo e que a proposta continua valendo", () => {
    render(
      <Dossier
        dossier={{
          status: "unavailable",
          reason: "claude_failed",
          notice: "O Claude não respondeu. Decida pelas divergências e evidências da conferência.",
          generatedAt: null,
        }}
      />,
    );
    expect(screen.getByText("Dossiê do Claude")).toBeTruthy();
    expect(screen.getByText("O Claude não conseguiu escrever o dossiê agora.")).toBeTruthy();
    expect(screen.getByText("A proposta continua valendo e você pode decidir sem ele.")).toBeTruthy();
  });

  it("#38/AC-4 a leitura que falhou mostra o aviso que a API mandou", () => {
    render(<Dossier dossier={{ status: "unavailable", reason: "read_failed", notice: "Não deu para ler o dossiê agora.", generatedAt: null }} />);
    expect(screen.getByText("Não há dossiê do Claude para esta proposta.")).toBeTruthy();
    expect(screen.getByText("Não deu para ler o dossiê agora.")).toBeTruthy();
    expect(screen.queryByText("Dossiê do Claude")).toBeNull();
  });

  it("#38/AC-4 dossiê que ainda não foi gerado (null) mostra o aviso padrão", () => {
    render(<Dossier dossier={null} />);
    expect(screen.getByText("Não há dossiê do Claude para esta proposta.")).toBeTruthy();
    expect(screen.getByText(DEFAULT_NOTICE)).toBeTruthy();
  });

  it("#38/AC-4 dossiê ausente (undefined) mostra o mesmo aviso padrão", () => {
    render(<Dossier dossier={undefined} />);
    expect(screen.getByText(DEFAULT_NOTICE)).toBeTruthy();
  });
});

describe("#130 os estados do bloco na gaveta", () => {
  const noop = () => {};

  it("#130 Gerando: o Claude está lendo, e quem pediu, com a hora", () => {
    render(
      <Dossier
        dossier={{ status: "generating", trigger: "on_demand", requestedBy: "ana@exemplo.com", requestedAt: "2026-11-15T13:14:00Z" }}
        onRequest={noop}
      />,
    );
    expect(screen.getByText("Dossiê do Claude")).toBeTruthy();
    expect(screen.getByText("✦ O Claude está lendo a nota, a ordem e o cadastro…")).toBeTruthy();
    expect(screen.getByText("Pedido por você às 10h14")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("#38 Gerando pelo evento: começou quando a nota chegou, sem botão", () => {
    render(
      <Dossier dossier={{ status: "generating", trigger: "event", requestedBy: "claude", requestedAt: "2026-11-15T13:14:00Z" }} onRequest={noop} />,
    );
    expect(screen.getByText("Começou quando a nota chegou, às 10h14")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("#130 Pronto: o conteúdo, a hora em que o Claude escreveu e Gerar de novo", () => {
    render(<Dossier dossier={READY} onRequest={noop} />);
    expect(screen.getByText(READY.summary)).toBeTruthy();
    expect(screen.getByText("Escrito pelo Claude às 09h00. Os números vêm do banco.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "↻ Gerar de novo" })).toBeTruthy();
  });

  it("#130 Ainda não gerado: o convite e Pedir ao Claude", () => {
    const onRequest = vi.fn();
    render(<Dossier dossier={{ status: "unavailable", reason: "pending", notice: "", generatedAt: null }} onRequest={onRequest} />);
    expect(screen.getByText(/Esta proposta ainda não tem dossiê/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "✦ Pedir ao Claude" }));
    expect(onRequest).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["claude_failed", "O Claude não conseguiu escrever o dossiê agora."],
    ["timeout", "O Claude demorou demais para responder."],
    ["number_mismatch", "O dossiê citava um número que não bate com o banco, por isso não foi mostrado."],
    ["invalid_shape", "A resposta do Claude veio fora do formato, por isso não foi mostrada."],
  ] as const)("#130 Não deu certo (%s): a mensagem da tabela e Tentar de novo", (reason, text) => {
    render(<Dossier dossier={{ status: "unavailable", reason, notice: "", generatedAt: "2026-11-15T12:00:00Z" }} onRequest={noop} />);
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.getByRole("button", { name: "↻ Tentar de novo" })).toBeTruthy();
  });
});
