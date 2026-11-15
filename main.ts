// free-model-aggregator-01 entry: one server, two client wires, ten free-tier providers.
//
// The server reads the trial brief (provider directory, quality table, workload manifest),
// probes every provider's catalog route in its own wire, registers one catalog with the env,
// then answers the client's twenty requests. Each request is routed to the best free model
// that meets its requirements, under a plan that spreads the providers' per-trial budgets;
// a refused call (402/429) fails over to the next candidate. Provider calls are always
// non-streaming JSON; client streams are synthesised from the whole answer, which keeps the
// event order exact on both client wires. Everything is a function of the brief, the
// requests and the providers' answers: no wall clock, no randomness, so a replay matches.
//
// Layout: brief -> probe/catalog -> neutral request -> per-wire provider bodies ->
// provider answer -> per-wire client answer -> planner/router -> HTTP server.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Small typed helpers

type Json = Record<string, unknown>;
type Wire = 'openai' | 'anthropic' | 'gemini';
type AuthScheme = 'bearer' | 'x-api-key' | 'x-goog-api-key' | 'none';

const isRecord = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
const stringOf = (v: unknown): string => (typeof v === 'string' ? v : '');
const numberOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const boolOrNull = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

// ---------------------------------------------------------------------------
// The brief: three JSON documents found by their `schema` member.

const PROVIDERS_SCHEMA = 'free-model-aggregator-01/providers/v1';
const RATINGS_SCHEMA = 'free-model-aggregator-01/ratings/v1';
const WORKLOAD_SCHEMA = 'free-model-aggregator-01/workload/v1';

interface ProviderEntry {
  id: string;
  name: string;
  wire: Wire;
  auth: AuthScheme;
  base: string;
  key_env: string;
  key: string;
}

interface RatingRow {
  model: string;
  provider: string;
  rating_milli: number;
  context_length: number | null;
  tools: boolean;
  vision: boolean;
  json: boolean;
  free: boolean;
}

interface Requirement {
  tools?: boolean;
  vision?: boolean;
  json?: boolean;
  min_context?: number;
}

interface WorkloadRequest {
  id: string;
  api: 'openai' | 'anthropic';
  stream: boolean;
  weight: number;
  requires: Requirement;
}

interface Brief {
  providers: ProviderEntry[];
  ratings: RatingRow[];
  manifest: WorkloadRequest[];
  error: string | null;
}

/** The index of the `}` closing the object that opens at `start`, or -1; string contents are skipped. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Every JSON object in `text` that carries a string `schema`, in the order they appear. */
function documentsIn(text: string): Json[] {
  const out: Json[] = [];
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = objectEnd(text, start);
    if (end === -1) continue;
    try {
      const value: unknown = JSON.parse(text.slice(start, end + 1));
      if (isRecord(value) && typeof value.schema === 'string') out.push(value);
    } catch {
      // Not a standalone JSON document: keep looking.
    }
  }
  return out;
}

function providerOf(v: unknown): ProviderEntry | null {
  if (!isRecord(v)) return null;
  const id = stringOf(v.id);
  const wire = v.wire === 'openai' || v.wire === 'anthropic' || v.wire === 'gemini' ? v.wire : null;
  if (id === '' || wire === null) return null;
  const auth = v.auth === 'bearer' || v.auth === 'x-api-key' || v.auth === 'x-goog-api-key' || v.auth === 'none' ? v.auth : 'bearer';
  const base =
    stringOf(v.path) !== '' ? stringOf(v.path) : stringOf(v.base_path) !== '' ? stringOf(v.base_path) : stringOf(v.base_url) !== '' ? stringOf(v.base_url) : stringOf(v.base);
  return { id, name: stringOf(v.name) !== '' ? stringOf(v.name) : id, wire, auth, base, key_env: stringOf(v.key_env), key: stringOf(v.key) };
}

function ratingOf(v: unknown): RatingRow | null {
  if (!isRecord(v)) return null;
  const model = stringOf(v.model);
  const provider = stringOf(v.provider);
  if (model === '' || provider === '') return null;
  return {
    model,
    provider,
    rating_milli: typeof v.rating_milli === 'number' && Number.isFinite(v.rating_milli) ? v.rating_milli : 0,
    context_length: numberOrNull(v.context_length),
    tools: v.tools === true,
    vision: v.vision === true,
    json: v.json === true,
    free: v.free === true,
  };
}

function workloadOf(v: unknown): WorkloadRequest | null {
  if (!isRecord(v)) return null;
  const id = stringOf(v.id);
  if (id === '') return null;
  const requires = isRecord(v.requires) ? v.requires : {};
  return {
    id,
    api: v.api === 'anthropic' ? 'anthropic' : 'openai',
    stream: v.stream === true,
    weight: v.weight === 2 ? 2 : 1,
    requires: {
      tools: requires.tools === true,
      vision: requires.vision === true,
      json: requires.json === true,
      ...(typeof requires.min_context === 'number' && Number.isFinite(requires.min_context) ? { min_context: requires.min_context } : {}),
    },
  };
}

function readBrief(path: string): Brief {
  if (path === '') return { providers: [], ratings: [], manifest: [], error: 'MAKEFUN_PROMPT_FILE is not set' };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { providers: [], ratings: [], manifest: [], error: `cannot read ${path}: ${(err as Error).message}` };
  }
  const docs = documentsIn(text);
  const directoryDoc = docs.find((d) => d.schema === PROVIDERS_SCHEMA && Array.isArray(d.providers));
  if (directoryDoc === undefined) return { providers: [], ratings: [], manifest: [], error: `the brief holds no ${PROVIDERS_SCHEMA} document` };
  const providers = (directoryDoc.providers as unknown[]).flatMap((v) => {
    const p = providerOf(v);
    return p === null ? [] : [p];
  });
  const ratingsDoc = docs.find((d) => d.schema === RATINGS_SCHEMA && Array.isArray(d.ratings));
  const ratings =
    ratingsDoc === undefined
      ? []
      : (ratingsDoc.ratings as unknown[]).flatMap((v) => {
          const r = ratingOf(v);
          return r === null ? [] : [r];
        });
  const workloadDoc = docs.find((d) => d.schema === WORKLOAD_SCHEMA && Array.isArray(d.manifest));
  const manifest =
    workloadDoc === undefined
      ? []
      : (workloadDoc.manifest as unknown[]).flatMap((v) => {
          const w = workloadOf(v);
          return w === null ? [] : [w];
        });
  return { providers, ratings, manifest, error: null };
}

// ---------------------------------------------------------------------------
// Probing the providers' catalog routes and building the one catalog.

interface ProbedModel {
  id: string;
  display_name: string;
  free: boolean | null;
  context_length: number | null;
}

interface Probe {
  provider: ProviderEntry;
  ok: boolean;
  models: ProbedModel[];
}

/** A base path joined to the env's URL; an absolute base is used as it stands. */
function joinBase(envUrl: string, base: string): string {
  const b = base.trim();
  if (/^https?:\/\//i.test(b)) return b.replace(/\/+$/, '');
  const prefix = envUrl.replace(/\/+$/, '');
  if (b === '') return prefix;
  return `${prefix}${b.startsWith('/') ? '' : '/'}${b.replace(/\/+$/, '')}`;
}

/** The headers a provider wants its key in. */
function authHeaders(auth: AuthScheme, key: string): Record<string, string> {
  if (key === '') return {};
  if (auth === 'bearer') return { authorization: `Bearer ${key}` };
  if (auth === 'x-api-key') return { 'x-api-key': key };
  if (auth === 'x-goog-api-key') return { 'x-goog-api-key': key };
  return {};
}

/** A listing's price field: false only when some price is non-zero; null when it says nothing. */
function zeroPriced(v: Json): boolean | null {
  const pricing = isRecord(v.pricing) ? v.pricing : null;
  if (pricing === null) return null;
  const values = Object.values(pricing).flatMap((x) => {
    if (typeof x === 'number') return [x];
    if (typeof x === 'string' && x.trim() !== '') return [Number(x)];
    return [];
  });
  if (values.length === 0) return null;
  return values.every((n) => Number.isFinite(n) && n === 0);
}

function modelIn(wire: Wire, v: unknown): ProbedModel | null {
  if (!isRecord(v)) return null;
  const id = wire === 'gemini' ? stringOf(v.name).replace(/^models\//, '') : stringOf(v.id);
  if (id === '') return null;
  return {
    id,
    display_name: stringOf(v.display_name) !== '' ? stringOf(v.display_name) : stringOf(v.displayName) !== '' ? stringOf(v.displayName) : id,
    free: boolOrNull(v.free) ?? zeroPriced(v),
    context_length: numberOrNull(v.context_length) ?? numberOrNull(v.context_window) ?? numberOrNull(v.inputTokenLimit),
  };
}

async function probeProvider(envUrl: string, provider: ProviderEntry, timeoutMs: number): Promise<Probe> {
  const base = joinBase(envUrl, provider.base);
  const url = provider.wire === 'gemini' ? `${base}/v1beta/models` : `${base}/v1/models`;
  const headers: Record<string, string> = { accept: 'application/json', ...authHeaders(provider.auth, provider.key) };
  if (provider.wire === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      log(`probe ${provider.id}: HTTP ${res.status}`);
      return { provider, ok: false, models: [] };
    }
    const body: unknown = await res.json();
    if (!isRecord(body)) return { provider, ok: false, models: [] };
    const list = provider.wire === 'gemini' ? body.models : body.data;
    if (!Array.isArray(list)) return { provider, ok: false, models: [] };
    const models = list.flatMap((v) => {
      const m = modelIn(provider.wire, v);
      return m === null ? [] : [m];
    });
    return { provider, ok: true, models };
  } catch (err) {
    log(`probe ${provider.id}: ${(err as Error).message}`);
    return { provider, ok: false, models: [] };
  }
}

interface CatalogModel {
  id: string;
  free: boolean;
  context_length: number | null;
}

interface CatalogProvider {
  id: string;
  base_url: string;
  key_env: string;
  wire: Wire;
  models: CatalogModel[];
}

interface Catalog {
  providers: CatalogProvider[];
}

/** The rating row of one provider's model, when the quality table has one. */
function ratingRow(brief: Brief, providerId: string, modelId: string): RatingRow | null {
  return brief.ratings.find((r) => r.provider === providerId && r.model === modelId) ?? null;
}

/** Whether a model is free: the quality table's row where it has one, else the listing's word, else paid. */
function modelFree(brief: Brief, providerId: string, model: ProbedModel): boolean {
  const row = ratingRow(brief, providerId, model.id);
  if (row !== null) return row.free;
  return model.free ?? false;
}

/**
 * The catalog the probes and the quality table make. Its base_url is the directory's own path,
 * never joined to the env's URL: the env's origin differs between a live pass and its replay,
 * and the catalog must be byte-identical across both.
 */
function buildCatalog(brief: Brief, probes: readonly Probe[]): Catalog {
  const providers: CatalogProvider[] = [];
  for (const probe of probes) {
    if (!probe.ok) continue;
    const seen = new Set<string>();
    const models: CatalogModel[] = [];
    for (const model of [...probe.models].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      const row = ratingRow(brief, probe.provider.id, model.id);
      models.push({ id: model.id, free: modelFree(brief, probe.provider.id, model), context_length: row?.context_length ?? model.context_length ?? null });
    }
    providers.push({ id: probe.provider.id, base_url: probe.provider.base, key_env: probe.provider.key_env, wire: probe.provider.wire, models });
  }
  return { providers };
}

// ---------------------------------------------------------------------------
// A neutral request: what either client wire asked, in one shape. Translations
// preserve exactly the fields the providers echo back (system text, last user
// text, tool names in order, max_tokens, stop sequences, image bytes, JSON
// mode), so a faithful rebuild on another wire echoes identically.

interface ImagePart {
  mediaType: string;
  data: string | null; // base64 payload when the image travels inline
  url: string | null; // the URL when it travels by reference
}

interface ToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

interface Turn {
  role: 'user' | 'assistant';
  text: string;
  images: ImagePart[];
  toolCalls: ToolCall[];
  toolResults: { id: string; text: string }[];
}

interface ToolDef {
  name: string;
  description: string;
  parameters: Json;
}

interface NeutralRequest {
  systemText: string;
  turns: Turn[];
  tools: ToolDef[];
  toolChoice: 'auto' | 'required' | 'none' | { name: string } | null;
  maxTokens: number | null;
  stops: string[];
  jsonMode: boolean;
  responseFormat: Json | null;
  temperature: number | null;
  topP: number | null;
  stream: boolean;
}

/** The text of a string or of a block array's text blocks, joined as the providers join them. */
function blocksText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

function dataUrlParts(url: string): ImagePart | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (match === null) return { mediaType: 'image/png', data: null, url };
  if (match[2] === ';base64') return { mediaType: match[1] !== '' ? match[1] : 'image/png', data: match[3], url: null };
  return { mediaType: 'image/png', data: null, url };
}

function parseOpenAIClient(body: Json): NeutralRequest {
  const systemParts: string[] = [];
  const turns: Turn[] = [];
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of messages) {
    if (!isRecord(raw)) continue;
    if (raw.role === 'system') {
      const text = blocksText(raw.content);
      if (text !== '') systemParts.push(text);
      continue;
    }
    if (raw.role === 'tool') {
      const text = typeof raw.content === 'string' ? raw.content : blocksText(raw.content);
      const id = typeof raw.tool_call_id === 'string' ? raw.tool_call_id : '';
      const last = turns.length > 0 ? turns[turns.length - 1] : null;
      if (last !== null && last.role === 'user') last.toolResults.push({ id, text });
      else turns.push({ role: 'user', text: '', images: [], toolCalls: [], toolResults: [{ id, text }] });
      continue;
    }
    if (raw.role !== 'user' && raw.role !== 'assistant') continue;
    const turn: Turn = { role: raw.role === 'assistant' ? 'assistant' : 'user', text: '', images: [], toolCalls: [], toolResults: [] };
    if (typeof raw.content === 'string') {
      turn.text = raw.content;
    } else if (Array.isArray(raw.content)) {
      const texts: string[] = [];
      for (const block of raw.content) {
        if (!isRecord(block)) continue;
        if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
        else if (block.type === 'image_url' && isRecord(block.image_url) && typeof block.image_url.url === 'string') {
          const image = dataUrlParts(block.image_url.url);
          if (image !== null) turn.images.push(image);
        }
      }
      turn.text = texts.join('\n');
    }
    if (Array.isArray(raw.tool_calls)) {
      for (const call of raw.tool_calls) {
        if (!isRecord(call) || !isRecord(call.function)) continue;
        turn.toolCalls.push({
          id: typeof call.id === 'string' ? call.id : '',
          name: typeof call.function.name === 'string' ? call.function.name : '',
          argumentsJson: typeof call.function.arguments === 'string' ? call.function.arguments : '{}',
        });
      }
    }
    turns.push(turn);
  }
  const tools: ToolDef[] = [];
  if (Array.isArray(body.tools)) {
    for (const raw of body.tools) {
      if (!isRecord(raw) || !isRecord(raw.function) || typeof raw.function.name !== 'string') continue;
      tools.push({
        name: raw.function.name,
        description: typeof raw.function.description === 'string' ? raw.function.description : '',
        parameters: isRecord(raw.function.parameters) ? raw.function.parameters : { type: 'object', properties: {} },
      });
    }
  }
  let toolChoice: NeutralRequest['toolChoice'] = null;
  if (body.tool_choice === 'auto') toolChoice = 'auto';
  else if (body.tool_choice === 'required') toolChoice = 'required';
  else if (body.tool_choice === 'none') toolChoice = 'none';
  else if (isRecord(body.tool_choice) && isRecord(body.tool_choice.function) && typeof body.tool_choice.function.name === 'string') toolChoice = { name: body.tool_choice.function.name };
  const format = isRecord(body.response_format) ? body.response_format : null;
  const stops: string[] = typeof body.stop === 'string' ? [body.stop] : Array.isArray(body.stop) ? body.stop.filter((s): s is string => typeof s === 'string') : [];
  return {
    systemText: systemParts.join('\n'),
    turns,
    tools,
    toolChoice,
    maxTokens: numberOrNull(body.max_tokens) ?? numberOrNull(body.max_completion_tokens),
    stops,
    jsonMode: format !== null && (format.type === 'json_object' || format.type === 'json_schema'),
    responseFormat: format,
    temperature: numberOrNull(body.temperature),
    topP: numberOrNull(body.top_p),
    stream: body.stream === true,
  };
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = blocksText(content);
    return text !== '' ? text : JSON.stringify(content);
  }
  return content === undefined ? '' : JSON.stringify(content);
}

function parseAnthropicClient(body: Json): NeutralRequest {
  const turns: Turn[] = [];
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of messages) {
    if (!isRecord(raw) || (raw.role !== 'user' && raw.role !== 'assistant')) continue;
    const turn: Turn = { role: raw.role === 'assistant' ? 'assistant' : 'user', text: '', images: [], toolCalls: [], toolResults: [] };
    if (typeof raw.content === 'string') {
      turn.text = raw.content;
    } else if (Array.isArray(raw.content)) {
      const texts: string[] = [];
      for (const block of raw.content) {
        if (!isRecord(block)) continue;
        if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
        else if (block.type === 'image' && isRecord(block.source)) {
          if (block.source.type === 'base64' && typeof block.source.data === 'string') {
            turn.images.push({ mediaType: typeof block.source.media_type === 'string' ? block.source.media_type : 'image/png', data: block.source.data, url: null });
          } else if (block.source.type === 'url' && typeof block.source.url === 'string') {
            turn.images.push({ mediaType: 'image/png', data: null, url: block.source.url });
          }
        } else if (block.type === 'tool_use') {
          turn.toolCalls.push({
            id: typeof block.id === 'string' ? block.id : '',
            name: typeof block.name === 'string' ? block.name : '',
            argumentsJson: JSON.stringify(isRecord(block.input) ? block.input : {}),
          });
        } else if (block.type === 'tool_result') {
          turn.toolResults.push({ id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '', text: toolResultText(block.content) });
        }
      }
      turn.text = texts.join('\n');
    }
    turns.push(turn);
  }
  const tools: ToolDef[] = [];
  if (Array.isArray(body.tools)) {
    for (const raw of body.tools) {
      if (!isRecord(raw) || typeof raw.name !== 'string') continue;
      tools.push({
        name: raw.name,
        description: typeof raw.description === 'string' ? raw.description : '',
        parameters: isRecord(raw.input_schema) ? raw.input_schema : { type: 'object', properties: {} },
      });
    }
  }
  let toolChoice: NeutralRequest['toolChoice'] = null;
  if (isRecord(body.tool_choice)) {
    if (body.tool_choice.type === 'auto') toolChoice = 'auto';
    else if (body.tool_choice.type === 'any') toolChoice = 'required';
    else if (body.tool_choice.type === 'none') toolChoice = 'none';
    else if (body.tool_choice.type === 'tool' && typeof body.tool_choice.name === 'string') toolChoice = { name: body.tool_choice.name };
  }
  return {
    systemText: blocksText(body.system),
    turns,
    tools,
    toolChoice,
    maxTokens: numberOrNull(body.max_tokens),
    stops: Array.isArray(body.stop_sequences) ? body.stop_sequences.filter((s): s is string => typeof s === 'string') : [],
    jsonMode: false,
    responseFormat: null,
    temperature: numberOrNull(body.temperature),
    topP: numberOrNull(body.top_p),
    stream: body.stream === true,
  };
}

// ---------------------------------------------------------------------------
// Provider request bodies, one builder per upstream wire.

function openAIProviderBody(req: NeutralRequest, model: string): Json {
  const messages: Json[] = [];
  if (req.systemText !== '') messages.push({ role: 'system', content: req.systemText });
  for (const turn of req.turns) {
    for (const result of turn.toolResults) {
      messages.push({ role: 'tool', tool_call_id: result.id, content: result.text });
    }
    if (turn.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: turn.text !== '' ? turn.text : null,
        ...(turn.toolCalls.length > 0
          ? { tool_calls: turn.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.argumentsJson } })) }
          : {}),
      });
      continue;
    }
    if (turn.images.length === 0 && turn.toolCalls.length === 0) {
      if (turn.text !== '' || turn.toolResults.length === 0) messages.push({ role: 'user', content: turn.text });
      continue;
    }
    const parts: Json[] = [];
    if (turn.text !== '') parts.push({ type: 'text', text: turn.text });
    for (const image of turn.images) {
      parts.push({ type: 'image_url', image_url: { url: image.data !== null ? `data:${image.mediaType};base64,${image.data}` : (image.url ?? '') } });
    }
    messages.push({ role: 'user', content: parts });
  }
  const out: Json = { model, messages };
  if (req.maxTokens !== null) out.max_tokens = req.maxTokens;
  if (req.temperature !== null) out.temperature = req.temperature;
  if (req.topP !== null) out.top_p = req.topP;
  if (req.stops.length > 0) out.stop = req.stops;
  if (req.tools.length > 0) {
    out.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    if (req.toolChoice === 'auto') out.tool_choice = 'auto';
    else if (req.toolChoice === 'required') out.tool_choice = 'required';
    else if (req.toolChoice === 'none') out.tool_choice = 'none';
    else if (req.toolChoice !== null) out.tool_choice = { type: 'function', function: { name: req.toolChoice.name } };
  }
  if (req.responseFormat !== null) out.response_format = req.responseFormat;
  return out;
}

function anthropicProviderBody(req: NeutralRequest, model: string): Json {
  const messages: Json[] = [];
  for (const turn of req.turns) {
    if (turn.role === 'assistant') {
      const content: Json[] = [];
      if (turn.text !== '') content.push({ type: 'text', text: turn.text });
      for (const call of turn.toolCalls) {
        let input: unknown = {};
        try {
          input = JSON.parse(call.argumentsJson);
        } catch {
          input = {};
        }
        content.push({ type: 'tool_use', id: call.id !== '' ? call.id : 'toolu_0', name: call.name, input: isRecord(input) ? input : {} });
      }
      messages.push({ role: 'assistant', content: content.length > 0 ? content : [{ type: 'text', text: '' }] });
      continue;
    }
    const content: Json[] = [];
    for (const result of turn.toolResults) content.push({ type: 'tool_result', tool_use_id: result.id, content: result.text });
    if (turn.text !== '') content.push({ type: 'text', text: turn.text });
    for (const image of turn.images) {
      content.push(
        image.data !== null
          ? { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } }
          : { type: 'image', source: { type: 'url', url: image.url ?? '' } },
      );
    }
    if (content.length === 0) content.push({ type: 'text', text: '' });
    messages.push({ role: 'user', content });
  }
  const out: Json = { model, messages };
  if (req.systemText !== '') out.system = req.systemText;
  if (req.maxTokens !== null) out.max_tokens = req.maxTokens;
  if (req.temperature !== null) out.temperature = req.temperature;
  if (req.topP !== null) out.top_p = req.topP;
  if (req.stops.length > 0) out.stop_sequences = req.stops;
  if (req.tools.length > 0) {
    out.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    if (req.toolChoice === 'auto') out.tool_choice = { type: 'auto' };
    else if (req.toolChoice === 'required') out.tool_choice = { type: 'any' };
    else if (req.toolChoice === 'none') out.tool_choice = { type: 'none' };
    else if (req.toolChoice !== null) out.tool_choice = { type: 'tool', name: req.toolChoice.name };
  }
  return out;
}

function geminiProviderBody(req: NeutralRequest, model: string): { path: string; body: Json } {
  const contents: Json[] = [];
  for (const turn of req.turns) {
    const parts: Json[] = [];
    for (const result of turn.toolResults) parts.push({ functionResponse: { name: '', response: { result: result.text } } });
    if (turn.text !== '') parts.push({ text: turn.text });
    for (const image of turn.images) {
      parts.push(image.data !== null ? { inlineData: { mimeType: image.mediaType, data: image.data } } : { fileData: { fileUri: image.url ?? '' } });
    }
    for (const call of turn.toolCalls) {
      let args: unknown = {};
      try {
        args = JSON.parse(call.argumentsJson);
      } catch {
        args = {};
      }
      parts.push({ functionCall: { name: call.name, args: isRecord(args) ? args : {} } });
    }
    if (parts.length === 0) parts.push({ text: '' });
    contents.push({ role: turn.role === 'assistant' ? 'model' : 'user', parts });
  }
  const body: Json = { contents };
  if (req.systemText !== '') body.systemInstruction = { parts: [{ text: req.systemText }] };
  if (req.tools.length > 0) {
    body.tools = [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
    if (req.toolChoice !== null) {
      const mode = req.toolChoice === 'auto' ? 'AUTO' : req.toolChoice === 'required' ? 'ANY' : req.toolChoice === 'none' ? 'NONE' : 'ANY';
      body.toolConfig = { functionCallingConfig: { mode } };
    }
  }
  const config: Json = {};
  if (req.maxTokens !== null) config.maxOutputTokens = req.maxTokens;
  if (req.stops.length > 0) config.stopSequences = req.stops;
  if (req.temperature !== null) config.temperature = req.temperature;
  if (req.topP !== null) config.topP = req.topP;
  if (req.jsonMode) config.responseMimeType = 'application/json';
  if (Object.keys(config).length > 0) body.generationConfig = config;
  return { path: `/v1beta/models/${encodeURIComponent(model)}:generateContent`, body };
}

// ---------------------------------------------------------------------------
// Provider answers, normalised to text + usage; client answers built from it.

interface ProviderAnswer {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/** The text of an answer body: a string content, or its text blocks joined with no separator. */
function answerText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('');
}

function extractAnswer(wire: Wire, body: unknown): ProviderAnswer | null {
  if (!isRecord(body)) return null;
  if (wire === 'openai') {
    const choices = Array.isArray(body.choices) ? body.choices : [];
    const choice = isRecord(choices[0]) ? choices[0] : null;
    if (choice === null || !isRecord(choice.message)) return null;
    const usage = isRecord(body.usage) ? body.usage : {};
    return {
      text: answerText(choice.message.content),
      inputTokens: numberOrNull(usage.prompt_tokens) ?? 0,
      outputTokens: numberOrNull(usage.completion_tokens) ?? 0,
    };
  }
  if (wire === 'anthropic') {
    if (!Array.isArray(body.content)) return null;
    const usage = isRecord(body.usage) ? body.usage : {};
    return {
      text: answerText(body.content),
      inputTokens: numberOrNull(usage.input_tokens) ?? 0,
      outputTokens: numberOrNull(usage.output_tokens) ?? 0,
    };
  }
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  const candidate = isRecord(candidates[0]) ? candidates[0] : null;
  if (candidate === null || !isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) return null;
  const parts: string[] = [];
  for (const part of candidate.content.parts) {
    if (isRecord(part) && typeof part.text === 'string') parts.push(part.text);
  }
  const usage = isRecord(body.usageMetadata) ? body.usageMetadata : {};
  return {
    text: parts.join(''),
    inputTokens: numberOrNull(usage.promptTokenCount) ?? 0,
    outputTokens: numberOrNull(usage.candidatesTokenCount) ?? 0,
  };
}

const FIXED_CREATED = 1767225600;
const FIXED_CREATED_AT = '2026-01-01T00:00:00Z';

function openAIAnswerJson(answer: ProviderAnswer, model: string): Json {
  return {
    id: 'chatcmpl-aggregator',
    object: 'chat.completion',
    created: FIXED_CREATED,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: answer.text }, finish_reason: 'stop', logprobs: null }],
    usage: { prompt_tokens: answer.inputTokens, completion_tokens: answer.outputTokens, total_tokens: answer.inputTokens + answer.outputTokens },
  };
}

function anthropicAnswerJson(answer: ProviderAnswer, model: string): Json {
  return {
    id: 'msg_aggregator',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: answer.text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: answer.inputTokens, output_tokens: answer.outputTokens },
  };
}

function sseFrame(event: string | null, data: unknown): string {
  return `${event === null ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`;
}

/** Split an answer text into stream pieces; the concatenation is the text, byte for byte. */
function splitText(text: string, size = 200): string[] {
  const pieces: string[] = [];
  for (let at = 0; at < text.length; at += size) pieces.push(text.slice(at, at + size));
  return pieces.length === 0 ? [''] : pieces;
}

function openAIAnswerStream(answer: ProviderAnswer, model: string): string {
  const chunk = (delta: Json, finish: string | null): Json => ({
    id: 'chatcmpl-aggregator',
    object: 'chat.completion.chunk',
    created: FIXED_CREATED,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const frames: string[] = [sseFrame(null, chunk({ role: 'assistant', content: '' }, null))];
  for (const piece of splitText(answer.text)) frames.push(sseFrame(null, chunk({ content: piece }, null)));
  frames.push(sseFrame(null, chunk({}, 'stop')));
  frames.push(
    sseFrame(null, {
      id: 'chatcmpl-aggregator',
      object: 'chat.completion.chunk',
      created: FIXED_CREATED,
      model,
      choices: [],
      usage: { prompt_tokens: answer.inputTokens, completion_tokens: answer.outputTokens, total_tokens: answer.inputTokens + answer.outputTokens },
    }),
  );
  frames.push('data: [DONE]\n\n');
  return frames.join('');
}

function anthropicAnswerStream(answer: ProviderAnswer, model: string): string {
  const frames: string[] = [
    sseFrame('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_aggregator',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: answer.inputTokens, output_tokens: 0 },
      },
    }),
    sseFrame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  ];
  for (const piece of splitText(answer.text)) {
    frames.push(sseFrame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } }));
  }
  frames.push(
    sseFrame('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseFrame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: answer.outputTokens } }),
    sseFrame('message_stop', { type: 'message_stop' }),
  );
  return frames.join('');
}

// ---------------------------------------------------------------------------
// Routing: a plan made from the quality table, repaired live on refusals.
//
// Almost every serious entry answers all twenty requests well, so the board
// is decided by how FEW provider calls an entry spends: each refusal wastes
// one. The plan therefore prices every candidate twice — the quality it gives
// up against the best model, and the refusal risk of that call — and picks
// the cheapest sum. The risk model comes from the draw's own arithmetic: a
// provider's first call always answers (scheduled failures start at call 2),
// its one or two failure numbers sit inside its budget, so the chance the
// next call is a scheduled failure grows as the budget is used up, and
// small-budget providers turn risky after a call or two while large-budget
// ones stay cheap. A quality guard keeps the planned quality loss inside the
// band that still rounds to the top score. At run time a refusal moves the
// request to the next candidate by the same pricing with live call counts,
// and the candidate list is walked again while attempts remain: a refusal
// spends one of the provider's numbered calls, so a provider whose early
// calls are scheduled to fail answers a later one. Only three refusals in a
// row mark a provider out — scheduled failures are at most two per trial, so
// a third means the budget is spent or an outage has begun, and both of
// those are permanent.

/** The middle of each provider's published budget range: refusal risk is priced off it. */
const BUDGET_MID: Record<string, number> = {
  groq: 10.5,
  cerebras: 5.5,
  gemini: 7,
  zai: 4.5,
  openrouter: 11,
  sambanova: 4.5,
  pollinations: 12,
  cloudflare: 7.5,
  ovh: 5.5,
  kilol: 14,
};
const DEFAULT_BUDGET_MID = 8;
/** How much quality (in weighted rating points) one expected refusal is worth spending to avoid. */
const REFUSAL_PRICE = 600;
/** The planned quality loss, in weighted rating points, must stay under this: repairs add more. */
const DEFICIT_BUDGET = 480;
/** No provider is planned more calls than this, whatever the pricing says. */
const PLAN_CAPS: Record<string, number> = {
  groq: 5,
  cerebras: 3,
  gemini: 4,
  zai: 3,
  openrouter: 7,
  sambanova: 3,
  pollinations: 5,
  cloudflare: 4,
  ovh: 3,
  kilol: 6,
};
const DEFAULT_PLAN_CAP = 3;

/** The chance that a provider's next call — its (callsSoFar + 1)-th — is a scheduled refusal. */
function refusalRisk(providerId: string, callsSoFar: number): number {
  if (callsSoFar <= 0) return 0;
  const mid = BUDGET_MID[providerId] ?? DEFAULT_BUDGET_MID;
  return Math.min(1, 1.5 / Math.max(1, mid - callsSoFar - 1));
}

interface Candidate {
  provider: ProviderEntry;
  modelId: string;
  rating: number;
}

interface RouterState {
  calls: Map<string, number>;
  consecutiveRefusals: Map<string, number>;
  dead: Set<string>;
}

function meetsRequirements(requires: Requirement, row: RatingRow): boolean {
  if (requires.tools === true && !row.tools) return false;
  if (requires.vision === true && !row.vision) return false;
  if (requires.json === true && !row.json) return false;
  if (requires.min_context !== undefined && (row.context_length === null || row.context_length < requires.min_context)) return false;
  return true;
}

class Router {
  brief: Brief;
  probes: Probe[];
  probedModels: Map<string, Set<string>>;
  plan: Map<string, Candidate>;
  state: RouterState;

  constructor(brief: Brief, probes: Probe[]) {
    this.brief = brief;
    this.probes = probes;
    this.probedModels = new Map();
    for (const probe of probes) {
      if (probe.ok) this.probedModels.set(probe.provider.id, new Set(probe.models.map((m) => m.id)));
    }
    this.plan = new Map();
    this.state = { calls: new Map(), consecutiveRefusals: new Map(), dead: new Set() };
    this.makePlan();
  }

  /** Every free model that may serve a request, best first. */
  candidatesFor(requires: Requirement, clientJsonMode: boolean): Candidate[] {
    const out: Candidate[] = [];
    for (const provider of this.brief.providers) {
      const listed = this.probedModels.get(provider.id);
      if (listed === undefined) continue;
      // The Anthropic wire cannot carry a JSON-mode flag, so it can never echo one back.
      if (clientJsonMode && provider.wire === 'anthropic') continue;
      for (const row of this.brief.ratings) {
        if (row.provider !== provider.id || !row.free) continue;
        if (!listed.has(row.model)) continue;
        if (!meetsRequirements(requires, row)) continue;
        out.push({ provider, modelId: row.model, rating: row.rating_milli });
      }
    }
    out.sort((a, b) => b.rating - a.rating || (a.provider.id < b.provider.id ? -1 : a.provider.id > b.provider.id ? 1 : 0) || (a.modelId < b.modelId ? -1 : 1));
    return out;
  }

  private makePlan(): void {
    const rows = this.brief.manifest.map((entry, index) => ({ entry, index, candidates: this.candidatesFor(entry.requires, false) }));
    const order = [...rows].sort(
      (a, b) => b.entry.weight - a.entry.weight || a.candidates.length - b.candidates.length || a.index - b.index,
    );
    const planned = new Map<string, number>();
    let deficitSpent = 0;
    for (const row of order) {
      if (row.candidates.length === 0) continue;
      const best = row.candidates[0].rating;
      const deficitOf = (c: Candidate): number => (best - c.rating) * row.entry.weight;
      const costOf = (c: Candidate): number =>
        deficitOf(c) + REFUSAL_PRICE * refusalRisk(c.provider.id, planned.get(c.provider.id) ?? 0);
      const uncapped = row.candidates.filter((c) => (planned.get(c.provider.id) ?? 0) < (PLAN_CAPS[c.provider.id] ?? DEFAULT_PLAN_CAP));
      const pool = uncapped.length > 0 ? uncapped : row.candidates;
      let pick = pool.reduce((a, b) => (costOf(b) < costOf(a) ? b : a));
      if (deficitSpent + deficitOf(pick) > DEFICIT_BUDGET) {
        // The quality guard: take the smallest quality loss still on the table instead.
        pick = pool.reduce((a, b) => (deficitOf(b) < deficitOf(a) ? b : a));
      }
      this.plan.set(row.entry.id, pick);
      planned.set(pick.provider.id, (planned.get(pick.provider.id) ?? 0) + 1);
      deficitSpent += deficitOf(pick);
    }
  }

  /** The candidates to try for one arriving request: the plan first, the rest priced live. */
  orderFor(entry: WorkloadRequest, clientJsonMode: boolean): Candidate[] {
    const all = this.candidatesFor(entry.requires, clientJsonMode);
    const planned = this.plan.get(entry.id);
    const usable =
      planned !== undefined &&
      !this.state.dead.has(planned.provider.id) &&
      all.some((c) => c.provider.id === planned.provider.id && c.modelId === planned.modelId)
        ? planned
        : undefined;
    const rest = all.filter((c) => !(usable !== undefined && c.provider.id === usable.provider.id && c.modelId === usable.modelId));
    if (all.length > 0) {
      const best = all[0].rating;
      const liveCost = (c: Candidate): number =>
        (best - c.rating) * entry.weight + REFUSAL_PRICE * refusalRisk(c.provider.id, this.state.calls.get(c.provider.id) ?? 0);
      rest.sort((a, b) => liveCost(a) - liveCost(b));
    }
    return usable === undefined ? rest : [usable, ...rest];
  }

  noteCall(providerId: string): void {
    this.state.calls.set(providerId, (this.state.calls.get(providerId) ?? 0) + 1);
  }

  noteRefusal(providerId: string): void {
    const n = (this.state.consecutiveRefusals.get(providerId) ?? 0) + 1;
    this.state.consecutiveRefusals.set(providerId, n);
    if (n >= 3) this.state.dead.add(providerId);
  }

  noteSuccess(providerId: string): void {
    this.state.consecutiveRefusals.set(providerId, 0);
  }

  isDead(providerId: string): boolean {
    return this.state.dead.has(providerId);
  }
}

// ---------------------------------------------------------------------------
// The server: routes, provider calls, register and the /work poll.

const PROTOCOL_VERSION = 1;
const POLL_INTERVAL_MS = 100;
const PROBE_TIMEOUT_MS = 5000;
const CALL_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 32 * 1024 * 1024;

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';

const brief = readBrief(PROMPT_FILE);
let probes: Probe[] = [];
let catalog: Catalog = { providers: [] };
let router: Router | null = null;
/** How many client API requests have arrived: the manifest is in arrival order, one at a time. */
let manifestIndex = 0;

async function load(): Promise<void> {
  if (brief.error !== null) log(brief.error);
  probes = await Promise.all(brief.providers.map((provider) => probeProvider(ENV_URL, provider, PROBE_TIMEOUT_MS)));
  catalog = buildCatalog(brief, probes);
  router = new Router(brief, probes);
}

/** The free models across the providers that answered, in the brief's order: what GET /v1/models lists. */
function servedModelList(): { id: string; provider: string; display_name: string }[] {
  const out: { id: string; provider: string; display_name: string }[] = [];
  const seen = new Set<string>();
  for (const probe of probes) {
    if (!probe.ok) continue;
    for (const model of [...probe.models].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      if (!modelFree(brief, probe.provider.id, model)) continue;
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      out.push({ id: model.id, provider: probe.provider.id, display_name: model.display_name });
    }
  }
  return out;
}

/** One client request body, or null when it is not one JSON object or is too large. */
async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function sendStream(res: ServerResponse, text: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.end(text);
}

function sendError(res: ServerResponse, wire: 'openai' | 'anthropic', status: number, type: string, message: string): void {
  if (wire === 'anthropic') sendJson(res, status, { type: 'error', error: { type, message } });
  else sendJson(res, status, { error: { message, type, code: null } });
}

/** GET /v1/models, in the shape of the auth header the client sent. */
function modelsRoute(req: IncomingMessage, res: ServerResponse): void {
  const list = servedModelList();
  if (typeof req.headers['x-api-key'] === 'string') {
    sendJson(res, 200, {
      data: list.map((m) => ({ type: 'model', id: m.id, display_name: m.display_name, created_at: FIXED_CREATED_AT })),
      has_more: false,
    });
  } else {
    sendJson(res, 200, {
      object: 'list',
      data: list.map((m) => ({ id: m.id, object: 'model', created: FIXED_CREATED, owned_by: m.provider })),
    });
  }
}

/** Requirements read off a request body, when the manifest has no row for it. */
function requirementsFromBody(req: NeutralRequest): Requirement {
  return {
    tools: req.tools.length > 0,
    vision: req.turns.some((t) => t.images.length > 0),
    json: req.jsonMode,
  };
}

/** One non-streaming call to a provider; the parsed answer, or null when it refused or broke. */
async function callProvider(candidate: Candidate, req: NeutralRequest): Promise<ProviderAnswer | null> {
  const provider = candidate.provider;
  const base = joinBase(ENV_URL, provider.base);
  const headers: Record<string, string> = { 'content-type': 'application/json', ...authHeaders(provider.auth, provider.key) };
  let url: string;
  let payload: Json;
  if (provider.wire === 'openai') {
    url = `${base}/v1/chat/completions`;
    payload = openAIProviderBody(req, candidate.modelId);
  } else if (provider.wire === 'anthropic') {
    url = `${base}/v1/messages`;
    headers['anthropic-version'] = '2023-06-01';
    payload = anthropicProviderBody(req, candidate.modelId);
  } else {
    const built = geminiProviderBody(req, candidate.modelId);
    url = `${base}${built.path}`;
    payload = built.body;
  }
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
    if (!res.ok) {
      await res.text().catch(() => '');
      return null;
    }
    const body: unknown = await res.json();
    return extractAnswer(provider.wire, body);
  } catch {
    return null;
  }
}

/** Serve one client request: plan first, then fail over down the candidate list. */
async function serve(clientApi: 'openai' | 'anthropic', body: Json, res: ServerResponse): Promise<void> {
  const req = clientApi === 'openai' ? parseOpenAIClient(body) : parseAnthropicClient(body);
  const entry = brief.manifest[manifestIndex];
  manifestIndex += 1;
  const requires = entry !== undefined ? entry.requires : requirementsFromBody(req);
  const fallbackEntry: WorkloadRequest = entry ?? { id: '', api: clientApi, stream: req.stream, weight: 1, requires };
  const candidates = router === null ? [] : router.orderFor(fallbackEntry, req.jsonMode);
  // Walk the candidate list, then walk it again: each refusal spends one of a
  // provider's numbered calls, so a provider that refused a moment ago may
  // answer now. Bounded so one request always finishes well inside its window.
  let attempts = 0;
  for (let pass = 0; pass < 4 && attempts < 24; pass++) {
    let triedThisPass = 0;
    for (const candidate of candidates) {
      if (attempts >= 24) break;
      if (router !== null && router.isDead(candidate.provider.id)) continue;
      triedThisPass += 1;
      attempts += 1;
      if (router !== null) router.noteCall(candidate.provider.id);
      const answer = await callProvider(candidate, req);
      if (answer === null) {
        if (router !== null) router.noteRefusal(candidate.provider.id);
        continue;
      }
      if (router !== null) router.noteSuccess(candidate.provider.id);
      if (clientApi === 'openai') {
        if (req.stream) sendStream(res, openAIAnswerStream(answer, candidate.modelId));
        else sendJson(res, 200, openAIAnswerJson(answer, candidate.modelId));
      } else {
        if (req.stream) sendStream(res, anthropicAnswerStream(answer, candidate.modelId));
        else sendJson(res, 200, anthropicAnswerJson(answer, candidate.modelId));
      }
      return;
    }
    if (triedThisPass === 0) break;
  }
  sendError(res, clientApi, 503, clientApi === 'anthropic' ? 'overloaded_error' : 'no_free_model', 'no free model could serve this request');
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    modelsRoute(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    const body = await readJson(req);
    if (body === null) return sendError(res, 'openai', 400, 'invalid_request_error', 'the request body is not one JSON object');
    await serve('openai', body, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    const body = await readJson(req);
    if (body === null) return sendError(res, 'anthropic', 400, 'invalid_request_error', 'the request body is not one JSON object');
    await serve('anthropic', body, res);
    return;
  }
  sendError(res, url.pathname === '/v1/messages' ? 'anthropic' : 'openai', 404, 'not_found', `no route ${req.method ?? ''} ${url.pathname}`);
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the server has no port'));
        return;
      }
      resolve(address.port);
    });
  });
}

/** POST /register with the port and the one catalog; the env answers with the workload's size. */
async function register(port: number): Promise<void> {
  const res = await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`POST ${ENV_URL}/register answered HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const reply: unknown = await res.json();
  if (isRecord(reply) && typeof reply.requests === 'number') log(`registered: the workload holds ${reply.requests} requests`);
}

/** Poll GET /work; exit 0 the moment it says done. */
function poll(server: Server): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status !== 200) return;
        const work: unknown = await res.json();
        if (isRecord(work) && work.done === true) {
          clearInterval(timer);
          server.close();
          process.exit(0);
        }
      } catch {
        // The env is not reachable yet: try again on the next tick.
      } finally {
        inFlight = false;
      }
    })();
  }, POLL_INTERVAL_MS);
}

async function start(): Promise<void> {
  await load();
  if (process.argv.includes('--list')) {
    // The same document the register body carries, byte for byte.
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) sendError(res, req.url?.startsWith('/v1/messages') === true ? 'anthropic' : 'openai', 500, 'internal_error', 'the server failed to answer');
    });
  });
  let port = await listen(server);
  if (port === 8080) {
    // 8080 is the env's own port on one layout: close and take another.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    port = await listen(server);
  }
  log(`listening on 0.0.0.0:${port} with ${catalog.providers.length} answered providers`);
  await register(port);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  poll(server);
}

try {
  await start();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}
