import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_BASE = environmentValue(
  "WORDSTAT_API_BASE",
  "https://searchapi.api.cloud.yandex.net/v2/wordstat",
);
const API_KEY = environmentValue("WORDSTAT_API_KEY");
const FOLDER_ID = environmentValue("WORDSTAT_FOLDER_ID");
const TIMEOUT_MS = positiveInteger(process.env.WORDSTAT_TIMEOUT_MS, 60000);
const MAX_RETRIES = positiveInteger(process.env.WORDSTAT_MAX_RETRIES, 3);
const MIN_REQUEST_INTERVAL_MS = 100;
const REGIONS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ITEMS_IN_RESPONSE = 300;

const DEVICE_VALUES = ["DEVICE_ALL", "DEVICE_DESKTOP", "DEVICE_PHONE", "DEVICE_TABLET"];
const PERIOD_VALUES = ["PERIOD_DAILY", "PERIOD_WEEKLY", "PERIOD_MONTHLY"];
const REGION_TYPE_VALUES = ["REGION_ALL", "REGION_CITIES", "REGION_REGIONS"];

const SEARCH_API_BASE = environmentValue(
  "SEARCH_API_BASE",
  "https://searchapi.api.cloud.yandex.net/v2/web",
);
const OPERATIONS_API_BASE = environmentValue(
  "SEARCH_OPERATIONS_API_BASE",
  "https://operation.api.cloud.yandex.net",
);
const SEARCH_API_KEY = environmentValue("SEARCH_API_KEY", null);
const SEARCH_FOLDER_ID = environmentValue("SEARCH_FOLDER_ID", null);
const SEARCH_MAX_QUERIES_PER_SUBMIT = 50;
const SEARCH_MAX_RESULTS_PER_QUERY = 250;
const SEARCH_DEFERRED_MIN_WAIT_MS = 5 * 60 * 1000;
const SEARCH_DEFERRED_RETENTION_MS = 12 * 60 * 60 * 1000;

const SEARCH_TYPE_VALUES = [
  "SEARCH_TYPE_RU",
  "SEARCH_TYPE_COM",
  "SEARCH_TYPE_TR",
  "SEARCH_TYPE_BE",
  "SEARCH_TYPE_KK",
  "SEARCH_TYPE_UZ",
];
const SORT_BY_VALUES = ["relevance", "time"];
const FAMILY_MODE_VALUES = ["FAMILY_MODE_NONE", "FAMILY_MODE_MODERATE", "FAMILY_MODE_STRICT"];
const L10N_VALUES = [
  "LOCALIZATION_RU",
  "LOCALIZATION_EN",
  "LOCALIZATION_TR",
  "LOCALIZATION_UK",
  "LOCALIZATION_BE",
  "LOCALIZATION_KK",
];

let lastRequestAt = 0;
let regionsCache = null;
let regionsCacheAt = 0;

function environmentValue(name, fallback) {
  const value = process.env[name]?.trim();
  if (!value || value === "null" || value === "undefined" || /^{env:/.test(value)) {
    return fallback;
  }
  return value;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rateLimit() {
  const now = Date.now();
  const wait = lastRequestAt + MIN_REQUEST_INTERVAL_MS - now;
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

function ensureConfigured() {
  if (!API_KEY || !FOLDER_ID) {
    throw new Error(
      "Server is not configured: set WORDSTAT_API_KEY (Yandex Cloud API key, AI Studio) " +
        "and WORDSTAT_FOLDER_ID (Yandex Cloud folder ID). See README.md for instructions.",
    );
  }
}

function apiErrorMessage(body) {
  const error = body?.error;
  if (error && typeof error.message === "string") {
    const code = error.code !== undefined ? ` (code ${error.code}, ${error.status ?? "error"})` : "";
    return `Yandex API${code}: ${error.message}`;
  }
  if (typeof body?.message === "string") return body.message;
  return null;
}

async function callApi(path, body, { retries = MAX_RETRIES } = {}) {
  ensureConfigured();
  const payload = { ...body, folderId: FOLDER_ID };
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    await rateLimit();
    try {
      const response = await fetch(`${API_BASE}/${path}`, {
        method: "POST",
        headers: {
          Authorization: `Api-Key ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await response.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      if (response.ok) return parsed ?? {};

      const message = apiErrorMessage(parsed) ?? `HTTP ${response.status}`;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === retries) {
        throw new Error(message);
      }
      lastError = new Error(`${message} (attempt ${attempt + 1}/${retries})`);
    } catch (error) {
      const httpError = error instanceof Error && /^Yandex API|^HTTP/.test(error.message);
      if (httpError || attempt === retries) throw error;
      lastError = new Error(`Network failure: ${error.message} (attempt ${attempt + 1}/${retries})`);
    }
    await sleep(500 * 2 ** attempt + Math.floor(Math.random() * 250));
  }

  throw lastError ?? new Error("Unexpected API failure");
}

function numericCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
}

function normalizeTopRequests(data) {
  const mapItems = (items = []) =>
    items.map((item) => ({ ...item, count: numericCount(item.count) }));
  return {
    totalCount: numericCount(data.totalCount),
    results: mapItems(data.results),
    associations: mapItems(data.associations),
  };
}

function normalizeDynamics(data) {
  return {
    dynamics: (data.results ?? []).map((item) => ({
      ...item,
      count: numericCount(item.count),
      share: numericCount(item.share),
    })),
  };
}

function normalizeRegions(data) {
  return {
    regions: (data.results ?? []).map((item) => ({
      ...item,
      count: numericCount(item.count),
      share: numericCount(item.share),
      affinityIndex: numericCount(item.affinityIndex),
    })),
  };
}

function limitItems(items) {
  const limited = items.slice(0, MAX_ITEMS_IN_RESPONSE);
  if (limited.length === items.length) return items;
  return [...limited, `(ответ усечён: показаны первые ${limited.length} из ${items.length})`];
}

function toIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value;
}

async function getRegionsTreeCached() {
  const now = Date.now();
  if (regionsCache && now - regionsCacheAt < REGIONS_CACHE_TTL_MS) {
    return regionsCache;
  }
  const data = await callApi("getRegionsTree", {});
  regionsCache = data;
  regionsCacheAt = now;
  return data;
}

async function topRequests(input) {
  const data = await callApi("topRequests", {
    phrase: input.phrase,
    numPhrases: input.num_phrases,
    regions: input.regions,
    devices: input.devices,
  });
  const normalized = normalizeTopRequests(data);
  normalized.results = limitItems(normalized.results);
  normalized.associations = limitItems(normalized.associations);
  return normalized;
}

async function dynamics(input) {
  const data = await callApi("dynamics", {
    phrase: input.phrase,
    period: input.period,
    fromDate: toIsoDate(input.from_date),
    toDate: toIsoDate(input.to_date),
    regions: input.regions,
    devices: input.devices,
  });
  const normalized = normalizeDynamics(data);
  normalized.dynamics = limitItems(normalized.dynamics);
  return normalized;
}

async function regionsDistribution(input) {
  const data = await callApi("regions", {
    phrase: input.phrase,
    region: input.region_type,
    devices: input.devices,
  });
  const normalized = normalizeRegions(data);
  normalized.regions = limitItems(normalized.regions);
  return normalized;
}

async function regionsTree() {
  return getRegionsTreeCached();
}

async function rawRequest(input) {
  const data = await callApi(input.path, input.body ?? {});
  return { path: input.path, response: data };
}

function searchApiKeyValue() {
  return SEARCH_API_KEY ?? API_KEY;
}

function searchFolderIdValue() {
  return SEARCH_FOLDER_ID ?? FOLDER_ID;
}

function ensureSearchConfigured() {
  const key = searchApiKeyValue();
  const folderId = searchFolderIdValue();
  if (!key || !folderId) {
    throw new Error(
      "Search API is not configured: set SEARCH_API_KEY / SEARCH_FOLDER_ID " +
        "(fallback to WORDSTAT_API_KEY / WORDSTAT_FOLDER_ID) and make sure the " +
        "Search API service is activated for the folder in Yandex Cloud.",
    );
  }
}

async function httpRequest(method, url, { headers = {}, body, retries = MAX_RETRIES } = {}) {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    await rateLimit();
    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await response.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      if (response.ok) return { status: response.status, data: parsed ?? {} };

      const message = apiErrorMessage(parsed) ?? `HTTP ${response.status}`;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === retries) {
        throw new Error(message);
      }
      lastError = new Error(`${message} (attempt ${attempt + 1}/${retries})`);
    } catch (error) {
      const httpError = error instanceof Error && /^Yandex API|^HTTP/.test(error.message);
      if (httpError || attempt === retries) throw error;
      lastError = new Error(`Network failure: ${error.message} (attempt ${attempt + 1}/${retries})`);
    }
    await sleep(500 * 2 ** attempt + Math.floor(Math.random() * 250));
  }

  throw lastError ?? new Error("Unexpected API failure");
}

function searchHeaders() {
  return { Authorization: `Api-Key ${searchApiKeyValue()}` };
}

async function searchPost(path, body) {
  ensureSearchConfigured();
  const { data } = await httpRequest("POST", `${SEARCH_API_BASE}${path}`, {
    headers: searchHeaders(),
    body,
  });
  return data;
}

async function operationGet(operationId) {
  ensureSearchConfigured();
  const { data } = await httpRequest(
    "GET",
    `${OPERATIONS_API_BASE}/operations/${operationId}`,
    { headers: searchHeaders() },
  );
  return data;
}

function buildSearchBody(input) {
  const query = {
    searchType: input.search_type ?? "SEARCH_TYPE_RU",
    queryText: input.site ? `${input.query} site:${input.site}` : input.query,
    familyMode: input.family_mode ?? "FAMILY_MODE_NONE",
    fixTypoMode: input.fix_typo === false ? "FIX_TYPO_MODE_OFF" : "FIX_TYPO_MODE_ON",
  };
  if (input.page !== undefined && input.page !== null) query.page = input.page;

  const body = {
    query,
    groupSpec: {
      groupMode: "GROUP_MODE_FLAT",
      groupsOnPage: Math.min(input.limit ?? 10, SEARCH_MAX_RESULTS_PER_QUERY),
      docsInGroup: 1,
    },
    l10n: input.l10n ?? "LOCALIZATION_RU",
    folderId: searchFolderIdValue(),
    responseFormat: "FORMAT_XML",
  };
  if (input.sort_by) {
    body.sortSpec = {
      sortMode: input.sort_by === "time" ? "SORT_MODE_BY_TIME" : "SORT_MODE_BY_RELEVANCE",
      sortOrder: "SORT_ORDER_DESC",
    };
  }
  if (input.region && query.searchType === "SEARCH_TYPE_RU") {
    body.region = String(input.region);
  }
  return body;
}

function decodeRawData(data) {
  const raw = data?.rawData ?? data?.response?.rawData;
  if (typeof raw !== "string" || raw.length === 0) return null;
  return Buffer.from(raw, "base64").toString("utf-8");
}

function cleanXmlText(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseSearchXml(xml) {
  const foundMatch = /<found-docs-human[^>]*>([\s\S]*?)<\/found-docs-human>/.exec(xml);
  const found = foundMatch ? cleanXmlText(foundMatch[1]) : null;
  const results = [];
  const docRe = /<doc\b[^>]*>([\s\S]*?)<\/doc>/g;
  let docMatch;
  while ((docMatch = docRe.exec(xml)) !== null) {
    const block = docMatch[1];
    const tagText = (tag) => {
      const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`);
      const m = re.exec(block);
      return m ? cleanXmlText(m[1]) : null;
    };
    const url = tagText("url");
    if (!url) continue;
    const title = tagText("title");
    let snippet = tagText("headline");
    if (!snippet) {
      const passageRe = /<passage[^>]*>([\s\S]*?)<\/passage>/.exec(block);
      snippet = passageRe ? cleanXmlText(passageRe[1]) : null;
    }
    results.push({
      url,
      title,
      snippet,
      domain: tagText("domain"),
      language: tagText("language"),
    });
  }
  return { found, results };
}

function normalizeSearchResults(raw) {
  const xml = decodeRawData(raw);
  if (!xml) {
    return { found: null, results: [], note: "Пустой ответ API (rawData отсутствует)." };
  }
  const parsed = parseSearchXml(xml);
  if (/<error\b[^>]*code="15"/.test(xml)) {
    parsed.found = parsed.found ?? "0";
    parsed.note = "По запросу ничего не найдено (ошибка 15).";
  }
  return parsed;
}

const deferredRegistry = new Map();

function readyAfter(submittedAt) {
  return new Date(submittedAt + SEARCH_DEFERRED_MIN_WAIT_MS).toISOString();
}

async function searchSync(input) {
  const data = await searchPost("/search", buildSearchBody(input));
  return { query: input.query, ...normalizeSearchResults(data) };
}

async function searchDeferredSubmit(input) {
  ensureSearchConfigured();
  const submitted = [];
  for (const item of input.queries) {
    const data = await searchPost("/searchAsync", buildSearchBody(item));
    const id = data?.id;
    if (!id) {
      throw new Error(
        `Search API не вернул id операции для запроса «${item.query}»: ${JSON.stringify(data).slice(0, 300)}`,
      );
    }
    const submittedAt = Date.now();
    const readyAt = readyAfter(submittedAt);
    deferredRegistry.set(id, {
      query: item.query,
      submittedAt,
      readyAfter: readyAt,
    });
    submitted.push({
      request_id: id,
      query: item.query,
      submitted_at: new Date(submittedAt).toISOString(),
      ready_after: readyAt,
      note: "Результат будет готов не раньше чем через 5 минут и хранится 12 часов.",
    });
  }
  return { submitted };
}

async function searchDeferredGet(input) {
  const out = [];
  for (const id of input.request_ids) {
    const meta = deferredRegistry.get(id);
    const base = meta
      ? { query: meta.query, submitted_at: new Date(meta.submittedAt).toISOString(), ready_after: meta.readyAfter }
      : {};
    try {
      const op = await operationGet(id);
      if (op?.done && op?.error?.code) {
        out.push({ request_id: id, status: "ERROR", ...base, error: `${op.error.code}: ${op.error.message}` });
      } else if (op?.done) {
        out.push({ request_id: id, status: "DONE", ...base, ...normalizeSearchResults(op) });
      } else {
        out.push({
          request_id: id,
          status: "PENDING",
          ...base,
          note: "Результат ещё не готов: минимальное время обработки 5 минут, хранение результата 12 часов.",
        });
      }
    } catch (error) {
      out.push({
        request_id: id,
        status: "ERROR",
        ...base,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { results: out };
}

async function searchDeferredList() {
  const entries = [];
  for (const [id, meta] of deferredRegistry) {
    entries.push({
      request_id: id,
      query: meta.query,
      submitted_at: new Date(meta.submittedAt).toISOString(),
      ready_after: meta.readyAfter,
    });
  }
  return { pending: entries };
}

function textResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(error) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function runTool(handler) {
  return handler().then(textResult, errorResult);
}

const devicesSchema = z
  .array(z.enum(DEVICE_VALUES))
  .optional()
  .default([])
  .describe("Device types to count. Empty = all devices.");

const regionsSchema = z
  .array(z.string())
  .optional()
  .default([])
  .describe("Region IDs (as returned by regions_tree). Empty = all regions.");

function registerTools(server) {
  server.registerTool(
    "top_requests",
    {
      title: "Top requests for a phrase",
      description:
        "Returns the last 30 days statistics for popular queries containing the phrase and queries similar to it (top + associations). Operators like !, +, [] are NOT supported by the API. One phrase per call.",
      inputSchema: {
        phrase: z.string().min(1).max(400).describe("Keyword or phrase to get statistics for."),
        num_phrases: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .optional()
          .default(20)
          .describe("How many top results to return (1-2000)."),
        regions: regionsSchema,
        devices: devicesSchema,
      },
    },
    (input) => runTool(() => topRequests(input)),
  );

  server.registerTool(
    "dynamics",
    {
      title: "Query frequency dynamics over time",
      description:
        "Returns the frequency of a phrase over time (daily/weekly/monthly). toDate must be the end of the period: for PERIOD_MONTHLY the last day of a month, for PERIOD_WEEKLY a Sunday. Dates are YYYY-MM-DD.",
      inputSchema: {
        phrase: z.string().min(1).max(400).describe("Keyword or phrase to get statistics for."),
        period: z
          .enum(PERIOD_VALUES)
          .optional()
          .default("PERIOD_MONTHLY")
          .describe("Aggregation period. The PERIOD_ prefix is required by the API."),
        from_date: z.string().describe("Start date, YYYY-MM-DD."),
        to_date: z.string().describe("End date, YYYY-MM-DD. Must be the last day of the period."),
        regions: regionsSchema,
        devices: devicesSchema,
      },
    },
    (input) => runTool(() => dynamics(input)),
  );

  server.registerTool(
    "regions_distribution",
    {
      title: "Query distribution across regions",
      description:
        "Returns the distribution of the number of queries containing the phrase by region for the last 30 days: count, share, and affinityIndex (interest index, %; above 100 = hotter than average).",
      inputSchema: {
        phrase: z.string().min(1).max(400).describe("Keyword or phrase to get statistics for."),
        region_type: z
          .enum(REGION_TYPE_VALUES)
          .optional()
          .default("REGION_REGIONS")
          .describe("Show only cities, only regions, or everything."),
        devices: devicesSchema,
      },
    },
    (input) => runTool(() => regionsDistribution(input)),
  );

  server.registerTool(
    "regions_tree",
    {
      title: "Wordstat regions reference",
      description:
        "Returns the tree of all Wordstat-supported regions with IDs and names. Other tools accept these region IDs. Cached for 24 hours; does not consume the daily quota.",
      inputSchema: {},
    },
    () => runTool(() => regionsTree()),
  );

  server.registerTool(
    "raw_request",
    {
      title: "Raw Wordstat API call (debug)",
      description:
        "Debug tool: calls any Wordstat API endpoint directly. path is relative to the API root, e.g. 'topRequests'. folderId is injected automatically. Use with caution.",
      inputSchema: {
        path: z.string().min(1).max(120).describe("Endpoint path, e.g. 'topRequests'."),
        body: z
          .record(z.string(), z.unknown())
          .optional()
          .default({})
          .describe("Request body; folderId is added automatically."),
      },
    },
    (input) => runTool(() => rawRequest(input)),
  );

  const searchQuerySchema = z.object({
    query: z.string().min(1).max(400).describe("Поисковый запрос (макс. 400 символов)."),
    region: z
      .string()
      .optional()
      .describe("ID региона Яндекса (например 213 — Москва, 973 — Сургут; список и ID бери из regions_tree); только для SEARCH_TYPE_RU."),
    site: z
      .string()
      .optional()
      .describe("Ограничение site:<домен>, например avito.ru. Добавляется к тексту запроса."),
    page: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Номер страницы выдачи, 0-based (по умолчанию 0)."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(SEARCH_MAX_RESULTS_PER_QUERY)
      .optional()
      .describe("Число результатов на страницу (по умолчанию 10, максимум 250)."),
    search_type: z
      .enum(SEARCH_TYPE_VALUES)
      .optional()
      .describe("Тип поиска: RU/COM/TR/BE/KK/UZ (по умолчанию SEARCH_TYPE_RU)."),
    sort_by: z
      .enum(SORT_BY_VALUES)
      .optional()
      .describe("Сортировка: relevance (по умолчанию) или time (по дате)."),
    fix_typo: z.boolean().optional().describe("Исправлять опечатки (по умолчанию true)."),
    family_mode: z
      .enum(FAMILY_MODE_VALUES)
      .optional()
      .describe("Семейный фильтр (по умолчанию FAMILY_MODE_NONE — фильтрация выключена)."),
    l10n: z
      .enum(L10N_VALUES)
      .optional()
      .describe("Локализация интерфейса результата (по умолчанию LOCALIZATION_RU)."),
  });

  server.registerTool(
    "yandex_search_sync",
    {
      title: "Yandex web search (synchronous)",
      description:
        "Synchronous Yandex search via the official Search API. Returns URL, title and snippet for each result. " +
        "Use for the few priority phrases when results are needed immediately. Costs ~488 RUB / 1000 requests (day), ~366 RUB / 1000 (night 00:00-07:59 UTC+3).",
      inputSchema: { ...searchQuerySchema.shape },
    },
    (input) => runTool(() => searchSync(input)),
  );

  server.registerTool(
    "yandex_search_deferred_submit",
    {
      title: "Yandex web search (deferred batch submit)",
      description:
        "Submits a batch of deferred (asynchronous) search queries via the official Search API. Cheap mode (~30.5 RUB / 1000 by day, ~25.41 RUB / 1000 by night) but results are ready only after a minimum of 5 minutes and are stored for 12 hours. " +
        "Returns a request_id per query; collect them later with yandex_search_deferred_get. IMPORTANT: the agent MUST explicitly tell the user that results will be collected after a wait of at least 5 minutes.",
      inputSchema: {
        queries: z
          .array(searchQuerySchema)
          .min(1)
          .max(SEARCH_MAX_QUERIES_PER_SUBMIT)
          .describe("Batch of search queries to submit for deferred processing."),
      },
    },
    (input) => runTool(() => searchDeferredSubmit(input)),
  );

  server.registerTool(
    "yandex_search_deferred_get",
    {
      title: "Yandex deferred search results (collect)",
      description:
        "Collects results for previously submitted deferred searches by request_id. Returns status PENDING (not ready yet, min 5 minutes), DONE (results) or ERROR. " +
        "Reasonable to call no earlier than 5 minutes after submission; results are retained for 12 hours.",
      inputSchema: {
        request_ids: z
          .array(z.string().min(1))
          .min(1)
          .max(SEARCH_MAX_QUERIES_PER_SUBMIT)
          .describe("Operation/request IDs returned by yandex_search_deferred_submit."),
      },
    },
    (input) => runTool(() => searchDeferredGet(input)),
  );

  server.registerTool(
    "yandex_search_deferred_list",
    {
      title: "Yandex deferred search — list pending",
      description:
        "Lists deferred search submissions registered in this server session (request_id, query, submitted_at, ready_after).",
      inputSchema: {},
    },
    () => runTool(() => searchDeferredList()),
  );
}

const server = new McpServer({
  name: "Yandex Analytics",
  version: "1.1.0",
});

registerTools(server);

await server.connect(new StdioServerTransport());
