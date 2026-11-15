export {};

type Row = Record<string, unknown>;
type Field = { type: 'text' | 'money' | 'date' | 'timestamp' | 'uuid' | 'boolean' | 'integer'; required?: boolean; max?: number; min?: number };
type Spec = { fields: Record<string, Field>; date: string; groups: string[]; money?: string; importable: boolean; refs?: Record<string, string> };
const text = (required = false, max = 2000): Field => ({ type: 'text', required, max });
const money = (required = true): Field => ({ type: 'money', required });
const date = (required = true): Field => ({ type: 'date', required });
const uuid = (): Field => ({ type: 'uuid', required: true });
const SPECS: Record<string, Spec> = {
  bills: {
    fields: { kind: text(true, 100), description: text(true, 500), counterparty: text(false, 200), category: text(false, 100), amount: money(), due_date: date(), paid_at: date(false), barcode: text(false, 500), copy_link: text(false, 2000), notes: text() },
    date: 'due_date', groups: ['kind', 'category'], money: 'amount', importable: true,
  },
  budget_entries: {
    fields: { kind: text(true, 100), category: text(true, 100), description: text(false, 500), amount: money(), entry_date: date() },
    date: 'entry_date', groups: ['kind', 'category'], money: 'amount', importable: true,
  },
  appointments: {
    fields: { title: text(true, 500), start_at: { type: 'timestamp', required: true }, end_at: { type: 'timestamp' }, location: text(false, 500), notes: text() },
    date: 'start_at', groups: ['location'], importable: true,
  },
  properties: {
    fields: { name: text(true, 200), address: text(false, 500) },
    date: 'created_at', groups: [], importable: true,
  },
  rentals: {
    fields: { property_id: uuid(), kind: text(true, 100), tenant: text(true, 200), amount: money(), start_date: date(), end_date: date(false), due_day: { type: 'integer', min: 1, max: 31 }, paid: { type: 'boolean', required: true }, notes: text() },
    date: 'start_date', groups: ['property_id', 'kind', 'paid'], money: 'amount', importable: true, refs: { property_id: 'properties' },
  },
  rental_payments: {
    fields: { rental_id: uuid(), period_start: date(), period_end: date(), amount: money(), due_date: date(), payment_status: text(true, 100), paid_at: date(false) },
    date: 'due_date', groups: ['rental_id', 'payment_status'], money: 'amount', importable: true, refs: { rental_id: 'rentals' },
  },
  works: {
    fields: { name: text(true, 200), client: text(false, 200), address: text(false, 500), budget: money(), status: text(true, 100) },
    date: 'created_at', groups: ['status'], money: 'budget', importable: true,
  },
  work_costs: {
    fields: { work_id: uuid(), description: text(true, 500), category: text(false, 100), amount: money(), cost_date: date() },
    date: 'cost_date', groups: ['work_id', 'category'], money: 'amount', importable: true, refs: { work_id: 'works' },
  },
  reminders: {
    fields: { appointment_id: { type: 'uuid' }, bill_id: { type: 'uuid' }, rental_payment_id: { type: 'uuid' }, advance_minutes: { type: 'integer', min: 0 }, scheduled_at: { type: 'timestamp', required: true }, channel: text(true, 100), delivery_status: text(true, 100), sent_at: { type: 'timestamp' } },
    date: 'scheduled_at', groups: ['channel', 'delivery_status'], importable: false,
  },
};
const MAX_ROWS = 10000;
const MAX_IMPORT = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
class Problem extends Error {
  constructor(public status: number, message: string) { super(message); }
}
function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Problem(400, 'Informe um objeto JSON válido.');
  return value as Row;
}
function day(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Problem(400, 'Use datas no formato AAAA-MM-DD.');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Problem(400, 'Data inválida.');
  return value;
}
async function readBody(request: Request): Promise<Row> {
  if (!request.headers.get('content-type')?.includes('application/json')) throw new Problem(415, 'Envie application/json.');
  if (!request.body) throw new Problem(400, 'Conteúdo ausente.');
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let source = '';
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > 2 * 1024 * 1024) {
        await reader.cancel();
        throw new Problem(413, 'Use arquivos de até 2 MB e lotes de até 500 registros.');
      }
      source += decoder.decode(item.value, { stream: true });
    }
    source += decoder.decode();
  } finally { reader.releaseLock(); }
  try { return object(JSON.parse(source)); } catch (error) {
    if (error instanceof Problem) throw error;
    throw new Problem(400, 'JSON inválido.');
  }
}

type Session = { url: string; key: string; authorization: string; userId: string };
async function session(request: Request): Promise<Session> {
  const url = Deno.env.get('SUPABASE_URL')?.replace(/\/$/, '');
  const key = Deno.env.get('SUPABASE_ANON_KEY');
  if (!url || !key) throw new Problem(503, 'O serviço de relatórios está indisponível.');
  const authorization = request.headers.get('authorization') || '';
  if (!/^Bearer \S+$/i.test(authorization)) throw new Problem(401, 'Entre na sua conta para continuar.');
  const response = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: key, Authorization: authorization }, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Problem(response.status >= 500 ? 503 : 401, 'Não foi possível validar sua sessão.');
  const user = await response.json();
  if (typeof user.id !== 'string' || !UUID.test(user.id)) throw new Problem(401, 'Sessão inválida.');
  return { url, key, authorization, userId: user.id };
}
async function database(s: Session, table: string, query: Record<string, string>, rows?: Row[]): Promise<Row[]> {
  // JWT individual e filtro explícito de proprietário. Nunca utiliza service_role.
  const response = await fetch(`${s.url}/rest/v1/${table}?${new URLSearchParams(query)}`, {
    method: rows ? 'POST' : 'GET',
    headers: {
      apikey: s.key, Authorization: s.authorization, 'Content-Type': 'application/json',
      ...(rows ? { Prefer: 'resolution=ignore-duplicates,return=representation' } : {}),
    },
    body: rows ? JSON.stringify(rows) : undefined,
    signal: AbortSignal.timeout(25000),
  });
  if (!response.ok) {
    if (response.status === 401) throw new Problem(401, 'Sua sessão expirou. Entre novamente.');
    if (response.status === 403) throw new Problem(403, 'Operação não autorizada para sua conta.');
    if ([400, 409, 422].includes(response.status)) throw new Problem(422, 'O banco recusou a operação. Confira os campos, vínculos e valores de tipo e status usados no cadastro.');
    throw new Problem(502, 'Não foi possível concluir a operação. Se estava importando, repita o mesmo lote com o mesmo import_id para evitar duplicação.');
  }
  const data: unknown = await response.json();
  if (!Array.isArray(data)) throw new Problem(502, 'Resposta de dados inválida.');
  return data.map(object);
}
function columns(spec: Spec): string[] { return ['id', ...Object.keys(spec.fields), 'created_at']; }
function period(body: Row): { from?: string; to?: string } {
  const from = body.from === undefined ? undefined : day(body.from);
  const to = body.to === undefined ? undefined : day(body.to);
  if (from && to && from > to) throw new Problem(400, 'O início do período deve ser anterior ao fim.');
  return { from, to };
}
async function readRows(s: Session, table: string, spec: Spec, range: ReturnType<typeof period>): Promise<Row[]> {
  const query: Record<string, string> = { select: columns(spec).join(','), user_id: `eq.${s.userId}`, order: 'id.asc', limit: '500' };
  const isTimestamp = spec.date === 'created_at' || spec.fields[spec.date]?.type === 'timestamp';
  const filters: string[] = [];
  if (range.from) filters.push(`${spec.date}.gte.${range.from}${isTimestamp ? 'T00:00:00Z' : ''}`);
  if (range.to) filters.push(`${spec.date}.lte.${range.to}${isTimestamp ? 'T23:59:59.999999Z' : ''}`);
  if (filters.length) query.and = `(${filters.join(',')})`;
  const rows: Row[] = [];
  while (true) {
    const page = await database(s, table, query);
    if (!page.length) break;
    rows.push(...page);
    if (rows.length > MAX_ROWS) throw new Problem(413, 'O resultado excede 10.000 registros. Reduza o período; nenhum resultado parcial foi exportado.');
    const last = page[page.length - 1].id;
    if (typeof last !== 'string' || !UUID.test(last) || query.id === `gt.${last}`) throw new Problem(502, 'Não foi possível paginar os registros.');
    query.id = `gt.${last}`;
  }
  return rows;
}
function cents(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isSafeInteger(Math.round(number * 100))) throw new Problem(422, 'Há um valor monetário incompatível com o relatório.');
  return Math.round(number * 100);
}
function report(table: string, spec: Spec, rows: Row[], asOf: string): Row {
  const groups = new Map<string, { values: Row; count: number; cents: number }>();
  let total = 0;
  let paid = 0;
  let open = 0;
  let overdue = 0;
  let paidCount = 0;
  let openCount = 0;
  let overdueCount = 0;
  const dueBased = table === 'bills' || table === 'rental_payments';
  for (const row of rows) {
    const value = spec.money ? cents(row[spec.money]) : 0;
    total += value;
    if (!Number.isSafeInteger(total)) throw new Problem(422, 'O total excede o limite seguro de cálculo.');
    const key = JSON.stringify(spec.groups.map((field) => row[field] ?? null));
    const group = groups.get(key) || { values: Object.fromEntries(spec.groups.map((field) => [field, row[field] ?? null])), count: 0, cents: 0 };
    group.count++;
    group.cents += value;
    groups.set(key, group);
    if (dueBased) {
      if (row.paid_at && String(row.paid_at) <= asOf) { paid += value; paidCount++; }
      else {
        open += value; openCount++;
        if (String(row.due_date) < asOf) { overdue += value; overdueCount++; }
      }
    }
  }
  return {
    count: rows.length,
    ...(spec.money ? { monetary_field: spec.money, total: total / 100 } : {}),
    group_fields: spec.groups,
    groups: [...groups.values()].map((group) => ({ ...group.values, count: group.count, ...(spec.money ? { total: group.cents / 100 } : {}) })),
    ...(dueBased ? { payment_summary: { as_of: asOf, paid_count: paidCount, paid: paid / 100, open_count: openCount, open: open / 100, overdue_count: overdueCount, overdue: overdue / 100, criterion: 'paid_at até as_of; vencidas são um subconjunto das abertas' } } : {}),
    note: table === 'works' ? 'O total representa orçamento de obras, não despesas realizadas.' : table === 'rentals' ? 'O total representa valores de contratos, não receita recebida. Consulte rental_payments para parcelas.' : table === 'bills' || table === 'budget_entries' ? 'Totais brutos separados pelo tipo original do cadastro; não representam saldo líquido.' : null,
  };
}
const REPORT_MODULES = ['financial', 'rentals', 'works', 'agenda', 'whatsapp'] as const;
type ReportModule = typeof REPORT_MODULES[number];

function monthlyReport(table: string, spec: Spec, rows: Row[], asOf: string): Row[] {
  const months = new Map<string, Row[]>();
  for (const row of rows) {
    const month = String(row[spec.date]).slice(0, 7);
    const items = months.get(month) ?? [];
    items.push(row);
    months.set(month, items);
  }
  return [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, items]) => ({
    month, ...report(table, spec, items, asOf),
  }));
}
function reportSection(table: string, rows: Row[], asOf: string): Row {
  const spec = SPECS[table];
  return {
    date_field: spec.date,
    summary: report(table, spec, rows, asOf),
    monthly: monthlyReport(table, spec, rows, asOf),
  };
}
function indexRows(rows: Row[], field: string): Map<string, Row[]> {
  const result = new Map<string, Row[]>();
  for (const row of rows) {
    const key = String(row[field]);
    const items = result.get(key) ?? [];
    items.push(row);
    result.set(key, items);
  }
  return result;
}
function overlaps(row: Row, range: ReturnType<typeof period>): boolean {
  return (!range.to || String(row.start_date) <= range.to)
    && (!range.from || !row.end_date || String(row.end_date) >= range.from);
}
async function systemReport(s: Session, body: Row): Promise<Row> {
  const range = period(body);
  const asOf = body.as_of === undefined ? new Date().toISOString().slice(0, 10) : day(body.as_of);
  const requested = body.modules === undefined ? [...REPORT_MODULES] : body.modules;
  if (!Array.isArray(requested) || !requested.length || requested.some((item) => typeof item !== 'string' || !REPORT_MODULES.includes(item as ReportModule))) {
    throw new Problem(400, 'Escolha módulos: financial, rentals, works, agenda ou whatsapp.');
  }
  const selected = [...new Set(requested)] as ReportModule[];
  const modules: Row = {};
  const warnings: string[] = [
    'Cada módulo é apurado separadamente. Não some contas, lançamentos e parcelas: podem representar o mesmo fato financeiro.',
    'A data de referência classifica pagamentos, mas não reconstrói alterações históricas dos cadastros.',
    'As leituras não constituem um snapshot transacional. Evite editar os dados durante a conferência.',
  ];
  const read = (table: string, filter = range) => readRows(s, table, SPECS[table], filter);
  for (const module of selected) {
    if (module === 'financial') {
      const [bills, entries] = await Promise.all([read('bills'), read('budget_entries')]);
      modules.financial = {
        bills: reportSection('bills', bills, asOf),
        budget_entries: reportSection('budget_entries', entries, asOf),
        note: 'Contas filtradas pelo vencimento; lançamentos pela data da transação. Valores agrupados pelos tipos originais, sem presumir receita, despesa ou saldo líquido.',
      };
    }
    if (module === 'rentals') {
      // Cadastros anteriores ao período também podem ter parcelas vencendo nele.
      const [properties, contracts, payments] = await Promise.all([
        read('properties', {}), read('rentals', {}), read('rental_payments'),
      ]);
      const propertyIds = new Set(properties.map((row) => row.id));
      const ownedContracts = contracts.filter((row) => propertyIds.has(row.property_id));
      const contractIds = new Set(ownedContracts.map((row) => row.id));
      const ownedPayments = payments.filter((row) => contractIds.has(row.rental_id));
      const excludedContracts = contracts.length - ownedContracts.length;
      const excludedPayments = payments.length - ownedPayments.length;
      if (excludedContracts || excludedPayments) warnings.push('Aluguéis: vínculos sem imóvel ou contrato acessível à sua conta foram excluídos e contabilizados em excluded_links.');
      const contractsByProperty = indexRows(ownedContracts, 'property_id');
      const paymentsByRental = indexRows(ownedPayments, 'rental_id');
      const overlapping = ownedContracts.filter((row) => overlaps(row, range));
      modules.rentals = {
        properties_count: properties.length,
        contracts_overlapping_period: report('rentals', SPECS.rentals, overlapping, asOf),
        payments: reportSection('rental_payments', ownedPayments, asOf),
        excluded_links: { contracts: excludedContracts, payments: excludedPayments },
        by_property: properties.map((property) => {
          const linked = contractsByProperty.get(String(property.id)) ?? [];
          const relevant = linked.filter((row) => overlaps(row, range) || paymentsByRental.has(String(row.id)));
          const propertyPayments = linked.flatMap((row) => paymentsByRental.get(String(row.id)) ?? []);
          return {
            property_id: property.id, name: property.name,
            contracts_overlapping_period: linked.filter((row) => overlaps(row, range)).length,
            payments: report('rental_payments', SPECS.rental_payments, propertyPayments, asOf),
            contracts: relevant.map((contract) => ({
              rental_id: contract.id, tenant: contract.tenant, kind: contract.kind,
              amount: contract.amount, start_date: contract.start_date, end_date: contract.end_date,
              due_day: contract.due_day, paid: contract.paid,
              payments: report('rental_payments', SPECS.rental_payments, paymentsByRental.get(String(contract.id)) ?? [], asOf),
            })),
          };
        }),
        note: 'Inclui todos os imóveis acessíveis, contratos que se sobrepõem ao período e parcelas com vencimento no período. Tipos mensais ou de temporada são preservados como cadastrados. O campo paid do contrato não substitui a apuração de suas parcelas.',
      };
    }
    if (module === 'works') {
      const [works, costs] = await Promise.all([read('works', {}), read('work_costs')]);
      const workIds = new Set(works.map((row) => row.id));
      const ownedCosts = costs.filter((row) => workIds.has(row.work_id));
      const costsByWork = indexRows(ownedCosts, 'work_id');
      if (costs.length !== ownedCosts.length) warnings.push('Obras: custos sem obra acessível à sua conta foram excluídos e contabilizados em excluded_costs.');
      modules.works = {
        registered_works: report('works', SPECS.works, works, asOf),
        costs: reportSection('work_costs', ownedCosts, asOf),
        excluded_costs: costs.length - ownedCosts.length,
        by_work: works.map((work) => ({
          work_id: work.id, name: work.name, client: work.client, status: work.status, budget: work.budget,
          costs_in_period: report('work_costs', SPECS.work_costs, costsByWork.get(String(work.id)) ?? [], asOf),
        })),
        note: 'Inclui todas as obras acessíveis, mesmo cadastradas antes do período. Custos são filtrados por cost_date. O orçamento é o valor atual da obra; custos de um período não representam necessariamente seu custo acumulado.',
      };
    }
    if (module === 'agenda') {
      const [appointments, reminders] = await Promise.all([read('appointments'), read('reminders')]);
      const endOfDay = `${asOf}T23:59:59.999Z`;
      const endTime = Date.parse(endOfDay);
      modules.agenda = {
        appointments: {
          ...reportSection('appointments', appointments, asOf),
          started_by_reference_date: appointments.filter((row) => Date.parse(String(row.start_at)) <= endTime).length,
          starting_after_reference_date: appointments.filter((row) => Date.parse(String(row.start_at)) > endTime).length,
        },
        reminders: {
          ...reportSection('reminders', reminders, asOf),
          sent_by_reference_date: reminders.filter((row) => row.sent_at && Date.parse(String(row.sent_at)) <= endTime).length,
          scheduled_without_send_by_reference_date: reminders.filter((row) => Date.parse(String(row.scheduled_at)) <= endTime && (!row.sent_at || Date.parse(String(row.sent_at)) > endTime)).length,
        },
        note: 'Compromissos são filtrados por start_at; lembretes por scheduled_at. Indicadores usam o fim de as_of em UTC. Início passado não comprova realização do compromisso; ausência de sent_at não comprova falha de entrega. Status e canais são exibidos como cadastrados.',
      };
    }
    if (module === 'whatsapp') {
      // Não consultar números de telefone nem expor identificadores dos vínculos.
      const spec: Spec = {
        fields: { connection_status: text(true, 100), verified_at: { type: 'timestamp' } },
        date: 'created_at', groups: ['connection_status'], importable: false,
      };
      const connections = await readRows(s, 'whatsapp_connections', spec, range);
      const endTime = Date.parse(`${asOf}T23:59:59.999Z`);
      modules.whatsapp = {
        date_field: 'created_at',
        summary: report('whatsapp_connections', spec, connections, asOf),
        monthly: monthlyReport('whatsapp_connections', spec, connections, asOf),
        with_verification_by_reference_date: connections.filter((row) => row.verified_at && Date.parse(String(row.verified_at)) <= endTime).length,
        without_verification_date: connections.filter((row) => !row.verified_at).length,
        note: 'Vínculos criados no período, agrupados pelo status atual, sem divulgar telefones. Data de verificação não garante conexão ativa. Não há histórico de mensagens no banco informado.',
      };
    }
  }
  return {
    generated_at: new Date().toISOString(), timezone: 'UTC',
    from: range.from ?? null, to: range.to ?? null, as_of: asOf,
    modules, warnings,
    limits: { max_rows_per_source: MAX_ROWS, partial_results: false },
  };
}

function dangerousCell(value: string): boolean { return /^[\s]*[=+\-@]/.test(value) || /^[\t\r\n]/.test(value); }
function csv(rows: Row[], fields: string[], separator: string): string {
  const cell = (value: unknown) => {
    let raw = value === null || value === undefined ? '' : String(value);
    if (typeof value === 'string' && dangerousCell(raw)) raw = `\t${raw}`;
    return `"${raw.replace(/"/g, '""')}"`;
  };
  return '\uFEFF' + [fields.map(cell).join(separator), ...rows.map((row) => fields.map((field) => cell(row[field])).join(separator))].join('\r\n');
}
function parseCsv(source: string, separator: string): Row[] {
  source = source.replace(/^\uFEFF/, '');
  const lines: string[][] = [];
  let line: string[] = [];
  let field = '';
  let quoted = false;
  let closed = false;
  const pushField = () => { line.push(field); field = ''; closed = false; };
  const pushLine = () => {
    pushField();
    if (line.some((value) => value !== '')) lines.push(line);
    line = [];
    if (lines.length > MAX_IMPORT + 1) throw new Problem(413, 'Importe até 500 registros por lote.');
  };
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; closed = true; }
      } else field += char;
    } else if (char === separator) pushField();
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i++;
      pushLine();
    } else if (char === '"' && field === '' && !closed) quoted = true;
    else {
      if (closed || char === '"') throw new Problem(400, 'CSV inválido: confira aspas e separadores.');
      field += char;
    }
  }
  if (quoted) throw new Problem(400, 'CSV inválido: aspas não fechadas.');
  if (field !== '' || line.length || closed) pushLine();
  const header = lines.shift()?.map((value) => value.trim());
  if (!header?.length || header.some((value) => !value) || new Set(header).size !== header.length) throw new Problem(400, 'O CSV precisa de cabeçalhos únicos e não vazios.');
  return lines.map((values, index) => {
    if (values.length !== header.length) throw new Problem(400, `Registro ${index + 1}: quantidade de colunas diferente do cabeçalho.`);
    return Object.fromEntries(header.map((name, index) => {
      const value = values[index];
      return [name, value.startsWith('\t') && dangerousCell(value.slice(1)) ? value.slice(1) : value];
    }));
  });
}
function separator(body: Row): string {
  const value = body.separator ?? ';';
  if (value !== ';' && value !== ',') throw new Problem(400, 'Escolha vírgula ou ponto e vírgula como separador.');
  return value;
}
function parseField(value: unknown, spec: Field): unknown {
  if (value === undefined || value === null || value === '') {
    if (spec.required) throw new Problem(400, 'campo obrigatório');
    return null;
  }
  if (spec.type === 'text') {
    if (typeof value !== 'string' || value.length > (spec.max ?? 2000) || value.includes('\u0000') || (spec.required && !value.trim())) throw new Problem(400, 'texto inválido ou longo demais');
    return value;
  }
  if (spec.type === 'date') return day(value);
  if (spec.type === 'timestamp') {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Problem(400, 'use data e hora ISO com fuso, por exemplo 2026-01-15T14:30:00-03:00');
    day(value.slice(0, 10));
    if (!Number.isFinite(Date.parse(value))) throw new Problem(400, 'horário inválido');
    return new Date(value).toISOString();
  }
  if (spec.type === 'uuid') {
    if (typeof value !== 'string' || !UUID.test(value)) throw new Problem(400, 'identificador inválido');
    return value.toLowerCase();
  }
  if (spec.type === 'boolean') {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    throw new Problem(400, 'use true ou false');
  }
  let number: number;
  if (typeof value === 'number') number = value;
  else if (typeof value === 'string' && /^-?\d+(?:[.,]\d{1,2})?$/.test(value)) number = Number(value.replace(',', '.'));
  else throw new Problem(400, 'use um número sem separador de milhar');
  if (!Number.isFinite(number)) throw new Problem(400, 'número inválido');
  if (spec.type === 'money') {
    if (Math.abs(number) > 999999999.99 || Math.abs(number * 100 - Math.round(number * 100)) > 0.00001) throw new Problem(400, 'use até duas casas decimais e valor absoluto de até 999999999,99');
    return Math.round(number * 100) / 100;
  }
  if (!Number.isSafeInteger(number) || number < (spec.min ?? 0) || number > (spec.max ?? 2147483647)) throw new Problem(400, 'inteiro fora do intervalo permitido');
  return number;
}
function importRows(body: Row, table: string, spec: Spec): { rows: Row[]; errors: Row[]; count: number } {
  let raw: unknown;
  if (body.format === 'csv') {
    if (typeof body.content !== 'string') throw new Problem(400, 'Informe o conteúdo CSV.');
    raw = parseCsv(body.content, separator(body));
  } else if (body.format === 'json') {
    raw = body.rows;
    if (typeof body.content === 'string') {
      let parsed: unknown;
      try { parsed = JSON.parse(body.content); } catch { throw new Problem(400, 'Arquivo JSON inválido.'); }
      if (Array.isArray(parsed)) raw = parsed;
      else {
        const exported = object(parsed);
        if (exported.table !== table) throw new Problem(400, 'A tabela do arquivo difere do destino selecionado.');
        raw = exported.rows;
      }
    }
  } else throw new Problem(400, 'Escolha o formato csv ou json.');
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_IMPORT) throw new Problem(400, 'Informe entre 1 e 500 registros.');
  const rows: Row[] = [];
  const errors: Row[] = [];
  raw.forEach((item, index) => {
    try {
      const source = object(item);
      const extra = Object.keys(source).filter((key) => !Object.hasOwn(spec.fields, key) && key !== 'id' && key !== 'created_at');
      if (extra.length) throw new Problem(400, `Colunas não permitidas: ${extra.join(', ')}.`);
      const row: Row = {};
      for (const [name, field] of Object.entries(spec.fields)) {
        try { row[name] = parseField(source[name], field); }
        catch (error) { throw new Problem(400, `${name}: ${error instanceof Error ? error.message : 'valor inválido'}`); }
      }
      for (const [start, end] of [['start_at', 'end_at'], ['start_date', 'end_date'], ['period_start', 'period_end']]) {
        if (row[start] && row[end] && String(row[start]) > String(row[end])) throw new Problem(400, `${end} deve ser igual ou posterior a ${start}.`);
      }
      rows.push(row);
    } catch (error) {
      errors.push({ record: index + 1, message: error instanceof Error ? error.message : 'Registro inválido.' });
    }
  });
  return { rows, errors, count: raw.length };
}
async function checkReferences(s: Session, spec: Spec, rows: Row[]): Promise<void> {
  for (const [field, table] of Object.entries(spec.refs ?? {})) {
    const ids = [...new Set(rows.map((row) => String(row[field])))];
    for (let offset = 0; offset < ids.length; offset += 50) {
      const batch = ids.slice(offset, offset + 50);
      const found = await database(s, table, { select: table === 'rentals' ? 'id,property_id' : 'id', user_id: `eq.${s.userId}`, id: `in.(${batch.join(',')})`, limit: '50' });
      const owned = new Set(found.map((row) => row.id));
      if (batch.some((id) => !owned.has(id))) throw new Problem(422, `${field}: há vínculos inexistentes ou que não pertencem à sua conta.`);
      if (table === 'rentals') await checkReferences(s, SPECS.rentals, found);
    }
  }
}
async function importId(userId: string, table: string, batchId: string, index: number, row: Row): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(['reports-transfer-v1', userId, table, batchId, index, row]));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data)).slice(0, 16);
  hash[6] = (hash[6] & 15) | 80;
  hash[8] = (hash[8] & 63) | 128;
  const hex = [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

Deno.serve(async (request: Request) => {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Origin' });
  const origin = request.headers.get('origin');
  const origins = (Deno.env.get('REPORTS_ALLOWED_ORIGINS') || Deno.env.get('DOCUMENT_ALLOWED_ORIGINS') || '').split(',').map((item) => item.trim()).filter(Boolean);
  const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers });
  if (origin) {
    if (!origins.includes(origin)) return reply(403, { error: 'Origem não autorizada.' });
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Headers', 'authorization, apikey, content-type, x-client-info');
    headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    headers.set('Access-Control-Expose-Headers', 'Content-Disposition');
  }
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return reply(405, { error: 'Use POST.' });
  try {
    const s = await session(request);
    const body = await readBody(request);
    if (body.action === 'system_report') return reply(200, await systemReport(s, body));
    if (body.action === 'options') return reply(200, {
      tables: Object.entries(SPECS).map(([table, spec]) => ({ table, importable: spec.importable, fields: spec.fields, date_field: spec.date, group_fields: spec.groups, monetary_field: spec.money ?? null, references: spec.refs ?? {} })),
      report_modules: REPORT_MODULES, consolidated_report_action: 'system_report',
      formats: ['csv', 'json'], max_import_rows: MAX_IMPORT, max_result_rows: MAX_ROWS, default_separator: ';', timezone: 'UTC',
    });
    const table = typeof body.table === 'string' ? body.table : '';
    if (!Object.hasOwn(SPECS, table)) throw new Problem(400, 'Escolha uma tabela disponível em options.');
    const spec = SPECS[table];
    if (body.action === 'template') {
      if (!spec.importable) throw new Problem(400, 'Esta tabela não permite importação.');
      headers.set('Content-Type', 'text/csv; charset=utf-8');
      headers.set('Content-Disposition', `attachment; filename="modelo-${table}.csv"`);
      return new Response(csv([], Object.keys(spec.fields), separator(body)), { headers });
    }
    if (body.action === 'report' || body.action === 'export') {
      const range = period(body);
      const asOf = body.as_of === undefined ? new Date().toISOString().slice(0, 10) : day(body.as_of);
      if (body.action === 'export' && body.format !== 'json' && body.format !== 'csv') throw new Problem(400, 'Escolha csv ou json.');
      const rows = await readRows(s, table, spec, range);
      const metadata = { table, generated_at: new Date().toISOString(), timezone: 'UTC', date_field: spec.date, from: range.from ?? null, to: range.to ?? null };
      if (body.action === 'report') return reply(200, { ...metadata, ...report(table, spec, rows, asOf) });
      headers.set('Content-Disposition', `attachment; filename="${table}-${asOf}.${body.format}"`);
      if (body.format === 'json') return reply(200, { version: 1, ...metadata, count: rows.length, rows });
      headers.set('Content-Type', 'text/csv; charset=utf-8');
      return new Response(csv(rows, columns(spec), separator(body)), { headers });
    }
    if (body.action === 'preview_import' || body.action === 'confirm_import') {
      if (!spec.importable) throw new Problem(400, 'Lembretes não podem ser importados, para evitar disparos acidentais.');
      const result = importRows(body, table, spec);
      if (result.errors.length) return reply(422, { saved: false, count: result.count, errors: result.errors });
      await checkReferences(s, spec, result.rows);
      if (body.action === 'preview_import') return reply(200, {
        saved: false, requires_confirmation: true, table, count: result.count, rows: result.rows,
        warnings: ['A importação acrescenta registros; não altera os existentes.', 'id e created_at do arquivo são ignorados. user_id é definido pela sessão.', 'Tipos e status são preservados e sujeitos às regras existentes do banco.', 'Uma nova importação do mesmo conteúdo com outro import_id criará novos registros.'],
      });
      if (body.confirmed !== true) throw new Problem(400, 'Revise a prévia e confirme explicitamente a importação.');
      if (typeof body.import_id !== 'string' || !UUID.test(body.import_id)) throw new Problem(400, 'Informe import_id como UUID e reutilize-o ao repetir exatamente o mesmo lote.');
      const batchId = body.import_id.toLowerCase();
      const records = await Promise.all(result.rows.map(async (row, index) => ({ ...row, id: await importId(s.userId, table, batchId, index, row), user_id: s.userId })));
      // Um único INSERT em lote: falha de validação do banco não deixa metade do lote gravada.
      // Conflitos de ID são ignorados, nunca atualizados. Repetir o mesmo lote é seguro.
      const inserted = await database(s, table, { on_conflict: 'id', select: 'id' }, records);
      return reply(200, { saved: true, table, import_id: batchId, submitted: records.length, inserted: inserted.length, already_present: records.length - inserted.length, record_ids: records.map((row) => row.id) });
    }
    throw new Problem(400, 'Use options, template, report, system_report, export, preview_import ou confirm_import.');
  } catch (error) {
    if (error instanceof Problem) return reply(error.status, { error: error.message });
    return reply(502, { error: 'Não foi possível concluir a solicitação. Se estava importando, consulte os registros ou repita exatamente o mesmo lote e import_id.' });
  }
});
