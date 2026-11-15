import { InlineEmpty, PageTitleBar } from "@barte-ai-services/barte-ui-kit";
import { texts } from "../texts";

/** O endereço que não existe, dentro da moldura, como no Shell: a pessoa continua com o menu à mão. */
export function NotFound() {
  return (
    <div className="shell-home pagar-screen">
      <PageTitleBar variant="compact" title={texts.notFound.title} />
      <InlineEmpty>{texts.notFound.body}</InlineEmpty>
    </div>
  );
}
