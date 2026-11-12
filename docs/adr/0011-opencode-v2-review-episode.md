# ADR 0011: revisar episódios fechados no OpenCode v2

## Status

Accepted direction — 2026-10-02. O proprietário aprovou a unidade episódio e a substituição da captura antiga. A aquisição ainda está em experimento; esta decisão não declara compatibilidade v2 nem aprova uma garantia de autoria inexistente. A relação mensagem/pai de ADR 0003 é substituída para a futura integração v2; independência do core e proibição de fallback global permanecem.

## Contexto e recomendação

No OpenCode v2.0.22 uma resposta assistant representa uma etapa, e o trabalho pode incorporar vários pedidos efetivamente entregues antes do mesmo idle. Adotamos um Review Episode fechado com sucesso como unidade da futura integração v2, com pedidos em ordem e mudança final completa delimitada. Isso aproxima a revisão do resultado entregue ao usuário e evita julgar estados intermediários. Encerramento operacional não certifica conclusão correta de toda a task. A captura antiga será removida na migração; não haverá fallback para ela.

## Alternativas

Conservar uma mensagem assistant e seu pai direto preserva a norma atual, mas a interface pública de evidência necessária não está disponível. Usar o último assistant com o diff agregado falsearia a atribuição. Usar working-tree diff ou resumir os pedidos viola os invariantes de origem/completude.

## Consequências

Escolher episódio não transforma snapshot temporal em autoria comprovada. A integração permanece incapaz de avaliar quando não houver interface pública com histórico fechado, cobertura explícita e atribuição, inclusive em casos de omissão/concorrência. O core continua independente do host; observe-only e proposta sem tools/apply permanecem. Adoção requer sincronizar SPEC/CONTEXT, definir limites de intenção agregada, identidade por fechamento e gates de release.

O proprietário pediu investigar um capturador próprio com benchmark e indicou aceitar uma revisão de tudo observado na janela caso provar autoria torne a solução frágil. Essa preferência autoriza o experimento; o contrato final de proveniência e a fidelidade das fronteiras precisam constar do resultado antes da implementação. Não interpretar atribuição operacional como prova causal. Capturador filesystem independente pode reduzir dependências do host, mas não torna o stream de eventos uma barreira síncrona.

## Ratificação J01 — 2026-10-02

SPEC §7.10.1 substitui a preferência experimental acima pelo contrato futuro:
net delta observado, sem autoria exclusiva/auditoria write-revert; sobreposição
conhecida invalida afetados sem lock global; escritor conhecido exige settlement.
Recovery só com evidência congelada e closure verificável; shutdown sem closure open.
Pedidos completos em ordem real, multimodal incompleto indisponível, intenção sem
resumo/truncamento e policy inicial congelada para review/proposta. Root/cobertura,
policy e snapshots não atômicos exigem validação, não garantida por tipos.
Números/capacidades upstream permanecem gates; runtime V1 não foi migrado.

Detalhes e exemplos: SPEC §7.10.1 e documento de decisão (registro local).
