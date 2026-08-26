import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { chromium } from "playwright-core";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));

// Browser cookies and raw responses must stay outside the synced source folder by default.
// AVITO_DATA_DIR still allows an explicit local override for a portable or isolated setup.
const LOCAL_DATA_ROOT = process.env.LOCALAPPDATA || process.env.APPDATA;
const DEFAULT_DATA_DIR = LOCAL_DATA_ROOT
  ? join(LOCAL_DATA_ROOT, "OpenCode", "avito-analytics")
  : join(ROOT, "data");
const DATA_DIR = environmentValue("AVITO_DATA_DIR", DEFAULT_DATA_DIR);
const PROFILE_DIR = environmentValue("AVITO_PROFILE_DIR", join(DATA_DIR, "profile"));
const ARCHIVE_DIR = join(DATA_DIR, "archive");
const STATE_FILE = join(DATA_DIR, "state.json");
const LOCATIONS_CACHE_FILE = join(DATA_DIR, "locations-cache.json");
const LOCATIONS_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const MIN_INTERVAL_MS = positiveInteger(process.env.AVITO_MIN_INTERVAL_MS, 8000);
const MAX_INTERVAL_MS = positiveInteger(process.env.AVITO_MAX_INTERVAL_MS, 20000);
const MAX_REQUESTS_PER_SESSION = positiveInteger(process.env.AVITO_MAX_REQUESTS, 50);
const SESSION_COOLDOWN_MS = positiveInteger(process.env.AVITO_SESSION_COOLDOWN_MS, 30 * 60 * 1000);
const BLOCK_COOLDOWN_MS = positiveInteger(process.env.AVITO_BLOCK_COOLDOWN_MS, 24 * 60 * 60 * 1000);
const LOGIN_TIMEOUT_MS = positiveInteger(process.env.AVITO_LOGIN_TIMEOUT_MS, 5 * 60 * 1000);
const FETCH_TIMEOUT_MS = positiveInteger(process.env.AVITO_FETCH_TIMEOUT_MS, 30000);

const ANALYTICS_URL = "https://www.avito.ru/analytics";
const BASE_URL = "https://www.avito.ru";

const server = new McpServer({
  name: "avito-analytics",
  version: "1.0.0",
});

let browser = null;
let context = null;
let page = null;
let state = loadState();

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

function loadState() {
  try {
    return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
  } catch {
    return {};
  }
}

function saveState() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch {
    // state persistence is best-effort
  }
}

function now() {
  return Date.now();
}

function randomInterval() {
  return MIN_INTERVAL_MS + Math.floor(Math.random() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS));
}

function archive(prefix, payload) {
  const day = new Date().toISOString().slice(0, 10);
  const dir = join(ARCHIVE_DIR, day);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
  return file;
}

function assertNotBlocked() {
  if (state.blockedUntil && now() < state.blockedUntil) {
    const minutes = Math.ceil((state.blockedUntil - now()) / 60000);
    throw new Error(
      `Avito session is paused: ${state.blockReason ?? "likely CAPTCHA/block"}. Retry in ~${minutes} min.`,
    );
  }
}

async function countRequest() {
  if (state.blockedUntil && now() < state.blockedUntil) {
    assertNotBlocked();
  }
  if (!state.lastRequestAt || now() - state.lastRequestAt > SESSION_COOLDOWN_MS) {
    state.requestCount = 0;
  }
  if (state.requestCount >= MAX_REQUESTS_PER_SESSION) {
    throw new Error(
      `Daily session limit reached (${MAX_REQUESTS_PER_SESSION} requests). ` +
        `Wait for the cooldown (${Math.ceil(SESSION_COOLDOWN_MS / 60000)} min) or restart later.`,
    );
  }
}

async function pace() {
  const wait = state.lastRequestAt ? Math.max(0, state.lastRequestAt + randomInterval() - now()) : 0;
  if (wait > 0) {
    await sleep(wait);
  }
}

function markBlocked(reason) {
  state.blockedUntil = now() + BLOCK_COOLDOWN_MS;
  state.blockReason = reason;
  saveState();
}

async function ensureBrowser() {
  if (browser && context && page && !page.isClosed() && context.browser()?.isConnected() !== false) {
    return page;
  }
  await closeBrowser();
  mkdirSync(PROFILE_DIR, { recursive: true });

  const channels = [];
  if (environmentValue("AVITO_CHANNEL", "")) {
    channels.push(process.env.AVITO_CHANNEL.trim());
  } else {
    channels.push("chrome", "msedge", "chromium");
  }

  let lastError = null;
  for (const channel of channels) {
    try {
      browser = await chromium.launchPersistentContext(PROFILE_DIR, {
        channel: channel === "chromium" ? undefined : channel,
        headless: environmentValue("AVITO_HEADLESS", "false") === "true",
        viewport: { width: 1440, height: 900 },
        locale: "ru-RU",
        args: ["--disable-blink-features=AutomationControlled"],
      });
      context = browser;
      page = context.pages()[0] ?? (await context.newPage());
      page.setDefaultTimeout(15000);
      return page;
    } catch (error) {
      lastError = error;
    }
  }
  browser = null;
  context = null;
  page = null;
  throw new Error(
    `Could not launch a browser (tried ${channels.join(", ")}): ${lastError?.message ?? "unknown error"}`,
  );
}

async function closeBrowser() {
  try {
    await context?.close();
  } catch {
    // ignore
  }
  browser = null;
  context = null;
  page = null;
}

async function isAuthorized() {
  if (!page) return false;
  const title = await page.title().catch(() => "");
  return title.includes("Аналитика спроса") && page.url().startsWith(ANALYTICS_URL);
}

async function openAnalytics({ waitLogin = true, timeoutMs = LOGIN_TIMEOUT_MS } = {}) {
  const p = await ensureBrowser();
  try {
    await p.goto(ANALYTICS_URL, { waitUntil: "domcontentloaded" });
  } catch {
    await closeBrowser();
    const fresh = await ensureBrowser();
    await fresh.goto(ANALYTICS_URL, { waitUntil: "domcontentloaded" });
  }
  if (!waitLogin) return;
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (await isAuthorized()) return;
    await sleep(3000);
  }
  throw new Error(
    `Login timeout: authorize in the opened browser window (expecting the "Аналитика спроса" page), ` +
      `then call avito_session_status.`,
  );
}

async function apiPost(path, body) {
  assertNotBlocked();
  await countRequest();
  await pace();

  const p = await ensureBrowser();
  if (!p.url().startsWith(BASE_URL)) {
    await p.goto(ANALYTICS_URL, { waitUntil: "domcontentloaded" });
  }

  const result = await p.evaluate(
    async ({ path, body, timeoutMs }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const text = await res.text();
        let data = null;
        try {
          data = JSON.parse(text);
        } catch {
          data = null;
        }
        return { status: res.status, ok: res.ok, data, text: data ? null : text.slice(0, 3000) };
      } finally {
        clearTimeout(timer);
      }
    },
    { path, body, timeoutMs: FETCH_TIMEOUT_MS },
  );

  state.lastRequestAt = now();
  state.requestCount = (state.requestCount ?? 0) + 1;
  saveState();

  if (!result.ok) {
    if (result.status === 403 || result.status === 429 || result.status >= 500 || isCaptchaText(result.text)) {
      markBlocked(`HTTP ${result.status}${result.text ? `: ${result.text.slice(0, 200)}` : ""}`);
    }
    throw new Error(
      `Avito API ${path} failed with HTTP ${result.status}: ${result.text ?? JSON.stringify(result.data) ?? "empty response"}`,
    );
  }

  if (!result.data) {
    markBlocked(`HTML instead of JSON from ${path}: ${result.text ?? ""}`);
    throw new Error(
      `Avito returned HTML instead of JSON for ${path} (CAPTCHA or anti-bot). Session paused for 24h.`,
    );
  }

  return result.data;
}

function isCaptchaText(text) {
  return !!text && /captcha|recaptcha|hcaptcha|проверк|подтверд/i.test(text);
}

function loadLocationsCache() {
  try {
    return existsSync(LOCATIONS_CACHE_FILE) ? JSON.parse(readFileSync(LOCATIONS_CACHE_FILE, "utf8")) : {};
  } catch {
    return {};
  }
}

function saveLocationsCache(cache) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(LOCATIONS_CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
  } catch {
    // cache persistence is best-effort
  }
}

async function searchLocations(query, limit) {
  const cache = loadLocationsCache();
  const cached = cache[query.toLowerCase()];
  if (cached && now() - cached.fetchedAt < LOCATIONS_CACHE_TTL_MS) {
    return { cached: true, locations: cached.locations };
  }
  const p = await ensureBrowser();
  const body = await p.evaluate(
    async ({ query, limit }) => {
      const url = `/web/1/slocations?locationId=621540&limit=${limit}&q=${encodeURIComponent(query)}`;
      const res = await fetch(url);
      const text = await res.text();
      if (!res.ok) {
        return { status: res.status, text: text.slice(0, 500) };
      }
      return { status: res.status, locations: JSON.parse(text).result?.locations ?? [] };
    },
    { query, limit },
  );
  if (!body.locations) {
    throw new Error(`Avito location suggest failed with HTTP ${body.status}: ${body.text}`);
  }
  const locations = body.locations.map((item) => ({
    id: item.id,
    name: item.names?.["1"] ?? "",
    parent: item.parent ? { id: item.parent.id, name: item.parent.names?.["1"] ?? "" } : null,
    exact: (item.names?.["1"] ?? "").toLowerCase() === query.toLowerCase(),
  }));
  cache[query.toLowerCase()] = { fetchedAt: now(), locations };
  saveLocationsCache(cache);
  return { cached: false, locations };
}

function registerTools() {
  server.registerTool(
    "avito_session_open",
    {
      description:
        "Open the Avito analytics page in a persistent browser profile (one-time login required). " +
        "Headful browser window appears; authorize manually if needed. " +
        "Set wait_login=false to open without waiting, then poll avito_session_status.",
      inputSchema: {
        wait_login: z.boolean().optional().describe("Wait until authorized (default true)"),
        timeout_ms: z.number().int().positive().optional().describe("Login wait timeout"),
      },
    },
    async ({ wait_login = true, timeout_ms }) => {
      await openAnalytics({ waitLogin: wait_login, timeoutMs: timeout_ms ?? LOGIN_TIMEOUT_MS });
      return textResult({
        ok: true,
        authorized: await isAuthorized(),
        url: page?.url(),
        requests_in_session: state.requestCount ?? 0,
        max_requests_per_session: MAX_REQUESTS_PER_SESSION,
      });
    },
  );

  server.registerTool(
    "avito_session_status",
    {
      description: "Report the browser session state: opened, authorized, remaining request budget, cooldown.",
      inputSchema: {},
    },
    async () => {
      const blocked = state.blockedUntil && now() < state.blockedUntil;
      const sessionLimitReached = (state.requestCount ?? 0) >= MAX_REQUESTS_PER_SESSION;
      const cooldownLeft = sessionLimitReached && state.lastRequestAt
        ? Math.max(0, state.lastRequestAt + SESSION_COOLDOWN_MS - now())
        : 0;
      return textResult({
        ok: true,
        browser_open: !!page && !page.isClosed(),
        authorized: page ? await isAuthorized() : false,
        url: page?.url(),
        requests_in_session: state.requestCount ?? 0,
        max_requests_per_session: MAX_REQUESTS_PER_SESSION,
        cooldown_left_ms: cooldownLeft,
        blocked_until: blocked ? state.blockedUntil : null,
        block_reason: blocked ? state.blockReason : null,
      });
    },
  );

  server.registerTool(
    "avito_session_close",
    {
      description: "Close the browser window and the persistent session (cookies are kept on disk).",
      inputSchema: {},
    },
    async () => {
      await closeBrowser();
      return textResult({ ok: true, closed: true });
    },
  );

  server.registerTool(
    "avito_location",
    {
      description:
        "Resolve the current region used by Avito analytics (e.g. {\"id\":660630,\"name\":\"Сургут\"}).",
      inputSchema: {},
    },
    async () => {
      const data = await apiPost("/web/1/sellers/analytics/market/location", {});
      const file = archive("location", { request: {}, response: data });
      return textResult({ ...data, archived: file });
    },
  );

  server.registerTool(
    "avito_location_search",
    {
      description:
        "Resolve a city/region name to Avito location ids via the public suggest endpoint " +
        "(/web/1/slocations). Returns all matches with exact-match flag, e.g. " +
        "{\"id\":637640,\"name\":\"Москва\",\"exact\":true}. Cached on disk for 30 days; " +
        "does not consume the analytics request budget. Use the id in avito_wordstat / avito_market.",
      inputSchema: {
        query: z.string().min(1).max(120).describe("City or region name, e.g. \"Москва\""),
        limit: z.number().int().min(1).max(20).optional().describe("Max suggestions (default 10)"),
      },
    },
    async ({ query, limit }) => {
      const result = await searchLocations(query, limit ?? 10);
      return textResult({ query, ...result });
    },
  );

  server.registerTool(
    "avito_market",
    {
      description:
        "Demand by category (or subcategories when nodeId is set): sellers, items, views, contacts, demand level. " +
        "nodeId=null returns top-level categories; a category nodeId returns its subcategories plus a summary. " +
        "Paced automatically (8-20 s random intervals), archived to disk.",
      inputSchema: {
        node_id: z.number().int().nullable().optional().describe("Category node; null = all categories"),
        location_ids: z.array(z.number().int()).min(1).describe("Region ids, e.g. [660630] for Surgut"),
        district_ids: z.array(z.number().int()).optional().describe("Districts filter"),
        metro_ids: z.array(z.number().int()).optional().describe("Metro stations filter"),
        dynamic_filters: z.record(z.string(), z.unknown()).optional().describe("Price/seller type filters"),
        group: z.enum(["day", "month"]).optional().describe("Aggregation period"),
        order: z
          .enum(["name", "demand", "contacts", "views", "sellers", "items"])
          .optional()
          .describe("Sort field"),
        direction: z.enum(["asc", "desc"]).optional().describe("Sort direction"),
        split_by: z
          .enum(["category", "district", "metro"])
          .optional()
          .describe("Breakdown (category = subcategories)"),
      },
    },
    async (args) => {
      const body = {
        filters: {
          nodeId: args.node_id ?? null,
          locationIds: args.location_ids,
          districtIds: args.district_ids ?? [],
          metroIds: args.metro_ids ?? [],
        },
        dynamicFilters: args.dynamic_filters ?? {},
        group: args.group ?? "month",
        order: args.order ?? "name",
        direction: args.direction ?? "asc",
        splitBy: args.split_by ?? "category",
      };
      const data = await apiPost("/web/1/sellers/analytics/market", body);
      const file = archive("market", { request: body, response: data });
      return textResult({ ...data, archived: file });
    },
  );

  server.registerTool(
    "avito_wordstat",
    {
      description:
        "Search query frequency for one or more phrases (compared per day). " +
        "Returns periodData: [{date, counts[]}] — one count per phrase per day. " +
        "Paced automatically (8-20 s random intervals), archived to disk.",
      inputSchema: {
        queries: z.array(z.string().min(1).max(120)).min(1).max(10).describe("Phrases to compare"),
        duration: z.enum(["week", "month"]).optional().describe("7 or 30 days window"),
        location_id: z.number().int().nullable().optional().describe("Region id or null"),
        category_id: z.number().int().nullable().optional().describe("Category id or null"),
        strict_mode: z.boolean().optional().describe("Exact phrase match toggle"),
      },
    },
    async (args) => {
      const body = {
        queries: args.queries,
        filters: {
          duration: args.duration ?? "week",
          locationId: args.location_id ?? null,
          categoryId: args.category_id ?? null,
        },
        strictMode: args.strict_mode ?? false,
      };
      const data = await apiPost("/web/1/sellers/analytics/wordstat", body);
      const total = (data.periodData ?? []).reduce((sum, d) => sum + (d.counts ?? []).reduce((a, b) => a + b, 0), 0);
      const file = archive("wordstat", { request: body, response: data });
      return textResult({ ...data, total_requests: total, archived: file });
    },
  );

  server.registerTool(
    "avito_microcat_suggest",
    {
      description: "Microcategory suggestions for dynamic filters (e.g. \"Электроника\").",
      inputSchema: {
        query: z.string().min(2).max(120).describe("Text to complete"),
      },
    },
    async ({ query }) => {
      const data = await apiPost("/web/1/sellers/analytics/market/microcat/suggest", { query });
      return textResult({ query, suggestions: data });
    },
  );
}

function textResult(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

registerTools();

const transport = new StdioServerTransport();
await server.connect(transport);

process.on("SIGINT", async () => {
  await closeBrowser();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await closeBrowser();
  process.exit(0);
});
