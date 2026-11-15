# Relatórios, importação e exportação

Função autenticada `reports-transfer`. Não cria ou altera tabelas, políticas ou registros existentes. Usa SUPABASE_URL, SUPABASE_ANON_KEY e o JWT individual, como o serviço document-intake. Não utiliza service_role. Todas as consultas incluem user_id da sessão; todas as inserções fixam esse mesmo user_id.

## Acesso

POST /functions/v1/reports-transfer, com Authorization: Bearer <JWT da sessão> e Content-Type: application/json. Publique a função mantendo a validação de JWT. Para chamadas da interface, REPORTS_ALLOWED_ORIGINS aceita origens exatas separadas por vírgula; na ausência, usa DOCUMENT_ALLOWED_ORIGINS. Não aceita origem curinga. Respostas não são armazenáveis em cache.

A interface deve utilizar a sessão do cliente Supabase existente. Este módulo não implementa outra autenticação. Os arquivos da interface ainda não constam na lista do projeto; a função está pronta para integração, mas não acrescenta menus ou telas.

## Operações

### Opções e modelos

`{"action":"options"}` retorna tabelas, campos obrigatórios, tipos, referências, agrupamentos, campos de data e limites. Contas, orçamento, compromissos, imóveis, contratos, parcelas de aluguel, obras e custos permitem importação. Lembretes permitem somente relatório e exportação. Conexões de WhatsApp possuem apenas indicadores agregados em system_report; não permitem importação nem exportação de registros neste módulo.

`{"action":"template","table":"bills","separator":";"}` baixa um modelo CSV com cabeçalhos. Separadores aceitos: ponto e vírgula (padrão) ou vírgula.

### Relatórios

Exemplo: `{"action":"report","table":"bills","from":"2026-01-01","to":"2026-01-31","as_of":"2026-01-31"}`.

from e to são opcionais e inclusivos. Datas e horários são interpretados em UTC. O campo filtrado é informado na resposta:

- bills e rental_payments: due_date.
- budget_entries: entry_date.
- appointments: start_at.
- rentals: start_date, não sobreposição de contratos com o período.
- work_costs: cost_date.
- reminders: scheduled_at.
- properties e works: created_at.

Os relatórios retornam quantidade, totais monetários quando aplicável e grupos pelos campos originais:

- Contas e orçamento: kind e category.
- Contratos: property_id, kind e paid.
- Parcelas: rental_id e payment_status.
- Obras: status; o total é budget, não despesa realizada.
- Custos: work_id e category.
- Compromissos: location.
- Lembretes: channel e delivery_status.

Não se presume quais valores de kind significam receita ou despesa. Por isso, os totais são brutos, não saldo líquido. Não se somam contratos, parcelas, contas e orçamento entre si, evitando dupla contagem. Valores de contratos não são receita recebida.

Contas e parcelas incluem um resumo de pagamentos: pagos quando paid_at é anterior ou igual a as_of; abertos nos demais casos; vencidos quando também due_date é anterior a as_of. Vencidos são parte dos abertos. as_of é opcional e usa a data UTC atual por padrão. A classificação usa paid_at e não interpreta valores arbitrários de payment_status; o status original permanece nos agrupamentos. A data de referência não reconstrói versões históricas dos registros.

### Relatório consolidado por funcionalidade

A operação system_report consulta o banco com a sessão autenticada e não grava registros. Não exige table. Exemplo:

```json
{
  "action": "system_report",
  "from": "2026-01-01",
  "to": "2026-12-31",
  "as_of": "2026-12-31",
  "modules": ["financial", "rentals", "works", "agenda", "whatsapp"]
}
```

Omitir modules inclui todos os módulos. Uma lista vazia ou módulo desconhecido é recusado. from e to são opcionais e inclusivos. as_of é opcional, usa a data UTC atual e classifica pagamentos e eventos até o fim da data indicada; não limita os registros selecionados nem reconstrói o estado histórico do cadastro.

A resposta contém generated_at, timezone, from, to, as_of, modules, warnings e limits. Os nomes dos módulos também estão disponíveis em options.report_modules.

- financial: contas por vencimento e lançamentos por data da transação, com quantidade, totais brutos, agrupamentos por tipo e categoria e evolução mensal. Contas incluem valores e quantidades pagos, abertos e vencidos segundo paid_at.
- rentals: todos os imóveis acessíveis, contratos sobrepostos ao período e parcelas vencendo no período. by_property identifica cada imóvel pelo nome, detalha seus contratos e resume pagamentos por imóvel e contrato. Contratos com parcelas no período aparecem mesmo se o contrato não se sobrepuser ao período. Os tipos de aluguel são preservados sem presumir os valores usados para mensal ou temporada. A evolução mensal considera o vencimento das parcelas.
- works: todas as obras acessíveis, seus orçamentos atuais e status, custos por categoria e evolução mensal por cost_date. by_work relaciona nome, cliente, orçamento e custos no período. Não calcula saldo disponível com custos parciais.
- agenda: compromissos por start_at e local; lembretes por scheduled_at, canal e status de entrega. Inclui evolução mensal e contagens por data de referência. Compromissos passados não são tratados como realizados. Lembretes sem envio registrado não são classificados automaticamente como falhas.
- whatsapp: quantidade de vínculos criados no período, grupos por status atual, evolução mensal dos cadastros e contagem com data de verificação até as_of. Não consulta nem retorna telefones. Verificação não é sinônimo de conexão ativa.

As séries monthly incluem apenas meses com registros, em ordem cronológica. Períodos vazios retornam contagens e totais zero, quando aplicáveis, e séries vazias. Totais de diferentes funcionalidades não devem ser somados, pois podem representar o mesmo fato financeiro. A apuração de pagamentos conserva a regra paid_at dos relatórios individuais; payment_status permanece disponível nos agrupamentos.

Os vínculos de parcelas, contratos, imóveis, custos e obras são conferidos com os cadastros acessíveis à conta. Registros sem vínculo acessível são excluídos dos relatórios relacionais, com contadores excluded_links ou excluded_costs e aviso explícito; os relatórios individuais continuam mostrando os registros próprios conforme suas regras anteriores.

Cada leitura permite até 10.000 registros, sem truncamento silencioso. Cadastros de imóveis, contratos e obras são lidos sem filtro de criação para não perder vínculos antigos. Se esses cadastros excederem o limite, reduzir o período não basta: consulte os relatórios individuais com filtros de data ou selecione outros módulos. Uma falha impede a entrega do consolidado inteiro, sem totais parciais. As consultas não são um snapshot transacional.

Não há tabelas de histórico de processamento de documentos ou mensagens na estrutura informada. O relatório não estima extrações, mensagens enviadas ou confirmações de leitura. Esta entrega amplia a função de servidor; não cria uma tela nem altera a autenticação existente.

### Exportação

`{"action":"export","table":"budget_entries","format":"csv","from":"2026-01-01","to":"2026-12-31","separator":";"}`.

format aceita csv ou json. A resposta é o próprio arquivo, com Content-Disposition. CSV usa UTF-8 com BOM, aspas escapadas e proteção contra fórmulas de planilha. JSON inclui metadados e rows. Os arquivos incluem id e created_at, mas não user_id. Na interface, tratar a resposta como arquivo e oferecer download.

A leitura é paginada por id, com limite de 10.000 registros por operação. Se o limite for ultrapassado, a operação falha explicitamente, sem entregar um arquivo parcial. Reduza o período. As páginas não constituem um snapshot transacional: para conferências contábeis, evite editar os dados durante a exportação.

### Prévia de importação

Exemplo:

```json
{
  "action": "preview_import",
  "table": "bills",
  "format": "json",
  "rows": [
    {
      "kind": "tipo já utilizado no cadastro",
      "description": "Conta de energia",
      "category": "Energia",
      "amount": 150.25,
      "due_date": "2026-02-10"
    }
  ]
}
```

JSON aceita rows diretamente ou content com o texto do arquivo exportado (envelope com table e rows), ou ainda uma lista JSON. CSV aceita content como texto e separator. Não aceita XLSX ou PDF.

A prévia retorna os dados normalizados, avisos e requires_confirmation. Não grava nada. Erros indicam o número do registro, excluindo o cabeçalho do CSV. A confirmação revalida todos os dados e vínculos; a prévia não garante que as restrições do banco aceitarão tipos ou status arbitrários.

Datas: AAAA-MM-DD. Horários: ISO com fuso. Valores: número JSON ou texto com ponto/vírgula decimal, sem separador de milhar e com até duas casas decimais. Booleanos: true ou false. Campos opcionais vazios são convertidos para null. Valores monetários negativos são preservados quando aceitos pelas regras existentes do banco. Não se inventam tipos ou status.

Até 500 registros por lote e 2 MB por requisição. Todos os campos exigidos estão descritos em options. id e created_at do arquivo são ignorados; user_id e quaisquer outras colunas não permitidas causam erro. Os nomes das colunas são exatamente os do banco.

### Confirmação e repetição segura

Após revisão humana, reenviar os dados com action confirm_import, confirmed true e import_id gerado uma única vez por lote, no formato UUID. Exemplo de campos adicionais:

```json
{
  "action": "confirm_import",
  "confirmed": true,
  "import_id": "97c471bd-27df-4871-b797-c1b20b963421"
}
```

Esses campos devem acompanhar table, format e os mesmos dados revisados; o exemplo acima não é uma requisição completa.

Preserve import_id e a ordem/conteúdo normalizado do lote em caso de timeout ou repetição. IDs são derivados da conta, tabela, import_id, posição e conteúdo normalizado de cada registro. Repetições idênticas ignoram IDs existentes, sem sobrescrever. Alterar conteúdo, ordem ou import_id caracteriza outra importação e pode acrescentar registros. Esta proteção não detecta duplicatas de negócio previamente cadastradas por outros meios.

A gravação ocorre em uma única requisição de inserção por lote, sujeita às políticas RLS e restrições existentes. Um erro de validação do banco aborta o lote; nenhum registro existente é atualizado. A resposta informa inserted, already_present e record_ids na ordem do lote. Não há restauração de IDs antigos, exclusão ou substituição de dados.

Para dados relacionados, importe primeiro imóveis e obras, depois contratos e custos, e por último parcelas. Use os novos record_ids nos campos property_id, work_id e rental_id. Não existe restauração automática de um backup com remapeamento de vínculos. Referências são verificadas como pertencentes à conta autenticada; parcelas também verificam a propriedade vinculada ao contrato. Lembretes não são importados para evitar disparos acidentais.

## Verificações de aceite

1. Sem JWT válido, nenhuma operação retorna dados ou grava registros.
2. Uma conta não consegue consultar registros de outra, nem importar referências a imóveis, contratos ou obras de outra conta.
3. Prévia válida não altera contagens no banco; prévia inválida aponta os registros incorretos.
4. Confirmação sem confirmed ou import_id é recusada.
5. Repetir exatamente o mesmo lote com o mesmo import_id não acrescenta duplicatas.
6. Um registro recusado pelo banco impede a inserção do lote inteiro.
7. CSV com aspas, separadores e quebras de linha preserva os campos; texto com fórmula é neutralizado na exportação.
8. Exportações acima do limite falham explicitamente; nenhum relatório apresenta totais de uma seleção silenciosamente truncada.
9. Relatórios vazios retornam contagem zero, totais zero quando aplicáveis e grupos vazios.
10. Registros e integrações anteriores permanecem intactos.
