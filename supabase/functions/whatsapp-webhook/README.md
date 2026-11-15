# WhatsApp: consulta e cadastro por comandos

Integração de servidor com a API oficial WhatsApp Cloud da Meta. Não cria ou altera tabelas, não substitui o login do app e não verifica novos números. Utiliza exclusivamente vínculos já verificados em `whatsapp_connections`.

## Ativação

Publicar a Edge Function `whatsapp-webhook` com verificação JWT da plataforma desabilitada somente para essa função. A Meta não envia JWT Supabase: a autenticação dos POSTs é feita pela assinatura HMAC SHA-256 `x-hub-signature-256`, calculada sobre os bytes originais do corpo. Não desabilitar a autenticação de `document-intake`.

Cadastrar a URL da função como callback no aplicativo Meta e assinar os eventos `messages` da conta WhatsApp Business. O GET responde ao desafio somente mediante o token de verificação correto. Eventos de outros números comerciais são ignorados.

Segredos exclusivos do servidor:

- `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`: projeto Supabase existente. A chave privilegiada é necessária porque o webhook não recebe a sessão do usuário; nunca expor ao navegador.
- `WHATSAPP_APP_SECRET`: segredo do aplicativo Meta, usado para validar assinaturas.
- `WHATSAPP_VERIFY_TOKEN`: token aleatório exclusivo para a verificação do callback.
- `WHATSAPP_ACCESS_TOKEN`: token da API oficial com permissão de envio.
- `WHATSAPP_PHONE_NUMBER_ID`: identificador do número comercial, não o telefone em si.
- `WHATSAPP_GRAPH_VERSION`: versão suportada pela conta Meta, no formato `vNN.N`.
- `WHATSAPP_VERIFIED_STATUS`: valor real de `connection_status` utilizado pelo projeto para vínculos ativos e verificados. Não há padrão presumido porque o schema não informa a enumeração. Não usar `pending` para liberar vínculos pendentes.

O processamento não é ativado sem esses valores. Não é necessário configurar outro banco.

## Vínculo e isolamento

O remetente é obtido exclusivamente de `messages[].from` em um evento assinado. O código aceita telefone internacional com 8 a 15 dígitos, sem pontuação, e procura `phone_number` nas formas com e sem `+`. Números armazenados com outros formatos não são vinculados automaticamente.

É exigida exatamente uma linha que tenha o status configurado e `verified_at` válido, não futuro. Vínculos ausentes ou ambíguos não liberam acesso. O `user_id` é retirado dessa linha, nunca do texto, de parâmetros externos ou da resposta de um modelo.

Todas as consultas de dados pessoais incluem `user_id`. Consultas de aluguéis verificam também a propriedade do imóvel; o histórico verifica a propriedade do aluguel e do imóvel antes de consultar pagamentos. As inserções fixam `user_id` no servidor e aceitam somente os campos documentados. A resposta é enviada apenas ao remetente verificado e o vínculo é revalidado antes do envio.

Importante: revisar as políticas existentes de `whatsapp_connections` antes da ativação. Um cliente comum não pode atribuir a si mesmo `verified_at` ou um status verificado, nem assumir o telefone de outra pessoa. Esta entrega não modifica políticas porque suas definições não foram fornecidas. Não liberar o canal até confirmar essa proteção. O fluxo futuro de vinculação deverá comprovar a posse do número e a sessão da conta, sem confiar apenas em um telefone digitado.

## Comandos de consulta

As consultas exibem no máximo 10 registros. Não há paginação nesta etapa.

- `AJUDA`: instruções. Comandos desconhecidos também retornam ajuda e nunca gravam.
- `CONTAS`: contas com `paid_at` nulo, ordenadas por vencimento crescente, incluindo vencidas. Mostra o tipo original, sem presumir se é conta a pagar ou a receber.
- `LANCAMENTOS`: últimos registros de `budget_entries`, por data da transação.
- `COMPROMISSOS`: próximos registros de `appointments`. Datas e horários são apresentados em UTC explicitamente; não há coluna de fuso horário no schema fornecido.
- `IMOVEIS`: nomes e identificadores dos imóveis do usuário.
- `ALUGUEIS <id do imóvel>`: contratos daquele imóvel, incluindo `kind`, período, valor e identificador. Não presume os valores usados para mensal ou temporada.
- `HISTORICO <id do aluguel>`: últimos pagamentos do contrato, com período, valor, vencimento, `payment_status` e `paid_at`. O status exibido é o valor real persistido, não um novo status inventado.

Exemplo de navegação: enviar `IMOVEIS`, copiar o identificador desejado para `ALUGUEIS <id>` e consultar cada contrato com `HISTORICO <id>`.

## Cadastro financeiro com confirmação explícita

Revisar os dados antes de enviar um destes comandos, em uma única mensagem:

```text
CONFIRMAR CONTA | tipo | descrição | valor | AAAA-MM-DD | categoria
CONFIRMAR LANCAMENTO | tipo | descrição | valor | AAAA-MM-DD | categoria
```

Os rótulos acima são campos a substituir, não valores padrão. `tipo` deve ser um valor real aceito pelo cadastro existente. Datas devem ser válidas; valores devem ser não negativos, com até duas casas decimais, sem separador de milhar. Os campos não podem conter `|` ou quebras de linha.

`CONFIRMAR CONTA` insere em `bills`, usando a data como `due_date`. `CONFIRMAR LANCAMENTO` insere em `budget_entries`, usando a data como `entry_date`. Nenhum comando marca uma conta como paga, modifica um aluguel ou remove dados. A mensagem iniciada por `CONFIRMAR` é a autorização explícita de gravação; não existe confirmação automática baseada em linguagem natural.

Não usar um modelo para decidir acesso, construir consultas ou executar comandos. O fluxo de extração de documentos permanece separado em `document-intake`, com revisão e confirmação obrigatórias. Imagens e outros anexos recebidos pelo WhatsApp não são baixados nem enviados ao modelo nesta etapa.

## Reentregas e falhas

O identificador do registro financeiro é derivado de SHA-256 sobre usuário, ID da mensagem Meta e tabela. Reentregas da mesma mensagem geram o mesmo UUID. A inserção utiliza `on_conflict=id` com `resolution=ignore-duplicates`, sem atualizar o registro anterior. Isso depende da unicidade de `id` nas tabelas existentes, que deve ser verificada antes da publicação; nenhuma migração foi criada.

Mensagens novas, mesmo com conteúdo igual, representam novas autorizações e podem criar novos registros. Se houver dúvida sobre uma gravação, consultar os lançamentos antes de reenviar o comando como uma nova mensagem.

A função responde ao WhatsApp de forma síncrona e retorna 503 quando uma operação de dados ou envio falha, permitindo reentrega do evento pela Meta. O cadastro financeiro é protegido contra duplicação da mesma mensagem; as respostas de texto podem se repetir. Não há fila durável ou garantia de resposta exatamente uma vez. Para volume elevado, será necessário um processamento assíncrono com armazenamento de eventos e retentativas. Esta etapa destina-se a comandos simples e baixo volume.

Falhas internas não retornam detalhes do banco ou credenciais. O código não registra mensagens, telefones ou documentos em logs. Não há CORS porque este endpoint é servidor a servidor. Respostas são apenas em reação à mensagem recebida; não há disparos proativos, templates ou lembretes implementados aqui.

## Testes antes da ativação

1. GET com token incorreto deve retornar 403; token correto deve devolver o desafio.
2. POST sem assinatura, com assinatura falsa ou corpo alterado deve retornar 401 e não consultar dados.
3. Um evento assinado de outro `phone_number_id` deve ser ignorado.
4. Número sem vínculo, com vínculo pendente ou com dois vínculos verificados deve receber somente a orientação genérica, sem dados pessoais.
5. Com duas contas distintas, um usuário não deve consultar imóvel, contrato ou histórico da outra conta mesmo conhecendo seus IDs.
6. `CONTAS`, `LANCAMENTOS` e `COMPROMISSOS` devem retornar somente os registros do usuário vinculado.
7. Texto livre, comando incompleto, valor negativo e data inválida não devem gravar.
8. Um comando CONFIRMAR válido deve inserir somente os campos permitidos e o `user_id` do vínculo.
9. Reentregar o mesmo evento de cadastro deve manter somente um registro; um novo ID de mensagem deve ser tratado como nova autorização.
10. Revogar o vínculo deve impedir novos acessos. Confirmar também que um usuário comum não consegue forjar a verificação por acesso direto ao banco.

## Escopo restante

Esta entrega implementa o canal de comandos, não a interface React. Permanecem pendentes: vinculação verificada de novos números, envio e revisão de documentos no app, telas e operações de imóveis e aluguéis mensais/temporada, geração de vencimentos, atualização de pagamento, configuração de lembretes e entrega agendada com registro em `reminders`. O histórico disponível pelo WhatsApp consulta os registros já existentes; não gera cobranças nem presume que o campo `paid` de um contrato substitui o histórico de `rental_payments`.
