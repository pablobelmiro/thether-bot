# Scheduler de varredura de chamados — design

**Data:** 2026-11-10
**Autor:** desenhado com o Pablo (ele dispensou a rodada de perguntas: "confio no que você desenhar").
Tudo marcado como **[minha decisão]** foi escolha minha, não combinada — é o que ele deve revisar primeiro.
As decisões dele depois da revisão de arquitetura estão marcadas **[Pablo]** e consolidadas no §14.

---

## 1. Intenção e o porquê

Chamados chegam de repente, pela demanda do cliente, e ninguém avisa. O pior caso real foi um
chamado que o Pablo só conseguiu atuar **12 horas depois** de aberto. O problema não é falta de
dados — o WMS já tem os chamados — é que ninguém está olhando a tela quando o chamado nasce.

O objetivo é **consistência de atendimento**: o Pablo quer saber que um chamado de tecnologia
existe perto do momento em que ele é aberto, para poder planejar, sem depender de alguém reparar
numa lista.

Há uma segunda metade do problema que é mais interessante que a primeira. Varrer "chamados do setor
de tecnologia" é uma consulta SQL trivial (`sector = 'tecnologia'`). Mas o Pablo pediu também
*"chamados que não possuem atribuições, porém são demandas para a tecnologia"* — e isso **não é
SQL**. É leitura de título e descrição, e julgamento. É exatamente por isso que faz sentido um
agente no circuito, e não só um `SELECT` com um alerta.

**O desenho segue essa divisão: a parte determinística é código; a parte ambígua é o agente.**

---

## 2. Objetivos, não-objetivos, anti-objetivos

### Objetivos
1. A cada 30 min (configurável), detectar chamados de tecnologia abertos desde a última varredura,
   **pausado das 00:00 às 04:00** [Pablo].
2. Detectar também chamados **sem atribuição** que, pelo conteúdo, são demanda de tecnologia.
3. Notificar o Pablo no Telegram (`5527992550895`), com um segundo número opcional.
4. Cada execução cria uma sessão do Claude, roda, **encerra a sessão**, e relata o que fez.
5. Criar, alterar, listar e apagar agendamentos **pelo Telegram**, com o agente intermediando.
6. Nunca reportar o mesmo chamado duas vezes.

### Não-objetivos
- **Não** atua no chamado. Não responde, não atribui, não muda status, não escreve código. Só avisa.
- **Não** substitui a tela de chamados nem o e-mail que já existe (`GlpiTicketNotifier`), que avisa
  *quem abriu* sobre respostas. Este módulo avisa *o técnico* sobre chamados novos. São públicos
  diferentes; os dois coexistem.
- **Não** é um motor de cron genérico. É um agendador de "rodar um prompt e me contar", e o primeiro
  agendamento é o de chamados. Outros prompts cabem, mas o desenho não tenta ser o Airflow.

### Anti-objetivos (o que faria isso falhar mesmo funcionando)
- **Virar ruído.** 48 mensagens por dia, 45 delas dizendo "nada novo", treinam o Pablo a ignorar o
  bot — e aí o chamado de 12 horas acontece de novo, agora com um alerta que ele não leu. Qualquer
  decisão de formato passa por esse filtro.
- **Mexer no repositório sozinho.** Um agente rodando sem supervisão a cada 30 min num repo de
  produção é um risco que o benefício não paga. Ver §7.
- **Falhar em silêncio.** Um agendamento quebrado que para de rodar sem avisar é pior que não ter
  agendamento, porque gera confiança falsa.

---

## 3. Restrições do terreno (levantadas no código, não supostas)

| Fato | Onde | Consequência |
|---|---|---|
| Os chamados **já estão no Postgres**, tabela `glpi_tickets` | `fonts_new/supabase/migrations/20261007133024_create_glpi_tickets.sql` | **Não precisa raspar o GLPI.** Mata a ideia de Playwright a cada 30 min. |
| `glpi:pull` roda **de minuto em minuto** e atualiza status/técnico/respostas | `fonts_new/backend/app/Console/Kernel.php:99-104` | Os dados estão no máximo ~1 min atrasados. A varredura de 30 min é o gargalo, não o sync. |
| Setor é enum de 4 valores; tecnologia = `'tecnologia'`, grupo GLPI `3` | `src/types/glpiTickets.ts:5`; migration linhas 34-51 | Filtro exato, sem heurística de texto. |
| Sem atribuição = `glpi_assignee_id IS NULL`; sem grupo = `glpi_group_id IS NULL`; ambos nullable | migration linhas 78, 98-99 | Predicado preciso disponível. |
| RLS é `TO authenticated`; o backend lê direto por `DB::connection('pgsql')` | migration linhas 293-329 | Consulta server-side não é barrada. |
| O bot é grammY + TypeScript ESM, SQLite via `node:sqlite`, systemd `telegram-claude-tether.service` | `therther-agent/` | Stack definida; nada novo entra. |
| **Não existe nenhum scheduler** no bot — só `setInterval` de polling | `src/server/core/sessions.ts:78-80` | O laço de agendamento é construção nova. |
| tmux já sabe criar sessão, colar prompt multi-linha por buffer, capturar e matar | `src/server/core/tmux.ts:69-108` | Reaproveitado inteiro. |
| `telegram_users` mapeia telefone → `chat_id`; `allowed_phones` é a allowlist | `src/server/db/db.ts:19-32` | Já dá para enviar a um número. Com uma pegadinha: ver §6. |
| O comando do Claude é montado em `claudeCommand()` | `src/server/core/sessions.ts:882-896` | Ponto de extensão para a postura de segurança. |
| **O bot tranca sozinho** depois de `idleLockHours` e, trancado, só manda aviso sem conteúdo (`notifyLocked`); o conteúdo sai no `/senha` (`deliverPending`) | `src/server/settings.ts:27`; `src/server/bot/bot.ts:894-916` | **Mantido como é** [Pablo]. O alerta do agendador passa pela tranca igual a todo o resto — §6. |
| `idleLockHours` aceita de 15 min a 7 dias, sem mudança de código | `src/server/settings.ts:44-47` | Trocar 12 h → **1 h** [Pablo] é só um `patch` de settings. |
| Pergunta do agente (`AskUserQuestion`) chega ao Telegram por **hook**, não pelo modo de permissão | `src/server/core/sessions.ts:681-704` | Funciona em `bypass`: é o que viabiliza o §7. |
| Em `bypass`, o aviso de risco no boot já é respondido sozinho (`Down`, `Enter`) | `src/server/core/sessions.ts:814-818` | Sessão agendada sobe sem humano. |
| **A pasta nova dispara o diálogo "trust this folder"**, e o bot de propósito *não* responde: ele devolve a decisão ao humano | `src/server/core/sessions.ts:790-813` | Sessão agendada travaria até o timeout. Tratado na §7. |
| Regra de `deny` vale **em todos os modos**, inclusive `bypassPermissions` | docs oficiais de permissões | A §7 tem mecanismo de verdade, não decoração. |
| "Em aberto" tem duas definições no código: status 1–4 (varredura completa) e 1–5, incluindo "solucionado aguardando aprovação" (incremental) | `backend/app/Services/GlpiTickets/GlpiImportMapper.php:41-53` | Escolhido 1–4 (§4). |
| `sector` é derivado do grupo do GLPI no import: sem grupo mapeado, `sector` e `glpi_group_id` ficam ambos `NULL` | `GlpiImportMapper.php:76-77` | "Sem atribuição" tem dois predicados possíveis; resolvido pelo recorte "só em aberto" [Pablo] — §4. |
| O importador mantém chamados em andamento desde `2026-06-01` indefinidamente | `GlpiImportMapper.php:18` | A primeira execução veria meses de backlog de uma vez. Tratado na §5. |

---

## 4. Arquitetura: quem faz o quê

O módulo atravessa **dois repositórios**, e isso é de propósito — cada metade fica onde o dado mora.

```
┌─ fonts_new/backend ────────────────────────────────────┐
│  artisan glpi:candidatos-tecnologia --json             │
│  (NOVO, somente leitura)                               │
│    → chamados de tecnologia em aberto (status 1-4)     │
│    → chamados em aberto sem atribuição (p/ julgamento) │
└────────────────────────┬───────────────────────────────┘
                         │ JSON no stdout
┌─ therther-agent ───────┴───────────────────────────────┐
│  laço do agendador (a cada 60 s, confere o que venceu) │
│    1. cria sessão tmux efêmera com o Claude            │
│    2. cola o prompt + o caminho do arquivo de saída    │
│    3. espera o arquivo de saída aparecer               │
│    4. lê o JSON, filtra o que já foi reportado         │
│    5. mata a sessão                                    │
│    6. manda o resumo no Telegram                       │
│  comandos /agendamentos, /agendar, ...                 │
└────────────────────────────────────────────────────────┘
```

**[minha decisão] Por que o agente não consulta o banco direto:** colocar credencial do Postgres no
bot acopla os dois sistemas e cria um segundo lugar com segredo de produção. Um comando artisan
somente-leitura no repo que já é dono do dado é mais barato de testar e não espalha credencial.

**[minha decisão] Por que o agente ainda é necessário:** o comando artisan devolve os candidatos
*sem atribuição* crus. Decidir quais deles são demanda de tecnologia exige ler o texto. Essa é a
única coisa que o Claude faz — e é a única coisa que só ele consegue fazer.

**[Pablo] "Em aberto" é o que limita a lista.** Essa é a resposta à pergunta de qual predicado usar
para "sem atribuição": *"pegamos apenas chamados que estão em aberto, limitando essa lista."*

Como eu li isso, para o construtor não ter de adivinhar:

- **Sem atribuição = `glpi_assignee_id IS NULL`** (sem técnico), não `glpi_group_id IS NULL`.
- O recorte que mantém a lista pequena é o **status em aberto**, não o predicado de grupo.
- Consequência boa: chamado de tecnologia que foi para o grupo *errado* (ex: Operacional) **é
  pego**, desde que ninguém o tenha assumido. E se alguém assumiu, está sendo tratado — que é
  exatamente o caso em que o Pablo não precisa ser avisado para planejar.

**[minha decisão] "Em aberto" = status 1 a 4.** O código tem duas definições
(`GlpiImportMapper::elegivel`): 1–4 na varredura completa e 1–5 na incremental, onde 5 é
"solucionado, aguardando aprovação". Um chamado já solucionado não é algo para o Pablo planejar, e
incluí-lo só gera mensagem sobre trabalho feito. Fica 1–4.

**[minha decisão] Na lista do setor, chamado que já tem técnico entra, marcado.** Vale só para a
primeira lista (`sector = 'tecnologia'`, independente de quem pegou) — a segunda, por definição, só
tem chamados sem técnico. Seria tentador esconder o que outro técnico já assumiu, mas esconder é
justamente o erro que custa 12 horas. Então entra, com `atribuido_a` preenchido, e a mensagem mostra
`já com <nome>` — o Pablo vê e ignora em um segundo. Mesma assimetria do §11.

### O contrato de saída

O ponto frágil de dirigir um agente por tmux é saber quando ele acabou e o que ele respondeu.
Capturar o painel (`capture-pane`) é ruim: quebra de linha em 200 colunas, códigos ANSI, spinner.

**[minha decisão]** O prompt manda o Claude **escrever o resultado num arquivo JSON** cujo caminho o
agendador gera (`/tmp/tether-sched-<runId>.json`). O arquivo é, ao mesmo tempo, o resultado **e o
sinal de conclusão**. O agendador espera o arquivo existir e fechar com JSON válido; se não aparecer
dentro do timeout, a execução é marcada `timeout`.

Formato:

```json
{
  "chamados": [
    { "glpi_ticket_id": 2401, "titulo": "...", "setor": "tecnologia",
      "origem": "setor", "prioridade": 3, "aberto_em": "2026-11-10T13:02:00Z",
      "atribuido_a": null,
      "resumo": "uma linha sobre o que o cliente pediu" },
    { "glpi_ticket_id": 2402, "titulo": "...", "setor": null,
      "origem": "julgado", "confianca": "alta",
      "motivo": "fala de erro ao emitir NF-e, é integração" }
  ],
  "observacoes": "texto livre e curto, ou vazio"
}
```

`origem` separa o que veio de filtro (`setor`) do que veio de julgamento (`julgado`), e `julgado`
sempre carrega `motivo`. **O Pablo precisa poder desconfiar do palpite do agente sem desconfiar do
filtro.**

---

## 5. Modelo de dados (SQLite do bot, migration append-only)

```sql
CREATE TABLE schedules (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  prompt            TEXT NOT NULL,
  cwd               TEXT NOT NULL,
  interval_minutes  INTEGER NOT NULL,
  active_from       TEXT,            -- 'HH:MM' local; NULL = sempre
  active_to         TEXT,
  weekdays          TEXT,            -- '1,2,3,4,5'; NULL = todos
  enabled           INTEGER NOT NULL DEFAULT 1,
  notify_phones     TEXT NOT NULL,   -- JSON array de telefones
  quiet_when_empty  INTEGER NOT NULL DEFAULT 1,
  timeout_minutes   INTEGER NOT NULL DEFAULT 10,
  model             TEXT,            -- NULL = padrão do agendador (ver §5.2)
  last_run_at       TEXT,
  next_run_at       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE schedule_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id   TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  status        TEXT NOT NULL,       -- running | ok | timeout | error
  tmux_session  TEXT,
  found_count   INTEGER,
  summary       TEXT,
  error         TEXT
);

-- Garantia de "nunca avisar duas vezes o mesmo chamado"
CREATE TABLE schedule_reported_items (
  schedule_id   TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  item_key      TEXT NOT NULL,       -- o glpi_ticket_id
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (schedule_id, item_key)
);
```

**[minha decisão] Dedup por item, não por marca-d'água de tempo.** Um recorte por
"abertos depois de X" perderia o caso mais importante: o chamado que foi aberto **sem setor** há
duas horas e só agora alguém classificou como tecnologia — ou que o agente só agora julgou ser
nosso. Como a lista de chamados em aberto é pequena (dezenas), cada execução traz a lista completa
e o agendador subtrai o que já está em `schedule_reported_items`. Isso cobre reclassificação,
reabertura e mudança de julgamento, de graça. O mesmo padrão de idempotência que o
`glpi_ticket_notifications` já usa no `fonts_new` (UNIQUE antes de enviar).

### 5.1 A primeira execução não pode despejar o backlog

Com a tabela de dedup vazia, a execução nº 1 anunciaria **todo** o backlog aberto — e o importador
guarda chamados em andamento desde `2026-06-01` (`GlpiImportMapper::DATA_CORTE`). Seriam meses de
chamados numa mensagem, acionando o anti-objetivo "virar ruído" na estreia.

**[minha decisão] Duas travas:**

1. **Semear a dedup na criação do agendamento.** Ao criar, o agendador roda o comando artisan uma
   vez e grava todos os `glpi_ticket_id` abertos em `schedule_reported_items` com
   `first_seen_at = agora`, **sem notificar**. O agendamento passa a existir sabendo o que já
   existia, e a execução nº 1 relata só o que é novo de verdade. A confirmação do diálogo (§8) diz
   quantos chamados foram considerados "já conhecidos".
2. **Teto de 10 chamados por mensagem**, com `… e mais N` no fim e a lista completa em
   `/agendamento <id>`. Vale também para o dia em que entrar uma enxurrada legítima — Telegram tem
   limite de tamanho de mensagem e uma parede de texto não é planejável.

### 5.2 Modelo e consumo de cota

48 execuções por dia saem da **mesma cota do plano que o Pablo usa para trabalhar**.

**[minha decisão] `model` é coluna do agendamento**, passada ao `claudeCommand()` (que já aceita
modelo, `sessions.ts:882`), com **Sonnet** como padrão. Haiku seria mais barato, mas o julgamento de
"isso é demanda de tecnologia?" é a única razão de existir do agente — economizar justamente aí
estraga o produto.

**[minha decisão] Sem freio de cota na v1.** Era possível ler a telemetria de uso que o bot já tem e
pular execuções quando a janela de 5 h estivesse apertada, mas isso é uma feature a mais que falha
exatamente quando mais importa (silenciosamente). Em vez disso: estourar o limite é um modo de falha
já previsto no §9, avisado com som. Se na prática a cota incomodar, o remédio é o intervalo — subir
de 30 para 60 min é um comando no Telegram, não uma mudança de código. **Fica registrado como risco
conhecido, não como problema resolvido.**

---

## 6. Notificação

**Destinatário fixo:** Pablo, `5527992550895`. **Opcional:** um segundo número, configurável pelo
Telegram.

**Restrição real que o Pablo precisa saber:** o Telegram não permite enviar mensagem para um número
de telefone. Só para um `chat_id`, e o `chat_id` só existe depois que **a pessoa iniciou conversa
com o bot** e se identificou. Então o segundo número não é só um campo: aquela pessoa tem de (a)
estar em `allowed_phones` e (b) ter falado com o bot uma vez. Enquanto não tiver, o agendamento
aceita o número e mostra o aviso `aguardando a pessoa falar com o bot`.

### Formato da mensagem

Com achados — o que importa é dar base para planejar, não despejar o chamado inteiro:

```
🔧 2 chamados para a tecnologia

#2401 · Erro ao emitir NF-e no WMS
Cosmosol · aberto 13:02 · prioridade alta
Setor: tecnologia

#2402 · "Sistema não deixa finalizar separação"
Gardo · aberto 12:40 · sem atribuição
Palpite meu: é tecnologia — fala de travamento na separação.

Varredura de 14:00 · próxima 14:30
```

Chamado que já tem técnico aparece com `já com Victor` na linha do cliente. Mais de 10 achados:
corta em 10 e fecha com `… e mais N — veja em /agendamento <id>`.

### A tranca do bot: fica como está

**[Pablo]** O alerta do agendador passa pela tranca **igual a todo o resto do bot**: trancado, chega
o aviso sem conteúdo; o Pablo destrava com `/senha` e lê. Nenhuma exceção, nenhum mecanismo novo.
Junto com isso, `idleLockHours` vai de **12 h para 1 h** (é só um `patch` de settings, o intervalo
aceito é 15 min a 7 dias).

Isso tem uma consequência que o construtor precisa ver de frente: com tranca de 1 hora e varredura de
30 minutos, **a maioria dos alertas vai chegar com o bot trancado**. O fluxo normal passa a ser
"chegou algo → `/senha` → leio". Foi escolha consciente — segurança acima de conveniência, e a janela
de pausa (00:00–04:00) já tira o caso da madrugada da mesa.

**[minha decisão] Mas aí a mensagem de "nada novo" não pode ser enviada com o bot trancado.**
Trancado, `notifyLocked` diz "🔒 chegou algo, destrave para ler" — e fazer isso para anunciar que
**nada** aconteceu é pior que ruído: é um chamariz falso, a cada 30 minutos, que treina o Pablo a
ignorar exatamente o aviso que importa. Então: execução sem achados **com o bot trancado não manda
nada**. A confirmação de que o agendamento está vivo continua disponível em `/agendamentos`, que é
onde ele vai olhar se desconfiar. Execução **com** achados sempre manda, trancado ou não.

Sem achados, e **[minha decisão]** com `disable_notification` (chega, mas não toca):

```
✓ Nenhum chamado novo para a tecnologia · 14:00
```

**O porquê dessa decisão:** o Pablo pediu explicitamente para ser avisado "ou notificando que nenhum
chamado novo foi aberto", e eu quero cumprir isso. Mas 48 avisos por dia com som é o anti-objetivo
do §2. Silencioso resolve as duas coisas: a mensagem está lá quando ele quiser conferir que o
agendamento está vivo, e não interrompe. `quiet_when_empty` desliga esse comportamento se ele
preferir.

**Falha** (o agente não respondeu, estourou o timeout, bateu limite de uso) é avisada **com** som,
porque silêncio aqui é o anti-objetivo "falhar em silêncio". Com um freio: no máximo **um aviso de
falha por hora** por agendamento, para um problema persistente não virar 48 mensagens.

---

## 7. Postura de segurança da sessão agendada

Esta é a parte que o Pablo não pediu e que eu não vou deixar de fora.

Uma sessão do Claude rodando **sem ninguém olhando, a cada 30 minutos**, precisa de permissão
automática para não travar numa pergunta — e permissão automática num repositório de produção
significa que um prompt mal interpretado pode editar código, rodar migration ou dar push.

### [Pablo] Modo: `bypass` sempre, e decisão volta pelo Telegram

*"O bot precisa operar sempre em bypass, caso ele precise de algo (tomada de decisão) ele solicita no
Telegram também e espera o retorno do usuário, assim montamos um pipeline consistente."*

Isso fecha o desenho, e o código já tem as três peças:

| Peça | Como funciona |
|---|---|
| Subir em `bypass` sem humano | O aviso de risco do boot já é respondido sozinho (`sessions.ts:814-818`) |
| `deny` continua valendo | Regra de `deny` bloqueia **em todos os modos**, inclusive `bypassPermissions` (docs oficiais) |
| Pergunta chega ao Telegram | `AskUserQuestion` vira `pendingQuestion` por **hook** (`sessions.ts:681-704`), independente do modo |

**O detalhe que faz isso funcionar de verdade:** em `bypass`, o Claude não pergunta nada por conta
própria — ele age. Então *o prompt tem de pedir explicitamente* que ele use `AskUserQuestion` quando
precisar de decisão, em vez de escolher sozinho (§11). Sem essa linha no prompt, "ele solicita no
Telegram" simplesmente nunca acontece.

**[minha decisão] Execução parada em pergunta não é timeout, é `waiting`.** O §9 dizia "mata a sessão
sempre". Com pergunta no circuito isso estaria errado: mataria a sessão justo quando ela está
esperando o Pablo. Então a execução entra em `waiting`, a sessão **fica viva**, o relógio do timeout
de 10 min para, e passa a valer um teto maior (**60 min**, configurável) para o caso de ninguém
responder. Enquanto está em `waiting`, as varreduras seguintes são puladas pela regra de não
sobreposição — e isso é o certo: duas sessões fazendo perguntas em paralelo no mesmo chat é confusão
garantida. Estourado o teto de 60 min, mata, marca `timeout` e avisa.

**[minha decisão] A sessão agendada roda numa pasta de trabalho dedicada**
(`~/.tether/schedules/<id>/`), não dentro do `fonts_new`. Essa pasta tem o seu próprio
`.claude/settings.json` que **nega** `Edit`, `Write`, `NotebookEdit` e os comandos de escrita do
git, liberando só: rodar o comando artisan de leitura e escrever o único arquivo de saída em
`/tmp`. O padrão de `deny` + hook já é usado no `fonts_new`
(`.claude/settings.local.json`, citado no CLAUDE.md dele), então não é mecanismo novo.

**Isso é mecanismo de verdade, não decoração:** a documentação do Claude Code é explícita de que
regra de `deny` bloqueia **em todos os modos de permissão, inclusive `bypassPermissions`**. Então a
sessão agendada pode rodar sem travar em pergunta nenhuma e continuar impedida de escrever.

### O diálogo de confiança da pasta

Pegadinha que só apareceu na revisão: pasta nova faz o Claude Code perguntar *"do you trust the files
in this folder?"*, e o bot **de propósito não responde** — ele devolve a pergunta ao humano
(`sessions.ts:790-813`, `TRUST_TOOL`), porque confiar numa pasta é decisão de quem está olhando. Numa
execução agendada às 03:00 não há ninguém olhando: a sessão ficaria parada até o timeout, toda vez.

**[minha decisão] A sessão agendada responde "sim" sozinha, e só para a própria pasta dela.** A
regra existente continua valendo para tudo o mais. O raciocínio: o diálogo protege contra pasta
*desconhecida*, e esta pasta foi criada pelo próprio agendador, com um `settings.json` que ele mesmo
escreveu — não há nada ali que o Pablo não tenha aprovado. A exceção é por sessão (a sessão agendada
carrega uma marca), não global, e é o único ponto em que o agendador decide algo que hoje é do
humano. Não existe forma documentada de pré-marcar uma pasta como confiável, então é por aqui mesmo.

Consequência honesta: a sessão agendada **não vê o código do `fonts_new`**. Para julgar se um
chamado é de tecnologia, ela não precisa — precisa ler título e descrição. Se algum dia o Pablo
quiser que a varredura também investigue o código, isso é mudança de escopo e volta para conversa.

Trabalhar o chamado continua sendo sessão interativa iniciada por ele.

**[Pablo] Só as sessões agendadas rodam em `bypass`.** As sessões interativas continuam no padrão
atual (`defaultPermissionMode: 'ask'`, `settings.ts:26`) — o modo é propriedade do agendamento, não
uma mudança de configuração global. Nada a fazer nas settings.

---

## 8. Comandos do Telegram

Seguem `ALIASES` em `src/server/bot/bot.ts:31-58` e vão traduzidos nos três idiomas de `locales/`.

| Comando | O que faz |
|---|---|
| `/agendamentos` | lista: nome, intervalo, ligado/desligado, última execução, próxima |
| `/agendar` | diálogo guiado que cria um agendamento |
| `/agendamento <id>` | detalhe + últimas execuções + botões Pausar / Rodar agora / Apagar |
| `/rodaragora <id>` | executa fora de hora (para testar) |

**[minha decisão] Criação por diálogo guiado, não por flags.** O Pablo pediu "o agente
intermediando essa etapa". Uma linha tipo `/agendar nome="..." cron="*/30 * * * *"` é hostil no
celular, que é onde ele vai estar. O diálogo pergunta uma coisa por vez (nome → o que varrer → de
quanto em quanto tempo → janela de horário → quem avisa), e confirma no fim. Expressão cron não
aparece em lugar nenhum da interface: intervalo em minutos e janela de horário cobrem o caso e são
explicáveis.

Alteração reusa o mesmo diálogo, campo a campo. Apagar pede confirmação e **mantém o histórico de
execuções** (soft delete), para "o que esse agendamento andou fazendo" continuar respondível.

Quem pode mexer: só telefones de `allowed_phones` — a allowlist que já existe. Sem papéis novos.

**[minha decisão] O alerta do agendamento não espera resposta em texto.** Existe um só chat por
pessoa, e nele qualquer texto solto é encaminhado como prompt para a sessão ativa
(`bot.ts:800-826`). Se o Pablo responder "esse aí é meu" embaixo do alerta, isso iria para a sessão
que estiver aberta. Então o alerta é **terminal**: toda interação dele é por botão
(`Ver detalhes`, `Pausar`), e o texto deixa claro que é aviso, não conversa. Isso não é problema novo
do agendador — o aviso de "sessão terminou" já se comporta assim —, mas o volume aqui é maior, então
vale resolver em vez de herdar.

---

## 9. O laço de execução

1. `setInterval` de 60 s varre `schedules` com `enabled = 1` e `next_run_at <= agora`.
2. **Sem sobreposição:** se o agendamento tem execução `running`, pula e registra. (Equivale ao
   `withoutOverlapping()` que o `Kernel.php` do `fonts_new` já usa.)
3. Fora da janela de horário ou do dia da semana: só recalcula `next_run_at`, não roda.
4. Cria sessão tmux `sched-<id>-<ts>`, com o comando do Claude montado por `claudeCommand()`
   (incluindo o `model` do agendamento).
5. Espera o Claude subir (o `start()` atual já tem essa espera), responde o diálogo de confiança da
   própria pasta se ele aparecer (§7), cola o prompt por `paste()`.
6. Faz polling do arquivo de saída até o timeout (padrão 10 min). Se o agente fizer uma pergunta,
   a execução vira `waiting`, o relógio para e vale o teto de 60 min (§7).
7. Lê e valida o JSON. Subtrai `schedule_reported_items`. Grava os novos.
8. `tmux.kill()` — **sempre**, inclusive em erro e timeout. Nada de sessão órfã. A única exceção é
   `waiting`: enquanto espera o Pablo, a sessão fica viva.
9. Manda a mensagem (nada, se vazia e com o bot trancado — §6), grava a execução, recalcula
   `next_run_at` respeitando a janela de pausa.

**[minha decisão] As sessões agendadas ficam fora de `/sessions` e do dashboard.** Se aparecerem,
em um dia o Pablo tem 48 sessões na lista e não acha a dele. Têm prefixo próprio e são filtradas das
listagens interativas; o histórico delas se vê por `/agendamento <id>`.

### Modos de falha previstos

| Falha | Tratamento |
|---|---|
| Claude não sobe / não logado | execução `error`, avisa (com freio de 1/h), não avança nada |
| Arquivo de saída não aparece | `timeout`, mata a sessão, avisa |
| JSON inválido | `error`, guarda os primeiros 2 KB do arquivo para diagnóstico |
| Limite de uso do plano batido | `error` com texto específico; o freio evita enxurrada |
| Bot reiniciado no meio | execuções `running` e `waiting` órfãs são marcadas `error` no boot, sessões `sched-*` são mortas |
| Pergunta sem resposta por 60 min | mata, marca `timeout`, avisa — com o texto dizendo que havia uma pergunta esperando |
| Comando artisan falha (banco fora) | o Claude relata no `observacoes`; vira `error` se não produzir lista |

---

## 10. Testes

Runner do repo: `node:test` via `tsx --test`, em `test/*.test.ts`.

A parte que merece teste é a **pura**, seguindo a separação que o repo já pratica
(`evaluateDoctorChecks` puro vs `runDoctorChecks` com I/O):

- cálculo de `next_run_at`: intervalo, janela de horário que vira o dia, dia da semana, horário de verão
- subtração contra `schedule_reported_items` (incluindo reclassificação e reabertura)
- validação e parse do JSON de saída, com entradas malformadas
- montagem da mensagem: com achados, sem achados, só julgados, mistura
- freio de aviso de falha

O que envolve tmux e Telegram fica atrás das interfaces injetadas que o repo já usa (`AppDeps`), com
dublê nos testes. Sem mock de SQLite: o banco é arquivo, teste usa um temporário de verdade.

---

## 11. O primeiro agendamento (o que o Pablo pediu)

| Campo | Valor |
|---|---|
| Nome | `Chamados tecnologia` |
| Intervalo | 30 min |
| Janela | **[Pablo]** roda das **04:00 às 00:00**; pausado das 00:00 às 04:00 |
| Avisa | `5527992550895` |
| Silencioso quando vazio | sim — e **não manda nada** se o bot estiver trancado (§6) |
| Timeout | 10 min; 60 min se estiver esperando resposta de uma pergunta |
| Modelo | Sonnet (§5.2) |
| Modo | `bypass`, com `deny` de escrita (§7) |

Prompt:

> Rode `php artisan glpi:candidatos-tecnologia --json` em `/home/econopro-ubuntu/Documents/econopro/fonts_new/backend`.
> A saída tem duas listas: chamados do setor de tecnologia em aberto, e chamados em aberto sem
> atribuição. Para a primeira, repasse como está. Para a segunda, leia título e descrição e decida
> quais são demanda de tecnologia, com o motivo em uma linha. Na dúvida, inclua e marque a confiança
> como baixa — deixar passar custa mais que um falso positivo. Escreva o resultado em
> `<caminho>` no formato combinado. Não altere nada, em lugar nenhum.
> Se precisar de uma decisão que você não pode tomar sozinho, **use `AskUserQuestion` e espere a
> resposta** — não escolha por conta própria e não desista da varredura.

A última linha não é enfeite: em `bypass` o Claude age em vez de perguntar, então sem ela o caminho
de "pergunta volta pelo Telegram" (§7) nunca é exercitado.

**[minha decisão] Esse prompt é dado, não código.** O `therther-agent` é pacote npm publicado
(`telegram-claude-tether`, MIT), e esse texto tem caminho absoluto da máquina do Pablo, nome de
comando artisan do EconoPro e vocabulário de GLPI. Então: o **agendador** é código genérico, e o
**agendamento de chamados** é uma linha semeada no SQLite local — criada pelo mesmo diálogo do §8 que
qualquer outro agendamento usaria. Nada específico do EconoPro entra no pacote público, e nada disso
precisa ir para um remoto.

**[minha decisão] "Na dúvida, inclua"**: o custo do erro é assimétrico. Um falso positivo custa ao
Pablo 5 segundos de leitura; um falso negativo custa 12 horas de chamado parado.

---

## 12. O que fica a cargo de quem construir

- Nome e assinatura exata do comando artisan, e o SQL dele (o predicado está no §3; a forma do JSON
  e a paginação são dele).
- Quanto de descrição mandar para o agente julgar — texto demais encarece a execução, pouco demais
  piora o julgamento. Começar por ~500 caracteres e ajustar.
- Como exatamente aplicar o `deny` da §7: verificar se o `claude` aceita um arquivo de settings por
  parâmetro; se não, a pasta dedicada com `.claude/settings.json` já resolve.
- Mecânica do diálogo guiado (máquina de estado em SQLite vs. conversations do grammY) — o repo já
  tem padrão de estado por usuário em `lock.ts`.
- Textos nos três idiomas.

## 13. Fora de escopo, registrado para não se perder

- Agente **atuar** no chamado (responder, atribuir, resolver).
- Classificar chamados dos outros setores.
- Dashboard web dos agendamentos (hoje só Telegram).
- Juntar com o e-mail do `GlpiTicketNotifier` — público diferente, deixar separado.
- Freio automático de cota (§5.2) — risco conhecido, remédio é o intervalo.

## 14. Decisões do Pablo na revisão de arquitetura

Nada neste documento está em aberto. As três decisões que vieram dele depois da primeira leitura:

| # | Decisão | Onde entrou |
|---|---|---|
| 1 | Janela: **pausado das 00:00 às 04:00**. A tranca do bot **fica como é** — trancado, avisa sem conteúdo e ele destrava para ler. E `idleLockHours` vai de 12 h para **1 h**. | §2, §6, §11 |
| 2 | "Sem atribuição" se limita pelo **status em aberto**; lido como `glpi_assignee_id IS NULL` + status 1–4 | §4 |
| 3 | Sessão sempre em **`bypass`**; quando precisar decidir, **pergunta no Telegram e espera** | §7, §9, §11 |

O que essas três decisões obrigaram a mudar no desenho, e que não era óbvio ao decidir:

- **Tranca de 1 h + varredura de 30 min = a maioria dos alertas chega trancada.** O fluxo normal
  passa a ser "chegou algo → `/senha` → leio". Consciente, mas vale ver na prática antes de concluir
  que resolveu o problema das 12 horas.
- **"Nada novo" deixou de ser enviado quando o bot está trancado** (§6): anunciar "chegou algo,
  destrave" para dizer que nada aconteceu, de 30 em 30 minutos, é chamariz falso — o anti-objetivo
  do §2 em forma pura.
- **"Mata a sessão sempre" ganhou uma exceção** (§7, §9): execução parada em pergunta vira `waiting`
  e a sessão fica viva, com teto de 60 min.
- **O prompt ganhou uma linha obrigatória** (§11): em `bypass` o Claude age em vez de perguntar, então
  sem pedir `AskUserQuestion` explicitamente, o "pergunta pelo Telegram" nunca acontece.

Confirmado por ele depois: **só as sessões agendadas** em `bypass`; as interativas ficam no padrão
atual. Documento aprovado em 2026-11-10.
