import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Dossier, type DossierDto } from "../src/components/Dossier";

const PRONTO: DossierDto = {
  status: "pronto",
  resumo: "A nota cobra 10 caixas e o recebimento contou 8.",
  divergencias: [
    {
      classificacao: "E3",
      oQueDiverge: "Faltam 2 caixas do item da ordem.",
      evidencias: [
        { chave: "qtd_nota", rotulo: "Quantidade na nota", valor: "10 caixas", fonte: "nota" },
        { chave: "qtd_recebida", rotulo: "Quantidade recebida", valor: "8 caixas", fonte: "recebimento" },
      ],
    },
  ],
  historicoFornecedor: "Duas faltas parecidas nos últimos 90 dias.",
  geradoEm: "2026-11-15T12:00:00Z",
  modelo: "claude-exemplo",
};

const AVISO_PADRAO = "O dossiê ainda não foi gerado. Decida pelas divergências e evidências da conferência.";

describe("#38/AC-1 o dossiê pronto mostra divergência, evidência e histórico", () => {
  it("#38/AC-1 mostra o resumo, a divergência com as evidências e o histórico do fornecedor", () => {
    render(<Dossier dossier={PRONTO} />);
    expect(screen.getByText("Dossiê do Claude")).toBeTruthy();
    expect(screen.getByText("Claude")).toBeTruthy();
    expect(screen.getByText(PRONTO.resumo)).toBeTruthy();
    expect(screen.getByText("E3 · Quantidade menor")).toBeTruthy();
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
    render(<Dossier dossier={PRONTO} />);
    expect(screen.getByText(/quem decide é a regra ou você/)).toBeTruthy();
    expect(screen.getByText(/a ação, o nível e o valor vêm da regra/i)).toBeTruthy();
  });

  it("classificação e fonte que a tela não conhece aparecem como vieram", () => {
    const estranho = {
      ...PRONTO,
      divergencias: [
        { classificacao: "E9", oQueDiverge: "?", evidencias: [{ chave: "x", rotulo: "Campo", valor: "1", fonte: "satelite" }] },
      ],
    } as unknown as DossierDto;
    render(<Dossier dossier={estranho} />);
    expect(screen.getByText("E9")).toBeTruthy();
    expect(screen.getByText("satelite")).toBeTruthy();
  });
});

describe("#38/AC-4 sem dossiê, a gaveta avisa e a decisão segue pela conferência", () => {
  it("#38/AC-4 dossiê indisponível mostra o aviso que a API mandou", () => {
    render(
      <Dossier
        dossier={{
          status: "indisponivel",
          motivo: "claude_falhou",
          aviso: "O Claude não respondeu. Decida pelas divergências e evidências da conferência.",
          geradoEm: null,
        }}
      />,
    );
    expect(screen.getByText("Não há dossiê do Claude para esta proposta.")).toBeTruthy();
    expect(screen.getByText("O Claude não respondeu. Decida pelas divergências e evidências da conferência.")).toBeTruthy();
    expect(screen.queryByText("Dossiê do Claude")).toBeNull();
  });

  it("#38/AC-4 dossiê que ainda não foi gerado (null) mostra o aviso padrão", () => {
    render(<Dossier dossier={null} />);
    expect(screen.getByText("Não há dossiê do Claude para esta proposta.")).toBeTruthy();
    expect(screen.getByText(AVISO_PADRAO)).toBeTruthy();
  });

  it("#38/AC-4 dossiê ausente (undefined) mostra o mesmo aviso padrão", () => {
    render(<Dossier dossier={undefined} />);
    expect(screen.getByText(AVISO_PADRAO)).toBeTruthy();
  });
});
