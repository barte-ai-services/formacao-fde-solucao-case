# Como contribuir

A turma trabalha neste repositório por **clone, sem fork**. Cada aluno é colaborador com escrita:
empurra a própria branch e abre PR contra a `main`.

## O caminho de uma mudança

1. **Comece por uma issue.** Ache a issue dona do trabalho ou abra uma. O número dela vai no nome
   da branch e no PR.
2. **Clone e crie a branch a partir da `main` atualizada**, no formato `tipo/N-slug`, em que
   `tipo` é o do Conventional Commits e `N` é o número da issue:

   ```bash
   git clone https://github.com/barte-ai-services/formacao-fde-solucao-case.git
   cd formacao-fde-solucao-case
   git switch -c feat/123-minha-mudanca
   ```

3. **Rode o gate antes de cada commit:** `make check`. É o mesmo que o CI roda no PR. O `web/`
   instala o `shell-kit` e o `barte-ui-kit` do GitHub Packages da org, que são internos: fora da
   org, o `npm ci` do `web/` falha na sua máquina. Como lidar com isso faz parte do case; no PR, o
   CI instala os kits e roda o gate inteiro.
4. **Empurre a branch e abra o PR** contra a `main`:

   ```bash
   git push -u origin feat/123-minha-mudanca
   gh pr create --fill
   ```

   O título segue o Conventional Commits, em inglês (`feat: ...`, `fix: ...`), porque vira a
   mensagem do commit na `main`. No corpo, `Closes #123` liga o PR à issue.

5. **Espere o CI verde e a aprovação da equipe.** A `main` não aceita push direto, e o PR só entra
   com o CI verde e a aprovação de um code owner (a equipe, pelo `.github/CODEOWNERS`). A
   aprovação de um colega da turma é bem-vinda como revisão, mas não libera o merge. O merge é
   squash.

## O que a `main` faz depois do merge

O merge na `main` publica o Worker e aplica as migrações no Supabase. Esses workflows usam as
credenciais de produção, que ficam no environment `producao` e só a `main` alcança. O CI do PR
não usa nenhum secret.

## Regras

- **Nada de segredo no git.** Credenciais ficam no `.env` ou no `.dev.vars`, que o git ignora.
- **Nenhum nome de cliente real.** A Já Chegou é fictícia.
- **Prosa em português.** Código, título de PR e mensagem de commit seguem o padrão do repositório.
