// #357 Os controles do administrador na faixa de automação: "Rodar agora" e o liga/desliga do modo demonstração.
// #357 Isolado da faixa: ela decide se o mostra (só quando `GET /api/automacao` diz `isAdmin`), ele chama as duas rotas de administração
// #357 e pede a recarga da faixa. Só componentes da barte-design-system e os tokens dela.
import { useEffect, useRef, useState } from "react";
import { Play } from "@phosphor-icons/react";
import { Button, Icon, Toggle } from "barte-design-system";
import { ApiError } from "../api/client";
import { runNow, setDemoMode } from "../api/automation";
import { texts } from "../texts";

const t = texts.automation.admin;

/** Quanto depois do 202 a faixa recarrega de novo: a rodada corre depois da resposta e leva alguns segundos. */
export const SETTLE_MS = 5_000;

export interface AutomationAdminControlsProps {
  demoEnabled: boolean;
  /** Recarrega a faixa (`GET /api/automacao`). */
  onReload: () => void;
  settleMs?: number;
}

const failureText = (error: unknown, fallback: string, conflict?: string): string => {
  if (error instanceof ApiError && error.code === "round_in_progress") return t.runNowBusy;
  if (error instanceof ApiError && error.code === "conflict" && conflict) return conflict;
  return fallback;
};

export function AutomationAdminControls({ demoEnabled, onReload, settleMs = SETTLE_MS }: AutomationAdminControlsProps) {
  const [pending, setPending] = useState<"run" | "demo" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const act = async (kind: "run" | "demo", call: () => Promise<unknown>, fallback: string, conflict?: string) => {
    setPending(kind);
    setMessage(null);
    try {
      await call();
      onReload();
      if (kind === "run") {
        clearTimeout(timer.current);
        timer.current = setTimeout(onReload, settleMs);
      }
    } catch (error) {
      setMessage(failureText(error, fallback, conflict));
      // O modo mudou por outra mão: a faixa mostra o de agora.
      if (error instanceof ApiError && error.code === "conflict") onReload();
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="pagar-automation-band__admin" data-testid="automation-admin">
      <Toggle
        size="sm"
        label={t.demoToggle}
        checked={demoEnabled}
        disabled={pending !== null}
        onChange={(enabled) => void act("demo", () => setDemoMode(enabled), t.demoFailed, t.demoConflict)}
      />
      <Button
        variant="outline"
        size="sm"
        iconLeft={<Icon icon={Play} />}
        loading={pending === "run"}
        disabled={pending !== null}
        onClick={() => void act("run", () => runNow(), t.runNowFailed)}
      >
        {t.runNow}
      </Button>
      {message ? (
        <span className="pagar-automation-band__admin-message" role="alert">
          {message}
        </span>
      ) : null}
    </div>
  );
}
