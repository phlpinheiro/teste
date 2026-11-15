type Data = Record<string, unknown>;
type Config = {
  url: string;
  serviceKey: string;
  appSecret: string;
  verifyToken: string;
  accessToken: string;
  phoneId: string;
  version: string;
  verifiedStatus: string;
};

class InputError extends Error {}

function record(value: unknown): Data {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error('Configuração incompleta.');
  return value;
}

function config(): Config {
  const version = requiredEnv('WHATSAPP_GRAPH_VERSION');
  const phoneId = requiredEnv('WHATSAPP_PHONE_NUMBER_ID');
  if (!/^v\d+\.\d+$/.test(version) || !/^\d+$/.test(phoneId)) throw new Error('Configuração inválida.');
  return {
    url: requiredEnv('SUPABASE_URL').replace(/\/$/, ''),
    serviceKey: requiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
    appSecret: requiredEnv('WHATSAPP_APP_SECRET'),
    verifyToken: requiredEnv('WHATSAPP_VERIFY_TOKEN'),
    accessToken: requiredEnv('WHATSAPP_ACCESS_TOKEN'),
    phoneId,
    version,
    verifiedStatus: requiredEnv('WHATSAPP_VERIFIED_STATUS'),
  };
}

async function readRaw(request: Request): Promise<Uint8Array> {
  if (!request.body) throw new InputError('Corpo ausente.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 256 * 1024) {
        await reader.cancel();
        throw new InputError('Corpo muito grande.');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function validSignature(raw: Uint8Array, signature: string, secret: string): Promise<boolean> {
  if (!/^sha256=[a-fA-F0-9]{64}$/.test(signature)) return false;
  const bytes = Uint8Array.from(signature.slice(7).match(/../g)!, (pair) => parseInt(pair, 16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return await crypto.subtle.verify('HMAC', key, bytes, raw);
}

async function sameSecret(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  const x = new Uint8Array(left);
  const y = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < x.length; index++) difference |= x[index] ^ y[index];
  return difference === 0;
}

// Caminhos de tabela e filtros são definidos somente neste servidor.
async function database(c: Config, table: string, query: Record<string, string>, row?: Data): Promise<Data[]> {
  const response = await fetch(`${c.url}/rest/v1/${table}?${new URLSearchParams(query)}`, {
    method: row ? 'POST' : 'GET',
    headers: {
      apikey: c.serviceKey,
      Authorization: `Bearer ${c.serviceKey}`,
      'Content-Type': 'application/json',
      ...(row ? { Prefer: 'resolution=ignore-duplicates,return=representation' } : {}),
    },
    body: row ? JSON.stringify(row) : undefined,
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error('Falha na operação de dados.');
  const result: unknown = await response.json();
  if (!Array.isArray(result)) throw new Error('Resposta de dados inválida.');
  return result.map(record);
}

async function owner(c: Config, phone: string): Promise<string | null> {
  const rows = await database(c, 'whatsapp_connections', {
    select: 'user_id,phone_number,verified_at,connection_status',
    phone_number: `in.(${phone},+${phone})`,
    connection_status: `eq.${c.verifiedStatus}`,
    verified_at: 'not.is.null',
    limit: '2',
  });
  // Ambiguidade nunca é resolvida escolhendo arbitrariamente uma pessoa.
  if (rows.length !== 1) return null;
  const userId = rows[0].user_id;
  const verifiedAt = rows[0].verified_at;
  if (typeof userId !== 'string' || !/^[0-9a-f-]{36}$/i.test(userId)) return null;
  if (typeof verifiedAt !== 'string' || !Number.isFinite(Date.parse(verifiedAt)) || Date.parse(verifiedAt) > Date.now()) return null;
  return userId;
}

async function send(c: Config, phone: string, message: string): Promise<void> {
  const response = await fetch(`https://graph.facebook.com/${c.version}/${c.phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'text',
      text: { preview_url: false, body: message.slice(0, 4000) },
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error('Falha no envio da resposta.');
}

function field(value: string | undefined, label: string, max: number): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > max || /[\u0000-\u001f]/.test(trimmed)) {
    throw new InputError(`${label}: preencha até ${max} caracteres, sem quebras de linha.`);
  }
  return trimmed;
}

function money(value: string | undefined): number {
  const raw = value?.trim() || '';
  if (!/^\d{1,9}([.,]\d{1,2})?$/.test(raw)) throw new InputError('Valor inválido. Use, por exemplo, 150,25, sem separador de milhar.');
  return Math.round(Number(raw.replace(',', '.')) * 100) / 100;
}

function day(value: string | undefined): string {
  const raw = value?.trim() || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new InputError('Use uma data no formato AAAA-MM-DD.');
  const parsed = new Date(`${raw}T12:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) throw new InputError('Data inválida.');
  return raw;
}

function display(value: unknown, max = 90): string {
  return String(value ?? '—').replace(/[\r\n\u0000-\u001f]/g, ' ').slice(0, max);
}

function currency(value: unknown): string {
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(number) : '—';
}

function list(title: string, rows: Data[], render: (row: Data) => string): string {
  return rows.length ? `${title}\n${rows.map(render).join('\n')}\n\nExibindo até 10 registros. Para outras opções, envie AJUDA.` : `${title}\nNenhum registro encontrado.`;
}

async function messageUuid(userId: string, messageId: string, table: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(['whatsapp', userId, messageId, table]))));
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const HELP = [
  'Comandos disponíveis:',
  'CONTAS — próximas contas não pagas, incluindo vencidas.',
  'LANCAMENTOS — últimos lançamentos do orçamento.',
  'COMPROMISSOS — próximos compromissos (horários em UTC).',
  'IMOVEIS — imóveis e seus identificadores.',
  'ALUGUEIS <id do imóvel> — contratos desse imóvel.',
  'HISTORICO <id do aluguel> — últimos pagamentos, vencimentos e status.',
  '',
  'Para cadastrar, revise todos os campos e envie uma única mensagem:',
  'CONFIRMAR CONTA | tipo | descrição | valor | AAAA-MM-DD | categoria',
  'CONFIRMAR LANCAMENTO | tipo | descrição | valor | AAAA-MM-DD | categoria',
  '',
  'CONTA usa a data de vencimento. LANCAMENTO usa a data da transação.',
  'Use o tipo já utilizado no seu cadastro, sem inventar abreviações. Valor: 150,25, sem separador de milhar.',
  'O envio de CONFIRMAR autoriza a gravação. Uma nova mensagem cria um novo registro, mesmo com campos iguais.',
  'Imagens ainda não são processadas por este canal. Não envie senhas ou dados bancários.',
].join('\n');

function uuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new InputError('Identificador inválido. Consulte IMOVEIS e depois ALUGUEIS <id do imóvel>.');
  return value;
}

async function command(c: Config, userId: string, messageId: string, input: string): Promise<string> {
  if (input.length > 2000) throw new InputError('Mensagem muito longa. Envie AJUDA para consultar os comandos.');
  const normalized = input.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  const scope = { user_id: `eq.${userId}`, limit: '10' };
  if (normalized === 'CONTAS') {
    const rows = await database(c, 'bills', { ...scope, select: 'description,amount,due_date,kind', paid_at: 'is.null', order: 'due_date.asc,id.asc' });
    return list('Contas não pagas:', rows, (r) => `${display(r.due_date)} · ${display(r.description)} · ${currency(r.amount)} · ${display(r.kind, 40)}`);
  }
  if (normalized === 'LANCAMENTOS') {
    const rows = await database(c, 'budget_entries', { ...scope, select: 'description,amount,entry_date,kind,category', order: 'entry_date.desc,created_at.desc,id.desc' });
    return list('Últimos lançamentos:', rows, (r) => `${display(r.entry_date)} · ${display(r.description)} · ${currency(r.amount)} · ${display(r.kind, 40)} · ${display(r.category, 40)}`);
  }
  if (normalized === 'COMPROMISSOS') {
    const rows = await database(c, 'appointments', { ...scope, select: 'title,start_at,location', start_at: `gte.${new Date().toISOString()}`, order: 'start_at.asc,id.asc' });
    return list('Próximos compromissos (UTC):', rows, (r) => `${display(r.start_at)} · ${display(r.title)} · ${display(r.location)}`);
  }
  if (normalized === 'IMOVEIS') {
    const rows = await database(c, 'properties', { ...scope, select: 'id,name', order: 'name.asc,id.asc' });
    return list('Imóveis:', rows, (r) => `${display(r.name)}\nID: ${display(r.id)}`);
  }
  if (normalized.startsWith('ALUGUEIS ')) {
    const propertyId = uuid(normalized.slice(9).trim());
    const properties = await database(c, 'properties', { ...scope, select: 'id,name', id: `eq.${propertyId}`, limit: '1' });
    if (!properties.length) return 'Imóvel não encontrado no seu cadastro.';
    const rows = await database(c, 'rentals', { ...scope, select: 'id,tenant,kind,amount,start_date,end_date', property_id: `eq.${propertyId}`, order: 'start_date.desc,id.desc' });
    return list(`Aluguéis de ${display(properties[0].name)}:`, rows, (r) => `${display(r.tenant)} · ${display(r.kind, 40)} · ${currency(r.amount)}\n${display(r.start_date)} a ${display(r.end_date)}\nID: ${display(r.id)}`);
  }
  if (normalized.startsWith('HISTORICO ')) {
    const rentalId = uuid(normalized.slice(10).trim());
    const rentals = await database(c, 'rentals', { ...scope, select: 'id,property_id', id: `eq.${rentalId}`, limit: '1' });
    if (!rentals.length) return 'Aluguel não encontrado no seu cadastro.';
    const propertyId = uuid(String(rentals[0].property_id));
    const properties = await database(c, 'properties', { ...scope, select: 'id,name', id: `eq.${propertyId}`, limit: '1' });
    if (!properties.length) return 'Imóvel não encontrado no seu cadastro.';
    const rows = await database(c, 'rental_payments', { ...scope, select: 'period_start,period_end,amount,due_date,payment_status,paid_at', rental_id: `eq.${rentalId}`, order: 'due_date.desc,id.desc' });
    return list(`Histórico de ${display(properties[0].name)}:`, rows, (r) => `${display(r.period_start)} a ${display(r.period_end)} · ${currency(r.amount)}\nVencimento: ${display(r.due_date)} · Status: ${display(r.payment_status, 40)} · Pago em: ${display(r.paid_at)}`);
  }
  const parts = input.split('|');
  const action = parts[0].trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  if (action === 'CONFIRMAR CONTA' || action === 'CONFIRMAR LANCAMENTO') {
    if (parts.length !== 6) throw new InputError('Envie exatamente: CONFIRMAR CONTA ou CONFIRMAR LANCAMENTO | tipo | descrição | valor | AAAA-MM-DD | categoria');
    const table = action === 'CONFIRMAR CONTA' ? 'bills' : 'budget_entries';
    const row: Data = {
      id: await messageUuid(userId, messageId, table),
      user_id: userId,
      kind: field(parts[1], 'Tipo', 100),
      description: field(parts[2], 'Descrição', 500),
      amount: money(parts[3]),
      category: field(parts[5], 'Categoria', 100),
      [table === 'bills' ? 'due_date' : 'entry_date']: day(parts[4]),
    };
    // O mesmo ID de mensagem sempre produz o mesmo ID de registro. Nunca atualizar por conflito.
    const inserted = await database(c, table, { on_conflict: 'id', select: 'id' }, row);
    if (!inserted.length) return 'Esta mensagem já foi registrada anteriormente. Consulte CONTAS ou LANCAMENTOS para conferir.';
    return `${table === 'bills' ? 'Conta' : 'Lançamento'} registrado: ${display(row.description)} · ${currency(row.amount)}.\nConsulte ${table === 'bills' ? 'CONTAS' : 'LANCAMENTOS'} para conferir.`;
  }
  return HELP;
}

async function processMessage(c: Config, value: Data, message: Data): Promise<void> {
  if (record(value.metadata).phone_number_id !== c.phoneId) return;
  const phone = message.from;
  const messageId = message.id;
  if (typeof phone !== 'string' || !/^[1-9]\d{7,14}$/.test(phone)) return;
  if (typeof messageId !== 'string' || !messageId || messageId.length > 512) return;
  const userId = await owner(c, phone);
  if (!userId) {
    await send(c, phone, 'Não há um vínculo verificado e exclusivo disponível para este número. Nenhum dado foi consultado ou alterado. O acesso exige um vínculo verificado com sua conta.');
    return;
  }
  let reply: string;
  try {
    const text = record(message.text).body;
    reply = message.type === 'text' && typeof text === 'string'
      ? await command(c, userId, messageId, text)
      : 'Este canal recebe apenas comandos de texto nesta etapa. Envie AJUDA. Nenhum documento foi processado ou salvo.';
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    reply = error.message;
  }
  // Revalidar antes da resposta, inclusive após uma eventual revogação durante a consulta.
  if (await owner(c, phone) !== userId) return;
  await send(c, phone, reply);
}

Deno.serve(async (request: Request) => {
  const headers = { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' };
  const reply = (status: number, message: string) => new Response(message, { status, headers });
  if (request.method !== 'GET' && request.method !== 'POST') return reply(405, 'Método não permitido.');
  try {
    if (request.method === 'GET') {
      const params = new URL(request.url).searchParams;
      const challenge = params.get('hub.challenge') || '';
      if (params.get('hub.mode') !== 'subscribe' || !/^\d{1,100}$/.test(challenge)) return reply(403, 'Verificação recusada.');
      if (!await sameSecret(params.get('hub.verify_token') || '', requiredEnv('WHATSAPP_VERIFY_TOKEN'))) return reply(403, 'Verificação recusada.');
      return reply(200, challenge);
    }
    const c = config();
    const raw = await readRaw(request);
    if (!await validSignature(raw, request.headers.get('x-hub-signature-256') || '', c.appSecret)) return reply(401, 'Assinatura inválida.');
    let body: Data;
    try {
      body = record(JSON.parse(new TextDecoder().decode(raw)));
    } catch {
      return reply(400, 'JSON inválido.');
    }
    if (body.object !== 'whatsapp_business_account') return reply(400, 'Evento inválido.');
    const entries = Array.isArray(body.entry) ? body.entry : [];
    for (const entry of entries) {
      const changes = record(entry).changes;
      if (!Array.isArray(changes)) continue;
      for (const change of changes) {
        if (record(change).field !== 'messages') continue;
        const value = record(record(change).value);
        if (!Array.isArray(value.messages)) continue;
        for (const message of value.messages) await processMessage(c, value, record(message));
      }
    }
    return reply(200, 'EVENT_RECEIVED');
  } catch (error) {
    if (error instanceof InputError) return reply(400, error.message);
    // Sem logs de mensagens, telefones, documentos, tokens ou respostas do banco.
    // Erro transitório não é confirmado: a Meta poderá repetir o evento.
    return reply(503, 'Não foi possível concluir o evento.');
  }
});
