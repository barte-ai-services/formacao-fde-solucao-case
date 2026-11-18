/**
 * #156 Quem está olhando a tela, para o "por você" do pedido ao fornecedor (#156). O e-mail vem do contexto da
 * moldura (o `GET /me` do Worker, ou o do Shell); a `Frame` o põe aqui, e a gaveta o lê sem receber por props de rota.
 */
import { createContext, useContext, type JSX, type ReactNode } from "react";

/** #156 Sem e-mail (a moldura sem identidade), o texto vazio: ninguém é "você". */
const ViewerContext = createContext<string>("");

export function ViewerProvider({ email, children }: { email: string | null; children: ReactNode }): JSX.Element {
  return <ViewerContext.Provider value={email ?? ""}>{children}</ViewerContext.Provider>;
}

export function useViewer(): string {
  return useContext(ViewerContext);
}
