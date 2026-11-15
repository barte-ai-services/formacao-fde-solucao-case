import type { AnchorHTMLAttributes, MouseEvent } from "react";
import { navigate } from "./navigation";

export interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
}

/**
 * Um link interno: o clique comum navega sem recarregar a página. Ctrl, Cmd, Shift, o botão do meio
 * e `target` continuam com o navegador, como num `<a>` qualquer.
 */
export function Link({ href, onClick, target, ...rest }: LinkProps) {
  const handle = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || target) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(href);
  };
  return <a href={href} target={target} onClick={handle} {...rest} />;
}
