# ADR 0012: capturador próprio e ponte aguardada no host

**Superseded direction — 2026-10-03:** [ADR 0013](0013-native-historical-changesets.md)
replaces owned capture and awaited plugin hooks as the active acquisition plan.
The record below is historical, including its non-Git scope. J01 safety/episode
invariants and explicit cooperative-profile limitations remain; standalone J02 is
archived, not integrated or deleted. Do not use the former reaffirmation as current
implementation authorization.

Status: accepted direction — 2026-10-02. O proprietário aprovou planejar um fork controlado do OpenCode com hooks genéricos e uma proposta de PR upstream, mantendo captura e política no JevGuard. A prova integrada suporta a ordenação por sessão dessa abordagem; não constitui contrato final, compatibilidade oficial ou aprovação de manutenção permanente de fork.

J01 ratificada em SPEC §7.10.1: espera limitada inclui persistência necessária;
timeout invalida geração e resultados tardios, sem prometer término do I/O.
Jev/credentials/network/proposal fora dos callbacks. Budgets numéricos dependem de
benchmark/ratificação. Contrato público upstream ainda não aprovado (#52870 aberta,
apenas comentário bot); U04 bloqueada. U02 propõe retorno validado em registration
pareada, não ticket/API final. Delivery log público não garante retenção/completude
nem acesso plugin; metadata experimental não é closure durável. J05/J06 dependem
dessas capacidades reais. Não declarar suporte V2 por este contrato interno.

Um subscriber assíncrono não garante que os bytes lidos no fechamento precedam as mudanças do sucessor. Delegar ao agente não elimina esse problema nem estabelece completude; importar serviços/banco privados amplia acoplamento. Escolhemos um capturador filesystem próprio e uma interface pequena awaited no host, com espera limitada e revisão semântica posterior em background. O host não incorpora Jev, regras ou armazenamento de evidência do produto.

O fork é pinado para integração/prova; a contribuição genérica segue feature request e design review dos maintainers antes do PR. A versão oficial substitui o fork após release e testes. Recusa ou demora não autoriza distribuição permanente automaticamente. Evidência observada continua distinta de autoria causal; identity/recovery, cobertura, concorrência e orçamento final são gates do contrato e do release, definidos em J01/J09. Não voltamos à captura V1 nem ao diff global quando a ponte falta.

Plano executável: 19 tasks de migração (registro local). Evidência: prova integrada (registro local).

## Reafirmação após comparação de alternativas — 2026-10-02

O proprietário fixou a direção: fork controlado para lifecycle genérico aguardado;
captura/evidência continuam no JevGuard. Não ampliar o Snapshot do host para
incorporar o capturador strict do produto. Permanece o gate de design upstream,
versão pinada e substituição pelo host oficial após release validada; não é
autorização de manutenção/distribuição permanente de fork.

Alternativas descartadas como caminho de implementação desta migração:

- `session.diff` atual como evidência suficiente: omissões/limites/fronteiras
  ausentes não têm contrato de completude adequado. Ver recheck local.
- Extensão strict dos snapshots nativos como substituta do capturador próprio:
  spike demonstrou camada nova de captura sobre Git, não simples reuso do
  Snapshot. Mesmo corrigido, não comprovou containment, lifecycle ou recovery.

Os experimentos ficam arquivados como evidência, não apagados nem declarados
fracassados em todos os seus resultados. Git como detalhe interno de armazenamento
ou comparação não foi escolhido como dependência obrigatória; não há fallback
para Git diff. O escopo J02 continua incluindo projetos non-Git.

Pre-action semantic enforcement e isolamento por namespace são direções separadas,
fora da migração atual. Correlação por tool/event é complementar, não autoria forte.
Esta reafirmação não aprova implicitamente perfil filesystem cooperativo nem
igualdade de conteúdo sensível inferida de metadata; segurança/limites J02 seguem
gates explícitos antes da implementação.

### Decisão posterior: perfil cooperativo para J02

Após explicação da corrida de troca de parent/junction entre verificação e leitura,
o proprietário escolheu o perfil cooperativo: considera esse ataque concorrente
muito raro no uso pretendido e aceita a premissa de namespace não adversarial.
Isso é aceitação de risco, não probabilidade medida nem garantia de containment.
Não implementar leitor nativo/isolamento forte nesta task.

O recibo deve declarar o perfil; links/escapes conhecidos e instabilidade observável
continuam recusados. Não prometer resistência a substituições transitórias de
caminho nem snapshot atômico. Safety, completude e cancelamento permanecem.
Metadata sensível não prova igualdade; esta escolha não autoriza leitura de
conteúdo sensível nem aprova budgets numéricos.
