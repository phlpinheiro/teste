# Documentos: extração e confirmação

Função de servidor independente para imagens de contas e recibos. Não cria tabelas, não altera registros anteriores e não armazena a imagem. A imagem é enviada ao AI Gateway exclusivamente para extração. Esta entrega não inclui a interface de envio.

## Publicação e segredos

Publicar como uma Supabase Edge Function chamada `document-intake`. Manter a autenticação da função habilitada. A própria função também valida o JWT em `/auth/v1/user` em todas as operações.

Variáveis no servidor:

- `SUPABASE_URL` e `SUPABASE_ANON_KEY`: configuração do projeto Supabase existente.
- `LOVABLE_API_KEY`: credencial do AI Gateway, necessária para extração; nunca colocar em variáveis VITE ou no navegador.
- `DOCUMENT_AI_MODEL`: opcional; padrão `google/gemini-2.5-flash`.
- `DOCUMENT_ALLOWED_ORIGINS`: origens exatas do app separadas por vírgula, sem barra final. Incluir explicitamente os domínios de produção e de pré-visualização usados. Requisições de navegador de outras origens são recusadas.

A gravação usa a chave pública e o JWT individual, não usa `service_role`. As políticas existentes de `bills` e `budget_entries` precisam permitir inserção e leitura do registro retornado para o próprio usuário. Não foram criadas ou alteradas políticas porque suas definições não constam no contexto. Antes de liberar, verificar RLS em todas as tabelas do fluxo e testar com duas contas distintas. Esta função não oferece consulta de lançamentos e fixa `user_id` com base na sessão validada, ignorando qualquer identificação enviada no corpo.

## Integração com o cliente Supabase existente

Chamar `supabase.functions.invoke('document-intake', { body: ... })` com a sessão autenticada existente. Não criar outro sistema de login. Tratar tanto o erro retornado pelo cliente quanto respostas HTTP de erro.

### Solicitar sugestão

Corpo JSON:

```json
{
  "action": "suggest",
  "mime_type": "image/jpeg",
  "image_base64": "BASE64_SEM_PREFIXO_DATA"
}
```

Aceita JPEG, PNG e WebP de até 6 MB. PDF não está contemplado nesta etapa. A resposta contém `saved: false`, `requires_confirmation: true`, `suggestion` e `warnings`. Os campos de sugestão são `description`, `amount`, `due_date`, `entry_date`, `category` e `counterparty`; informações ausentes ou inválidas retornam como null, não como valores inventados.

A interface deve explicar o envio da imagem para processamento, mostrar os avisos, permitir editar todos os campos, escolher o destino e o tipo do lançamento e oferecer um botão explícito de confirmação. Renderizar textos da extração como texto, nunca como HTML. Não chamar a operação de confirmação automaticamente após a extração.

### Confirmar uma conta

```json
{
  "action": "confirm",
  "confirmed": true,
  "target": "bills",
  "fields": {
    "kind": "TIPO_EXISTENTE_NO_APP",
    "description": "Conta revisada",
    "amount": 150.25,
    "category": "Categoria revisada",
    "due_date": "2026-08-15",
    "counterparty": "Favorecido revisado",
    "notes": "Observação opcional"
  }
}
```

`TIPO_EXISTENTE_NO_APP` é um marcador de documentação, não um valor a enviar. O campo `kind` deve usar os valores reais adotados pelo app. O schema fornecido não informa as restrições ou convenções desse campo, portanto a função não inventa uma enumeração.

### Confirmar um lançamento no orçamento

Usar `target: "budget_entries"` e enviar `kind`, `description`, `amount`, `category` e `entry_date` dentro de `fields`. A data da transação deve ser revisada separadamente do vencimento. A extração não marca contas como pagas.

A confirmação insere exatamente um registro no destino escolhido e retorna `saved: true`, `target` e `id`. Não envia a imagem novamente ao modelo. A edição manual é aceita independentemente dos valores originalmente sugeridos. O servidor exige confirmação explícita, mas o gesto humano deve ser implementado na interface.

Desabilitar o botão enquanto a confirmação estiver em andamento. Não repetir automaticamente uma gravação após falha ou timeout: o schema não tem chave de idempotência para este fluxo. Conferir a lista de lançamentos antes de uma nova tentativa. Solicitações explícitas repetidas podem gerar registros repetidos.

## Verificações de aceite

- Sem sessão válida, extração e gravação são recusadas.
- Uma extração nunca grava no banco.
- Confirmar sem `confirmed: true` não grava.
- `user_id` e `id` enviados pelo cliente não são copiados para o registro.
- Valores negativos, datas inválidas e categorias vazias são recusados antes da gravação.
- Falhas do modelo não gravam e não expõem credenciais ou respostas internas.
- Testar isolamento com duas contas e revisar as políticas RLS existentes antes de disponibilizar o fluxo.

## Escopo restante

Ainda não implementados: interface React de upload e revisão, webhook WhatsApp com validação de assinatura e vínculo verificado em `whatsapp_connections`, telas de imóveis e aluguéis com `properties`, `rentals` e `rental_payments`, e configuração/processamento de `reminders` com registro do resultado de envio. O contexto desta entrega contém apenas o arquivo `readme`; as convenções de interface, os valores atuais de `kind`, as políticas RLS e os provedores de mensagens não estão documentados nele. Nenhum webhook ou envio automático foi ativado nesta etapa.
