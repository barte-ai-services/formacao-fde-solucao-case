import { InlineEmpty, PageTitleBar } from "@barte-ai-services/barte-ui-kit";

/** O endereço que não existe, dentro da moldura, como no Shell: a pessoa continua com o menu à mão. */
export function NotFound() {
  return (
    <div className="shell-home pagar-screen">
      <PageTitleBar variant="compact" title="Página não encontrada" />
      <InlineEmpty>Este endereço não existe no contas a pagar.</InlineEmpty>
    </div>
  );
}
