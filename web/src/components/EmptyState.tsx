import type { ReactElement } from "react";
import { Button, Empty, Text } from "barte-design-system";
import { navigate } from "../router";

export interface EmptyStateProps {
  /** O que a tela mostra quando houver dados, em uma frase curta. */
  title: string;
  /** O que vai aparecer ali e quando. */
  description: string;
  /** A próxima ação, quando houver uma; leva a outra tela. */
  action?: { label: string; to: string };
}

/**
 * O vazio das telas: a ilustração do `Empty` do design system, o título, a explicação e, quando
 * couber, uma ação. O "Tente novamente" do `Empty` fica escondido: num vazio legítimo não há o que tentar.
 */
export function EmptyState({ title, description, action }: EmptyStateProps): ReactElement {
  return (
    <div className="pagar-empty" role="status">
      <Empty type="empty" description="" showButton={false} />
      <Text variant="label-lg">{title}</Text>
      <Text variant="body-base" className="pagar-empty-description">
        {description}
      </Text>
      {action ? (
        <Button variant="fill" size="base" onClick={() => navigate(action.to)}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
