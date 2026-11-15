# Patches sobre os kits

`@barte-ai-services+barte-ui-kit+0.2.0.patch` dá ao `DecisionForm` as props `value`, `onValueChange`,
`children` (entre as opções e a observação) e `submitDisabled` (#203). É a mesma mudança do PR
barte-ai-services/barte-ui-kit#87. **O patch sai, junto com o `postinstall` e o `patch-package`, quando o
kit novo entrar** (`package.json` sobe a versão do kit e este arquivo é apagado).
