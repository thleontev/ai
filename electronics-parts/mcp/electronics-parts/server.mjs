import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { z } from "zod";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;
const MAX_FETCH = 50;
const REQUEST_TIMEOUT_MS = positiveInteger(
  process.env.COMPONENT_SOURCING_TIMEOUT_MS,
  30000,
);
const PUBLIC_CATALOG_MIN_INTERVAL_MS = 5000;
const PUBLIC_CATALOG_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const LCSC_PUBLIC_SEARCH_URL = "https://wmsc.lcsc.com/ftps/wm/search/v3/global";
const LCSC_PUBLIC_THIRD_SEARCH_URL = "https://wmsc.lcsc.com/ftps/wm/search/third";

const ELITAN_COOKIE = environmentValue("ELITAN_COOKIE");

let digiKeyToken;
const publicCatalogLastRequestAt = new Map();

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function environmentValue(name) {
  const value = process.env[name]?.trim();
  if (!value || /^{env:[a-z0-9_]+}$/i.test(value) || /^(null|undefined)$/i.test(value)) {
    return undefined;
  }
  return value;
}

function textResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(error) {
  const message = errorMessage(error);
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : "Unexpected error";
}

const MAX_TOOL_RESPONSE_CHARS = 40000;
const HEAVY_RESPONSE_KEYS = new Set([
  "card_details",
  "product_details",
  "market_analysis",
  "batches",
  "stock_batches",
  "price_breaks",
  "datasheet_urls",
  "image_url",
]);

const DISTRIBUTOR_DISPLAY_NAMES = {
  promelec: "Промэлектроника",
  electronshik: "ДКО Электронщик",
  chipdip: "Чип и Дип",
  elitan: "Элитан",
  berelcom: "Берелком",
  platan: "Платан",
};

function displayDistributorName(name) {
  return DISTRIBUTOR_DISPLAY_NAMES[String(name).toLowerCase()] ?? name;
}

function stringifyResult(value) {
  return JSON.stringify(value, null, 2);
}

function compactResult(value) {
  const fits = (candidate) => stringifyResult(candidate).length <= MAX_TOOL_RESPONSE_CHARS;
  if (fits(value)) return { value, truncated: false };

  const dropHeavy = (candidate) => {
    if (Array.isArray(candidate)) return candidate.map(dropHeavy);
    if (!candidate || typeof candidate !== "object") return candidate;
    const compact = {};
    for (const [key, entry] of Object.entries(candidate)) {
      if (HEAVY_RESPONSE_KEYS.has(key)) continue;
      compact[key] = dropHeavy(entry);
    }
    return compact;
  };

  let trimmed = dropHeavy(value);
  const note =
    "Ответ автоматически сокращён для встраивания в контекст модели: удалены громоздкие поля (price_breaks, stock_batches, card_details, market_analysis и т.п.).";
  if (fits(trimmed)) return { value: { ...trimmed, note }, truncated: true };

  const trimLists = (candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return candidate;
    const copy = { ...candidate };
    if (Array.isArray(copy.available_filters)) {
      if (copy.available_filters.length > 12) {
        copy.note = `Показаны первые 12 из ${candidate.available_filters.length} фильтров.`;
      }
      copy.available_filters = copy.available_filters.slice(0, 12).map((filter) => {
        if (Array.isArray(filter?.options)) return { ...filter, options: filter.options.slice(0, 25) };
        if (Array.isArray(filter?.values)) return { ...filter, values: filter.values.slice(0, 25) };
        return filter;
      });
    }
    if (Array.isArray(copy.categories)) copy.categories = copy.categories.slice(0, 30);
    if (Array.isArray(copy.available_categories)) copy.available_categories = copy.available_categories.slice(0, 30);
    return copy;
  };
  trimmed = trimLists(trimmed);
  if (fits(trimmed)) return { value: { ...trimmed, note }, truncated: true };

  const sliceCandidates = (candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return candidate;
    const copy = { ...candidate };
    if (Array.isArray(copy.candidates) && copy.candidates.length > 1) {
      const kept = Math.ceil(copy.candidates.length / 2);
      copy.candidates = copy.candidates.slice(0, kept);
      copy.note = `Показаны только первые ${kept} из ${candidate.candidates.length} позиций; для остальных уменьшите limit или уточните фильтры.`;
    }
    return copy;
  };
  let previous;
  do {
    previous = trimmed;
    trimmed = sliceCandidates(trimmed);
  } while (!fits(trimmed) && stringifyResult(trimmed) !== stringifyResult(previous));
  if (fits(trimmed)) return { value: { ...trimmed, note }, truncated: true };

  const minimal = { ...trimmed };
  if (Array.isArray(minimal.candidates) && minimal.candidates.length > 1) {
    minimal.candidates = minimal.candidates.slice(0, 1);
  }
  minimal.note = `${note} Оставлен один наиболее релевантный кандидат.`;
  if (fits(minimal)) return { value: minimal, truncated: true };
  throw new Error(
    "Response is too large to embed in the model context even after compaction. Reduce limit or narrow the filters.",
  );
}

async function runTool(handler) {
  try {
    return textResult(compactResult(await handler()).value);
  } catch (error) {
    return errorResult(error);
  }
}

function cleanObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== ""),
  );
}

function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[\u00b1]/g, "+-")
    .replace(/[^a-zа-яё0-9]+/g, "");
}

function stringValue(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

function firstNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const match = String(value ?? "").replace(/,/g, "").match(/[-+]?\d*\.?\d+/);
  return match ? Number(match[0]) : undefined;
}

function mouserAvailableQuantity(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value ?? "");
  const inStock = text.match(/([0-9][0-9,]*)\s+in\s+stock/i);
  if (inStock) return firstNumber(inStock[1]);
  return /^\s*[0-9][0-9,]*\s*$/.test(text) ? firstNumber(text) : undefined;
}

function isRoHSCompliant(value) {
  const text = String(value ?? "").toLowerCase();
  return (
    text.includes("rohs") &&
    !text.includes("non-rohs") &&
    !text.includes("non rohs") &&
    !text.includes("not rohs")
  );
}

function isActive(value) {
  return String(value ?? "").toLowerCase().includes("active");
}

function makeParameters(entries) {
  const parameters = {};
  for (const entry of entries ?? []) {
    const name = stringValue(entry?.ParameterText ?? entry?.Name ?? entry?.name);
    const value = stringValue(entry?.ValueText ?? entry?.Value ?? entry?.value);
    if (!name || !value) continue;
    parameters[name] = parameters[name] ? `${parameters[name]}; ${value}` : value;
  }
  return parameters;
}

function priceBreaks(product) {
  const variations = Array.isArray(product?.ProductVariations)
    ? product.ProductVariations
    : [{ StandardPricing: product?.StandardPricing }];

  return variations
    .flatMap((variation) =>
      (variation?.StandardPricing ?? []).map((price) =>
        cleanObject({
          break_quantity: price?.BreakQuantity,
          unit_price: price?.UnitPrice,
          total_price: price?.TotalPrice,
          currency: price?.Currency,
          package_type: variation?.PackageType?.Name ?? variation?.PackageType,
        }),
      ),
    )
    .slice(0, 12);
}

function summarizeDigiKeyProduct(product) {
  const parameters = makeParameters(product?.Parameters);
  const leadWeeks = product?.ManufacturerLeadWeeks;
  const summary = cleanObject({
    distributor: "DigiKey",
    distributor_part_number: product?.DigiKeyProductNumber ?? product?.DigiKeyPartNumber,
    manufacturer_part_number: product?.ManufacturerProductNumber,
    manufacturer: product?.Manufacturer?.Name ?? product?.Manufacturer,
    description:
      product?.Description?.ProductDescription ?? product?.Description?.DetailedDescription ?? product?.Description,
    category: product?.Category?.Name ?? product?.Category,
    product_status: product?.ProductStatus?.Status ?? product?.ProductStatus,
    discontinued: product?.ProductStatus?.Discontinued,
    end_of_life: product?.ProductStatus?.EndOfLife,
    rohs_status: product?.RohsStatus?.Status ?? product?.RohsStatus,
    quantity_available: product?.QuantityAvailable,
    lead_time: leadWeeks
      ? `${leadWeeks} weeks`
      : product?.NormallyStocking === true
        ? "Stock"
        : undefined,
    manufacturer_lead_weeks: leadWeeks,
    backorder_not_allowed: product?.BackOrderNotAllowed,
    shipping_info: product?.ShippingInfo,
    unit_price: product?.UnitPrice,
    price_breaks: priceBreaks(product),
    datasheet_url: product?.DatasheetUrl,
    product_url: product?.ProductUrl,
    image_url: product?.PhotoUrl,
    parameters,
  });

  return {
    ...summary,
    _search_text: JSON.stringify(summary),
  };
}

function mouserPriceBreaks(part) {
  return (part?.PriceBreaks ?? []).slice(0, 12).map((price) =>
    cleanObject({
      break_quantity: price?.Quantity,
      unit_price: price?.Price,
      currency: price?.Currency,
    }),
  );
}

function absoluteMouserUrl(url) {
  if (!url || typeof url !== "string") return undefined;
  return url.startsWith("http") ? url : `https://www.mouser.com${url}`;
}

function summarizeMouserPart(part) {
  const parameters = cleanObject({
    ...(part?.Specifications ?? {}),
    ...(part?.ProductAttributes ?? {}),
  });
  const summary = cleanObject({
    distributor: "Mouser",
    distributor_part_number: part?.MouserPartNumber,
    manufacturer_part_number: part?.ManufacturerPartNumber,
    manufacturer: part?.Manufacturer,
    description: part?.Description,
    category: part?.Category,
    lifecycle_status: part?.LifecycleStatus,
    rohs_status: part?.ROHSStatus ?? part?.RohsStatus,
    availability: part?.Availability,
    quantity_available: mouserAvailableQuantity(part?.Availability),
    lead_time: part?.LeadTime,
    price_breaks: mouserPriceBreaks(part),
    datasheet_url: part?.DataSheetUrl,
    product_url: absoluteMouserUrl(part?.ProductDetailUrl),
    image_url: absoluteMouserUrl(part?.ImagePath),
    parameters,
  });

  return {
    ...summary,
    _search_text: JSON.stringify({ ...summary, raw: part }),
  };
}

function matchesParameter(parameters, searchText, name, expected) {
  const normalizedName = normalizeText(name);
  const normalizedExpected = normalizeText(expected);
  if (!normalizedExpected) return { matched: true, value: "" };

  const matchedParameters = Object.entries(parameters ?? {}).filter(([parameterName]) => {
    const normalizedParameterName = normalizeText(parameterName);
    return (
      normalizedParameterName === normalizedName ||
      normalizedParameterName.includes(normalizedName) ||
      normalizedName.includes(normalizedParameterName)
    );
  });

  const values = matchedParameters.length
    ? matchedParameters.map(([, value]) => String(value))
    : [searchText];
  const matchingValue = values.find((value) => normalizeText(value).includes(normalizedExpected));
  return { matched: Boolean(matchingValue), value: matchingValue };
}

function evaluateRequirements(part, { filters = {}, manufacturer, quantity, inStockOnly, rohsOnly }) {
  const matchedFilters = {};
  const unmetRequirements = {};
  let requirementCount = 0;
  let matchCount = 0;

  for (const [name, expected] of Object.entries(filters)) {
    requirementCount += 1;
    const match = matchesParameter(part.parameters, part._search_text, name, expected);
    if (match.matched) {
      matchCount += 1;
      matchedFilters[name] = match.value;
    } else {
      unmetRequirements[name] = expected;
    }
  }

  if (manufacturer) {
    requirementCount += 1;
    if (normalizeText(part.manufacturer).includes(normalizeText(manufacturer))) {
      matchCount += 1;
      matchedFilters.manufacturer = part.manufacturer;
    } else {
      unmetRequirements.manufacturer = manufacturer;
    }
  }

  if (quantity !== undefined) {
    requirementCount += 1;
    if ((part.quantity_available ?? 0) >= quantity) {
      matchCount += 1;
      matchedFilters.minimum_quantity = part.quantity_available;
    } else {
      unmetRequirements.minimum_quantity = quantity;
    }
  } else if (inStockOnly) {
    requirementCount += 1;
    if ((part.quantity_available ?? 0) > 0) {
      matchCount += 1;
      matchedFilters.in_stock = part.quantity_available;
    } else {
      unmetRequirements.in_stock = true;
    }
  }

  if (rohsOnly) {
    requirementCount += 1;
    if (isRoHSCompliant(part.rohs_status ?? part._search_text)) {
      matchCount += 1;
      matchedFilters.rohs = part.rohs_status ?? "RoHS-compliant result";
    } else {
      unmetRequirements.rohs = true;
    }
  }

  return {
    ...part,
    score: requirementCount === 0 ? 100 : Math.round((matchCount / requirementCount) * 100),
    strict_match: Object.keys(unmetRequirements).length === 0,
    matched_filters: matchedFilters,
    unmet_requirements: unmetRequirements,
  };
}

function stripSearchText(part) {
  const { _search_text, ...result } = part;
  return result;
}

function uniqueParts(parts) {
  const seen = new Set();
  return parts.filter((part) => {
    const key = part.distributor_part_number ?? part.manufacturer_part_number;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function selectComponents({ distributorName, query, parts, filters, manufacturer, quantity, inStockOnly, rohsOnly, limit, total }) {
  const ranked = uniqueParts(parts)
    .map((part) => evaluateRequirements(part, { filters, manufacturer, quantity, inStockOnly, rohsOnly }))
    .sort((left, right) => {
      if (left.strict_match !== right.strict_match) return Number(right.strict_match) - Number(left.strict_match);
      if (left.score !== right.score) return right.score - left.score;
      if (isActive(left.product_status ?? left.lifecycle_status) !== isActive(right.product_status ?? right.lifecycle_status)) {
        return Number(isActive(right.product_status ?? right.lifecycle_status)) - Number(isActive(left.product_status ?? left.lifecycle_status));
      }
      return (right.quantity_available ?? 0) - (left.quantity_available ?? 0);
    });
  const strictMatches = ranked.filter((part) => part.strict_match);
  const candidates = (strictMatches.length > 0 ? strictMatches : ranked).slice(0, limit).map(stripSearchText);

  return cleanObject({
    distributor: distributorName,
    query,
    requirements: cleanObject({
      filters: Object.keys(filters).length > 0 ? filters : undefined,
      manufacturer,
      minimum_quantity: quantity,
      in_stock_only: inStockOnly || undefined,
      rohs_only: rohsOnly || undefined,
    }),
    result_summary: {
      catalog_matches: total,
      candidates_examined: ranked.length,
      strict_matches: strictMatches.length,
      returned: candidates.length,
    },
    note:
      strictMatches.length > 0
        ? undefined
        : "No candidate satisfies every requirement; returned candidates are ranked by the number of matched requirements.",
    candidates,
  });
}

async function fetchJson(provider, url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.text();
    let payload = {};
    if (body) {
      try {
        payload = JSON.parse(body);
      } catch {
        payload = { message: body };
      }
    }

    if (!response.ok) {
      const message = payload?.ErrorMessage ?? payload?.message ?? payload?.Message ?? "Request failed";
      throw new Error(`${provider} API request failed (${response.status}): ${String(message).slice(0, 500)}`);
    }

    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${provider} API request timed out after ${REQUEST_TIMEOUT_MS} ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&laquo;/gi, "«")
    .replace(/&raquo;/gi, "»")
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–")
    .replace(/&hellip;/gi, "…")
    .replace(/&#x([0-9a-f]+);/gi, (_, value) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number.parseInt(value, 10)));
}

function htmlText(value) {
  return decodeHtml(
    String(value ?? "")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function parseRussianNumber(value) {
  const match = String(value ?? "").replace(/\u00a0/g, " ").match(/\d[\d\s]*(?:[,.]\d+)?/);
  if (!match) return undefined;
  const parsed = Number(match[0].replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function absoluteUrl(base, path) {
  try {
    return new URL(decodeHtml(path), base).toString();
  } catch {
    return undefined;
  }
}

function publicCatalogChallengeDetected(html) {
  const text = String(html).toLowerCase();
  return [
    "captcha challenge",
    "проверка безопасности",
    "подтвердите, что вы не робот",
    "подтвердите, что вы человек",
    "cloudflare ray id",
    "access denied",
  ].some((marker) => text.includes(marker));
}

function supportedCharsetLabel(charset) {
  const label = String(charset ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (["windows1251", "cp1251", "win1251", "koi8r", "koi8u"].includes(label)) return "windows-1251";
  if (["utf8", "utf8mb4"].includes(label)) return "utf-8";
  return label || "utf-8";
}

const CP1251_REVERSE = (() => {
  const map = {};
  try {
    const decoder = new TextDecoder("windows-1251");
    for (let byte = 0x80; byte <= 0xff; byte += 1) {
      const character = decoder.decode(new Uint8Array([byte]));
      if (character && character !== "\uFFFD") map[character.codePointAt(0)] = byte;
    }
  } catch {
    // TextDecoder without windows-1251 support: fallback to UTF-8 encoding
  }
  return map;
})();

function toCp1251Url(value) {
  const encoder = new TextEncoder();
  let encoded = "";
  for (const character of String(value)) {
    const code = character.codePointAt(0);
    if (code < 0x80) {
      encoded += character;
      continue;
    }
    const byte = CP1251_REVERSE[code];
    if (byte !== undefined) {
      encoded += `%${byte.toString(16).padStart(2, "0")}`;
    } else {
      for (const byte of encoder.encode(character)) {
        encoded += `%${byte.toString(16).padStart(2, "0")}`;
      }
    }
  }
  return encoded;
}

async function fetchPublicCatalogHtml(distributor, url, options = {}) {
  const label = displayDistributorName(distributor);
  const previousRequest = publicCatalogLastRequestAt.get(distributor) ?? 0;
  const minInterval = distributor === "Elitan" ? 8000 : PUBLIC_CATALOG_MIN_INTERVAL_MS;
  const wait = Math.max(0, minInterval - (Date.now() - previousRequest));
  if (wait > 0) await sleep(wait);
  publicCatalogLastRequestAt.set(distributor, Date.now());

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "ru-RU,ru;q=0.9",
        "User-Agent": "ElectronicsPartsMCP/2.0 (user-initiated single-query catalog search)",
        ...(options.body ? { "Content-Type": options.contentType ?? "application/x-www-form-urlencoded; charset=UTF-8" } : {}),
      },
      body: options.body,
      signal: controller.signal,
    });
    if (response.status === 429) {
      throw new Error(`${label} limited the request (HTTP 429). No retry was attempted.`);
    }
    if (!response.ok) {
      throw new Error(`${label} public search returned HTTP ${response.status} for ${url}. No retry was attempted.`);
    }

    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > PUBLIC_CATALOG_MAX_RESPONSE_BYTES) {
      throw new Error(`${label} search response exceeds the 2 MiB parsing limit.`);
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > PUBLIC_CATALOG_MAX_RESPONSE_BYTES) {
      throw new Error(`${label} search response exceeds the 2 MiB parsing limit.`);
    }
    const charset = String(response.headers.get("content-type") ?? "").match(/charset=([^;\s]+)/i)?.[1] ?? "";
    let html;
    try {
      html = new TextDecoder(supportedCharsetLabel(charset), { fatal: false }).decode(buffer);
    } catch {
      html = new TextDecoder().decode(buffer);
    }
    if (publicCatalogChallengeDetected(html)) {
      throw new Error(`${label} returned a CAPTCHA or access challenge. The MCP stopped without attempting to bypass it.`);
    }
    return html;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${label} public search timed out after ${REQUEST_TIMEOUT_MS} ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function digiKeySettings(site, currency) {
  const clientId = environmentValue("DIGIKEY_CLIENT_ID");
  const clientSecret = environmentValue("DIGIKEY_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new Error(
      "DigiKey credentials are not configured (DIGIKEY_CLIENT_ID and DIGIKEY_CLIENT_SECRET). No DigiKey API request was sent. Register a Product Information API application at https://developer.digikey.com/.",
    );
  }

  const sandbox = ["1", "true", "yes"].includes(process.env.DIGIKEY_USE_SANDBOX?.toLowerCase());
  return {
    clientId,
    clientSecret,
    apiBase: sandbox ? "https://sandbox-api.digikey.com" : "https://api.digikey.com",
    site: (site ?? process.env.DIGIKEY_SITE ?? "US").toUpperCase(),
    currency: (currency ?? process.env.DIGIKEY_CURRENCY ?? "USD").toUpperCase(),
    language: (process.env.DIGIKEY_LANGUAGE ?? "en").toLowerCase(),
  };
}

async function digiKeyAccessToken(settings) {
  if (digiKeyToken && digiKeyToken.expiresAt > Date.now() + 30000) return digiKeyToken.value;

  const form = new URLSearchParams({
    client_id: settings.clientId,
    client_secret: settings.clientSecret,
    grant_type: "client_credentials",
  });
  const payload = await fetchJson("DigiKey", `${settings.apiBase}/v1/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (!payload.access_token) throw new Error("DigiKey OAuth response did not include an access token.");

  digiKeyToken = {
    value: payload.access_token,
    expiresAt: Date.now() + Math.max(Number(payload.expires_in ?? 600) - 30, 30) * 1000,
  };
  return digiKeyToken.value;
}

async function digiKeyRequest(path, { method = "GET", body, site, currency } = {}) {
  const settings = digiKeySettings(site, currency);
  const token = await digiKeyAccessToken(settings);
  const headers = {
    Authorization: `Bearer ${token}`,
    "X-DIGIKEY-Client-Id": settings.clientId,
    "X-DIGIKEY-Locale-Site": settings.site,
    "X-DIGIKEY-Locale-Language": settings.language,
    "X-DIGIKEY-Locale-Currency": settings.currency,
  };
  if (body) headers["Content-Type"] = "application/json";

  return fetchJson("DigiKey", `${settings.apiBase}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function searchDigiKey(input) {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const fetchLimit = Math.min(MAX_FETCH, Math.max(limit * 3, DEFAULT_LIMIT));
  const searchOptions = [];
  if (input.in_stock_only || input.quantity !== undefined) searchOptions.push("InStock");
  if (input.rohs_only) searchOptions.push("RohsCompliant");
  const body = cleanObject({
    Keywords: input.query,
    Limit: fetchLimit,
    Offset: 0,
    FilterOptionsRequest: searchOptions.length > 0 ? { SearchOptions: searchOptions } : undefined,
  });
  const response = await digiKeyRequest("/products/v4/search/keyword", {
    method: "POST",
    body,
    site: input.site,
    currency: input.currency,
  });
  const products = [...(response.ExactMatches ?? []), ...(response.Products ?? [])].map((product) =>
    summarizeDigiKeyProduct(product?.Product ?? product),
  );

  return selectComponents({
    distributorName: "DigiKey",
    query: input.query,
    parts: products,
    filters: input.filters ?? {},
    manufacturer: input.manufacturer,
    quantity: input.quantity,
    inStockOnly: input.in_stock_only,
    rohsOnly: input.rohs_only,
    limit,
    total: response.ProductsCount ?? response.TotalCount ?? products.length,
  });
}

async function digiKeyDetails(input) {
  const query = input.manufacturer_id
    ? `?${new URLSearchParams({ manufacturerId: input.manufacturer_id })}`
    : "";
  const response = await digiKeyRequest(
    `/products/v4/search/${encodeURIComponent(input.part_number)}/productdetails${query}`,
    { site: input.site, currency: input.currency },
  );
  return {
    distributor: "DigiKey",
    component: stripSearchText(summarizeDigiKeyProduct(response.Product ?? response)),
  };
}

function mouserSettings() {
  const apiKey = environmentValue("MOUSER_API_KEY");
  if (!apiKey) {
    throw new Error(
      "Mouser credentials are not configured (MOUSER_API_KEY). No Mouser API request was sent. Request a Search API key at https://www.mouser.com/api-search/.",
    );
  }
  return {
    apiKey,
    apiBase: (process.env.MOUSER_API_BASE_URL ?? "https://api.mouser.com/api").replace(/\/+$/, ""),
  };
}

async function mouserRequest(path, body) {
  const settings = mouserSettings();
  const url = new URL(`${settings.apiBase}/${path.replace(/^\//, "")}`);
  url.searchParams.set("apiKey", settings.apiKey);
  return fetchJson("Mouser", url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
}

async function searchMouser(input) {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const fetchLimit = Math.min(MAX_FETCH, Math.max(limit * 3, DEFAULT_LIMIT));
  const searchOptions = input.in_stock_only || input.quantity !== undefined
    ? input.rohs_only
      ? "RohsAndInStock"
      : "InStock"
    : input.rohs_only
      ? "Rohs"
      : undefined;
  const body = {
    SearchByKeywordRequest: cleanObject({
      keyword: input.query,
      records: fetchLimit,
      startingRecord: 0,
      searchOptions,
    }),
  };
  const response = await mouserRequest("v1/search/keyword", body);
  const parts = (response.SearchResults?.Parts ?? []).map(summarizeMouserPart);

  return selectComponents({
    distributorName: "Mouser",
    query: input.query,
    parts,
    filters: input.filters ?? {},
    manufacturer: input.manufacturer,
    quantity: input.quantity,
    inStockOnly: input.in_stock_only,
    rohsOnly: input.rohs_only,
    limit,
    total: response.SearchResults?.NumberOfResult ?? response.SearchResults?.NumberOfResults ?? parts.length,
  });
}

async function mouserDetails(input) {
  const response = await mouserRequest("v1/search/partnumber", {
    SearchByPartRequest: {
      mouserPartNumber: input.part_number,
      partSearchOptions: "Exact",
    },
  });
  const part = response.SearchResults?.Parts?.[0];
  if (!part) throw new Error(`Mouser did not return a component for ${input.part_number}.`);
  return {
    distributor: "Mouser",
    component: stripSearchText(summarizeMouserPart(part)),
  };
}

function nonEmptyEnvironment(name, fallback) {
  const value = environmentValue(name);
  return value || fallback;
}

function randomAlphaNumeric(length) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(length);
  let nonce = "";
  for (const byte of bytes) nonce += alphabet[byte % alphabet.length];
  return nonce;
}

function lcscSettings() {
  const key = environmentValue("LCSC_API_KEY");
  const secret = environmentValue("LCSC_API_SECRET");
  if (!key || !secret) {
    throw new Error(
      "LCSC credentials are not configured (LCSC_API_KEY and LCSC_API_SECRET). No LCSC API request was sent. Apply for its approved B2B API at https://www.lcsc.com/agent; LCSC must also whitelist the source IP.",
    );
  }

  const algorithm = nonEmptyEnvironment("LCSC_SIGNATURE_ALGORITHM", "sha256").toLowerCase();
  if (algorithm !== "sha1" && algorithm !== "sha256") {
    throw new Error("LCSC_SIGNATURE_ALGORITHM must be sha256 or sha1.");
  }

  return {
    key,
    secret,
    algorithm,
    apiBase: nonEmptyEnvironment("LCSC_API_BASE_URL", "https://api.lcsc.com").replace(/\/+$/, ""),
  };
}

async function lcscRequest(path, parameters) {
  const settings = lcscSettings();
  const url = new URL(`${settings.apiBase}${path}`);
  for (const [name, value] of Object.entries(parameters)) {
    if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
  }

  const nonce = randomAlphaNumeric(16);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signatureInput = `key=${settings.key}&nonce=${nonce}&secret=${settings.secret}&timestamp=${timestamp}`;
  const signature = createHash(settings.algorithm).update(signatureInput, "utf8").digest("hex");
  const response = await fetchJson("LCSC", url, {
    headers: {
      Accept: "application/json",
      key: settings.key,
      nonce,
      timestamp,
      signature,
    },
  });

  if (response?.success === false || (response?.code !== undefined && Number(response.code) !== 200)) {
    throw new Error(`LCSC API error ${response?.code ?? "unknown"}: ${response?.message ?? "Request failed"}`);
  }
  return response?.result ?? {};
}

function lcscPriceBreaks(productPrice) {
  return (productPrice?.standardPricing ?? []).slice(0, 12).map((price) =>
    cleanObject({
      break_quantity: price?.breakQuantity,
      unit_price: price?.unitPrice,
      discount_rate: price?.discountRate,
      currency: productPrice?.currency,
    }),
  );
}

function summarizeLcscProduct(product) {
  const productPrice = product?.productPrice ?? {};
  const parameters = cleanObject({
    Package: product?.package,
    "Package Type": product?.packageType,
    "Minimum Order Quantity": product?.minimumOrderQuantity,
    "Increment Quantity": product?.incrementQuantity,
    "Manufacturer Standard Package": product?.manufacturerStandardPackageQuantity,
  });
  const summary = cleanObject({
    distributor: "LCSC",
    distributor_part_number: product?.lcscProductNumber,
    manufacturer_part_number: product?.manufacturerProductNumber ?? product?.manufacturerProductCode,
    manufacturer: product?.manufacturer?.name ?? product?.manufacturer?.manufacturerName,
    description: product?.description,
    category: product?.category?.name ?? product?.category?.categoryName ?? product?.category,
    product_status: product?.isOnSale === true ? "Active" : undefined,
    availability: product?.isInStock === true ? "In Stock" : product?.isInStock === false ? "Out of Stock" : undefined,
    quantity_available: firstNumber(productPrice?.quantityAvailable),
    unit_price: productPrice?.standardPricing?.[0]?.unitPrice,
    price_breaks: lcscPriceBreaks(productPrice),
    datasheet_url: product?.datasheetURL ?? product?.datasheetUrl,
    product_url: product?.productDetailURL ?? product?.productDetailUrl,
    image_url: product?.productPhotoURL?.[0] ?? product?.productPhotoUrl?.[0],
    parameters,
  });

  return {
    ...summary,
    _search_text: JSON.stringify({ ...summary, raw: product }),
  };
}

async function lcscKeywordSearch(input) {
  return lcscRequest("/rest/api/agent/product/v1/keywordsearch", {
    keyword: input.query,
    limit: input.limit,
    offset: input.offset ?? 0,
    language: "EN",
    returnInformation: "All",
    currency: input.currency ?? "USD",
    inStockOnly: Boolean(input.in_stock_only || input.quantity !== undefined),
  });
}

async function searchLcsc(input) {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const response = await lcscKeywordSearch({
    query: input.query,
    limit: Math.min(MAX_FETCH, Math.max(limit * 3, DEFAULT_LIMIT)),
    currency: input.currency,
    in_stock_only: input.in_stock_only,
    quantity: input.quantity,
  });
  const products = (response.products ?? []).map(summarizeLcscProduct);

  return selectComponents({
    distributorName: "LCSC",
    query: input.query,
    parts: products,
    filters: input.filters ?? {},
    manufacturer: input.manufacturer,
    quantity: input.quantity,
    inStockOnly: input.in_stock_only,
    rohsOnly: input.rohs_only,
    limit,
    total: response.productCount ?? products.length,
  });
}

async function lcscDetails(input) {
  const response = await lcscKeywordSearch({
    query: input.part_number,
    limit: 20,
    currency: input.currency,
    in_stock_only: false,
  });
  const components = (response.products ?? []).map(summarizeLcscProduct);
  const target = normalizeText(input.part_number);
  const component = components.find((candidate) =>
    [candidate.distributor_part_number, candidate.manufacturer_part_number].some(
      (partNumber) => normalizeText(partNumber) === target,
    ),
  );
  if (!component) throw new Error(`LCSC did not return a component for ${input.part_number}.`);
  return { distributor: "LCSC", component: stripSearchText(component) };
}

async function lcscPublicSearchRaw(input) {
  const keyword = String(input.query ?? "").trim();
  if (keyword.length < 2 || keyword.length > 120) {
    throw new Error("LCSC public search keyword must be 2-120 characters.");
  }
  const page = Math.max(1, Math.trunc(input.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.trunc(input.page_size ?? 25)));
  const body = JSON.stringify(
    cleanObject({
      keyword,
      secondKeyword: "",
      brandIdList: Array.isArray(input.brand_ids) ? input.brand_ids : [],
      catalogIdList: Array.isArray(input.catalog_ids) ? input.catalog_ids : [],
      isStock: Boolean(input.in_stock_only),
      isAsianBrand: Boolean(input.asian_brand_only),
      isDeals: Boolean(input.deals_only),
      isRohsCert: Boolean(input.rohs_only),
      sortField: input.sort_field,
      sortType: input.sort_type,
      currentPage: page,
      pageSize,
    }),
  );
  const payload = await fetchPublicCatalogJson("LCSC", LCSC_PUBLIC_SEARCH_URL, {
    method: "POST",
    contentType: "application/json",
    body,
    headers: {
      Origin: "https://www.lcsc.com",
      Referer: `https://www.lcsc.com/search?q=${encodeURIComponent(keyword)}`,
    },
  });
  if (Number(payload?.code) !== 200 || !payload?.result || typeof payload.result !== "object") {
    throw new Error(
      `LCSC public search backend failed: ${payload?.msg ?? "unexpected response"}. No retry was attempted.`,
    );
  }
  return payload.result;
}

async function lcscPublicThirdPartySearchRaw(input) {
  const keyword = String(input.query ?? "").trim();
  if (keyword.length < 2 || keyword.length > 120) {
    throw new Error("LCSC public search keyword must be 2-120 characters.");
  }
  const pageSize = Math.min(100, Math.max(1, Math.trunc(input.third_page_size ?? 25)));
  const body = JSON.stringify(
    cleanObject({
      keyword,
      currentPage: 1,
      pageSize,
      sortField: input.sort_field,
      sortType: input.sort_type,
    }),
  );
  const payload = await fetchPublicCatalogJson("LCSC", LCSC_PUBLIC_THIRD_SEARCH_URL, {
    method: "POST",
    contentType: "application/json",
    body,
    headers: {
      Origin: "https://www.lcsc.com",
      Referer: `https://www.lcsc.com/search?q=${encodeURIComponent(keyword)}`,
    },
  });
  if (Number(payload?.code) !== 200 || !payload?.result || typeof payload.result !== "object") {
    throw new Error(
      `LCSC public third-party channel search failed: ${payload?.msg ?? "unexpected response"}. No retry was attempted.`,
    );
  }
  return payload.result;
}

function lcscPublicPriceBreaks(productPriceList) {
  return (Array.isArray(productPriceList) ? productPriceList : [])
    .slice(0, 12)
    .map((price) =>
      cleanObject({
        break_quantity: firstNumber(price?.ladder),
        unit_price: firstNumber(price?.productPrice ?? price?.usdPrice ?? price?.currencyPrice),
        discount_rate: price?.discountRate,
        currency: price?.currencySymbol,
      }),
    )
    .filter((level) => level.break_quantity !== undefined && level.unit_price !== undefined);
}

function lcscPublicStock(item) {
  const domestic = item?.domesticStockVO ?? {};
  const overseas = item?.overseasStockVO ?? {};
  return cleanObject({
    total: firstNumber(item?.stockNumber),
    domestic_total: firstNumber(domestic?.total),
    domestic_ship_immediately: firstNumber(domestic?.shipImmediately),
    domestic_ship_3_days: firstNumber(domestic?.ship3Days),
    overseas_total: firstNumber(overseas?.total),
    overseas_ship_immediately: firstNumber(overseas?.shipImmediately),
    overseas_ship_3_days: firstNumber(overseas?.ship3Days),
  });
}

function summarizeLcscPublicProduct(item, { thirdParty = false } = {}) {
  const priceBreaks = lcscPublicPriceBreaks(item?.productPriceList);
  const productCode = item?.productCode;
  const categoryRaw = cleanObject({
    root: item?.firstWmCatalogNameEn,
    level2: item?.secondWmCatalogNameEn,
    level3: item?.thirdWmCatalogNameEn,
    level4: item?.fourthWmCatalogNameEn,
    level5: item?.fifthWmCatalogNameEn,
    level6: item?.sixthWmCatalogNameEn,
  });
  const category = Object.keys(categoryRaw).length > 0 ? categoryRaw : undefined;
  const stockNumber = firstNumber(item?.stockNumber);
  const summary = cleanObject({
    product_code: productCode,
    manufacturer_part_number: item?.productModel ?? item?.productCodeManufacturer,
    manufacturer: item?.brandNameEn ?? item?.lcOrderBrandNameEn,
    description: item?.productIntroEn,
    name: item?.productNameEn,
    category,
    package: item?.encapStandard,
    unit: item?.productUnit,
    arrange: item?.productArrange,
    min_packet_unit: item?.minPacketUnit,
    min_packet_quantity: firstNumber(item?.minPacketNumber),
    min_buy_quantity: firstNumber(item?.minBuyNumber),
    availability: stockNumber !== undefined ? (stockNumber > 0 ? "In Stock" : "Out of Stock") : undefined,
    stock: lcscPublicStock(item),
    unit_price: priceBreaks[0]?.unit_price,
    price_breaks: priceBreaks,
    product_url: item?.url ?? (productCode ? `https://www.lcsc.com/product-detail/${productCode}.html` : undefined),
    datasheet_url: item?.pdfUrl,
    image_url: item?.productImageUrlBig ?? item?.productImageUrl,
    weight_kg: firstNumber(item?.productWeight),
    rohs: item?.isRohsCert === true ? "Yes" : undefined,
    eccn: item?.eccn,
    is_hot: item?.isHot === true || undefined,
    is_discount: item?.isDiscount === true || undefined,
    is_reel: item?.isReel === true || undefined,
    product_cycle: item?.productCycle,
    ...(thirdParty
      ? {
          channel: "third_party",
          supply_channel: item?.supplyChannelType,
          product_source: item?.productSource,
          batch: item?.batchNumberEn ?? item?.batchNumber,
          delivery_time_days: Array.isArray(item?.deliveryTimeWayDays) ? `${item.deliveryTimeWayDays[0]}-${item.deliveryTimeWayDays[1]}` : undefined,
        }
      : {}),
  });
  return {
    ...summary,
    _search_text: JSON.stringify({ ...summary, raw: item }),
  };
}

async function searchLcscPublic(input) {
  const result = await lcscPublicSearchRaw(input);
  const regular = result.productSearchResultVO?.productList
    ?? result.productSearchResultVO?.list
    ?? (Array.isArray(result.productSearchResultVO) ? result.productSearchResultVO : []);
  const items = [
    ...(Array.isArray(result.exactMatchResult) ? result.exactMatchResult : []),
    ...(Array.isArray(regular) ? regular : []),
  ];
  const seen = new Set();
  const unique = items.filter((item) => {
    const code = item?.productCode;
    if (!code || seen.has(code)) return false;
    seen.add(code);
    return true;
  });

  const page = Math.max(1, Math.trunc(input.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.trunc(input.page_size ?? 25)));
  const totalCount = firstNumber(result.totalCount) ?? unique.length;
  const limit = Math.max(1, Math.trunc(input.limit ?? 10));

  let thirdPartyItems;
  let thirdPartyCount;
  if (input.include_third_party !== false && unique.length < limit) {
    try {
      const third = await lcscPublicThirdPartySearchRaw({ ...input, third_page_size: Math.max(limit, pageSize) });
      thirdPartyCount = firstNumber(third?.totalCount);
      const thirdList = third?.productList ?? third?.dataList ?? [];
      thirdPartyItems = thirdList
        .filter((item) => item?.productCode && !seen.has(item.productCode))
        .slice(0, Math.max(0, limit - unique.length))
        .map((item) => summarizeLcscPublicProduct(item, { thirdParty: true }));
      for (const item of thirdPartyItems) {
        if (item.product_code) seen.add(item.product_code);
      }
    } catch (error) {
      thirdPartyItems = undefined;
      thirdPartyCount = undefined;
    }
  }

  const brands = (Array.isArray(result.brandVOS) ? result.brandVOS : [])
    .slice(0, 25)
    .map((brand) =>
      cleanObject({
        brand_id: brand?.brandId,
        name: brand?.brandNameEn,
        product_count: firstNumber(brand?.productNum),
      }),
    );
  const catalogs = (Array.isArray(result.catalogVOS) ? result.catalogVOS : [])
    .slice(0, 25)
    .map((catalog) =>
      cleanObject({
        catalog_id: catalog?.catalogId,
        name: catalog?.catalogNameEn,
        product_count: firstNumber(catalog?.productNum),
        subcatalogs: (Array.isArray(catalog?.childCatelogs) ? catalog.childCatelogs : []).map((child) =>
          cleanObject({
            catalog_id: child?.catalogId,
            name: child?.catalogNameEn,
            product_count: firstNumber(child?.productNum),
          }),
        ),
      }),
    );
  const leafCatalogId = (() => {
    let leaf;
    for (const catalog of Array.isArray(result.catalogVOS) ? result.catalogVOS : []) {
      leaf = catalog;
      while (Array.isArray(leaf?.childCatelogs) && leaf.childCatelogs.length > 0) leaf = leaf.childCatelogs[0];
      break;
    }
    return leaf?.catalogId;
  })();

  const emptyItems = unique.length === 0 && !(thirdPartyItems && thirdPartyItems.length > 0);
  return cleanObject({
    distributor: "LCSC",
    source: "public site search backend (no API credentials)",
    query: input.query,
    total_count: totalCount,
    total_page: firstNumber(result.productTotalPage ?? result.totalPage) ?? Math.ceil(totalCount / pageSize),
    page,
    page_size: pageSize,
    has_exact_match: Array.isArray(result.exactMatchResult) && result.exactMatchResult.length > 0,
    items: unique.map((item) => summarizeLcscPublicProduct(item)).slice(0, limit),
    third_party_count: thirdPartyCount,
    third_party_items: thirdPartyItems && thirdPartyItems.length > 0 ? thirdPartyItems : undefined,
    available_brands: brands.length > 0 ? brands : undefined,
    available_catalogs: catalogs.length > 0 ? catalogs : undefined,
    category_url:
      emptyItems && result.isToCategory === true && leafCatalogId
        ? `https://www.lcsc.com/category/${leafCatalogId}.html?globalKeyword=${encodeURIComponent(input.query)}`
        : undefined,
    note: emptyItems
      ? (result.isToCategory === true && leafCatalogId
          ? `The public search backend redirected this query to a category page instead of returning product rows; category_url opens the same category listing the lcsc.com search page navigates to.`
          : "The public search backend returned no product rows for this query; use an exact manufacturer part number or C-code, or the official API tools.")
      : (thirdPartyItems && thirdPartyItems.length > 0
          ? "third_party_items come from the same 'Verified Third-party Channels' panel the lcsc.com search page shows for this query."
          : undefined),
  });
}

async function lcscPublicDetails(input) {
  const code = String(input.part_number ?? "").trim().toUpperCase();
  if (!/^C\d{1,12}$/.test(code)) {
    throw new Error(
      "part_number must be an LCSC C-code (C followed by digits), for example C780769. Only C-codes are resolvable without the official API.",
    );
  }
  const url = `https://www.lcsc.com/product-detail/${encodeURIComponent(code)}.html`;
  const html = await fetchPublicCatalogHtml("LCSC", url);
  const details = parseLcscPublicProductPage(html, code);
  if (!details) {
    throw new Error(
      `LCSC public product page for ${code} did not contain product data. The C-code may be invalid or the page layout changed. No retry was attempted.`,
    );
  }
  return { distributor: "LCSC", source: "public product page (no API credentials)", component: details };
}

function parseLcscPublicProductPage(html, expectedCode) {
  const blocks = [];
  const scriptPattern = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptPattern.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      blocks.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      // Ignore malformed JSON-LD blocks
    }
  }
  const target = String(expectedCode ?? "").toUpperCase();
  const product = blocks.find((block) => {
    if (!block || typeof block !== "object") return false;
    const types = Array.isArray(block["@type"]) ? block["@type"] : [block["@type"]];
    if (!types.includes("Product")) return false;
    const sku = String(block?.sku ?? "").toUpperCase();
    const mpn = String(block?.mpn ?? "").toUpperCase();
    return target && (sku === target || mpn === target);
  }) ?? blocks.find((block) => {
    const types = Array.isArray(block?.["@type"]) ? block["@type"] : [block?.["@type"]];
    return types.includes("Product");
  });
  if (!product) return undefined;

  const offers = Array.isArray(product?.offers) ? product.offers[0] : product?.offers;
  const parameters = Array.isArray(product?.additionalProperty)
    ? Object.fromEntries(
        product.additionalProperty
          .map((property) => [String(property?.name ?? "").trim(), String(property?.value ?? "").trim()])
          .filter(([name, value]) => name && value),
      )
    : undefined;
  return cleanObject({
    product_code: product?.sku,
    manufacturer_part_number: product?.mpn,
    name: product?.name,
    manufacturer: typeof product?.brand === "string" ? product.brand : product?.brand?.name,
    description: product?.description,
    category: product?.category,
    image_url: Array.isArray(product?.image) ? product.image[0] : product?.image,
    price_usd: firstNumber(offers?.price),
    price_currency: offers?.priceCurrency,
    availability: offers?.availability,
    quantity_available: firstNumber(offers?.inventoryLevel),
    parameters: parameters && Object.keys(parameters).length > 0 ? parameters : undefined,
    product_url: typeof offers?.url === "string" ? offers.url : `https://www.lcsc.com/product-detail/${target}.html`,
  });
}

function jlcpcbSettings() {
  const appId = environmentValue("JLCPCB_APP_ID");
  const accessKey = environmentValue("JLCPCB_ACCESS_KEY");
  const secretKey = environmentValue("JLCPCB_SECRET_KEY");
  if (!appId || !accessKey || !secretKey) {
    throw new Error(
      "JLCPCB credentials are not configured (JLCPCB_APP_ID, JLCPCB_ACCESS_KEY, and JLCPCB_SECRET_KEY). No JLCPCB API request was sent. Apply for Components API access at https://api.jlcpcb.com/.",
    );
  }

  return {
    appId,
    accessKey,
    secretKey,
    apiBase: nonEmptyEnvironment("JLCPCB_ENDPOINT", "https://open.jlcpcb.com").replace(/\/+$/, ""),
  };
}

async function jlcpcbRequest(path, body) {
  const settings = jlcpcbSettings();
  const url = new URL(`${settings.apiBase}${path}`);
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = randomAlphaNumeric(32);
  const bodyText = JSON.stringify(body ?? {});
  const canonicalUri = `${url.pathname}${url.search}`;
  const stringToSign = `POST\n${canonicalUri}\n${timestamp}\n${nonce}\n${bodyText}\n`;
  const signature = createHmac("sha256", settings.secretKey).update(stringToSign, "utf8").digest("base64");
  const authorization = `JOP appid="${settings.appId}",accesskey="${settings.accessKey}",timestamp="${timestamp}",nonce="${nonce}",signature="${signature}"`;
  const response = await fetchJson("JLCPCB", url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: authorization,
    },
    body: bodyText,
  });

  if (Number(response?.code) !== 200) {
    throw new Error(`JLCPCB API error ${response?.code ?? "unknown"}: ${response?.message ?? "Request failed"}`);
  }
  return response.data;
}

async function jlcpcbComponentDetails(input) {
  const data = await jlcpcbRequest("/overseas/openapi/component/getComponentDetailByCode", {
    componentCodes: input.lcsc_codes,
  });
  return {
    distributor: "JLCPCB",
    source: "Official Components API",
    component_codes: input.lcsc_codes,
    data,
  };
}

async function jlcpcbComponentLibrary(input) {
  const page = input.page ?? 1;
  const pageSize = input.page_size ?? 30;
  const data = await jlcpcbRequest("/overseas/openapi/component/getComponentLibraryList", {
    currentPage: page,
    pageSize,
  });
  return { distributor: "JLCPCB", source: "Official Components API", page, data };
}

function parseChipDipResults(html, limit) {
  const results = [];
  const rows = html.matchAll(/<tr\b(?=[^>]*class="[^"]*with-hover[^"]*")[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const rowMatch of rows) {
    if (results.length >= limit) break;
    const row = rowMatch[1];
    const product = row.match(/<a\b(?=[^>]*href="([^"]*\/product\/[^"]*)")[^>]*>([\s\S]*?)<\/a>/i);
    const title = htmlText(product?.[2]);
    const productUrl = absoluteUrl("https://www.chipdip.ru", product?.[1]);
    if (!title || !productUrl) continue;

    const availabilityCell = row.match(/<td\b[^>]*class="[^"]*\bh_av\b[^"]*"[^>]*>([\s\S]*?)<\/td>/i)?.[1] ?? "";
    const availabilityValues = [...availabilityCell.matchAll(/<span\b[^>]*class="[^"]*\bnw\b[^"]*"[^>]*>([\s\S]*?)<\/span>/gi)]
      .map((match) => htmlText(match[1]));
    const quantityText = availabilityValues.find((value) => /шт\.?/i.test(value));
    const leadTime = availabilityValues.find((value) => /(дн|нед|час)/i.test(value))?.replace(/,\s*$/, "");
    const priceMarkup = row.match(/<span\b[^>]*class="[^"]*\bprice-main\b[^"]*"[^>]*>([\s\S]*?)<\/span>\s*<span\b[^>]*class="[^"]*\bmulti\b/i)?.[1]
      ?? row.match(/<span\b[^>]*id="price_[^"]+"[^>]*>([^<]+)<\/span>/i)?.[1];
    const manufacturer = htmlText(
      row.match(/Бренд:\s*(?:&nbsp;|&#160;|\s)*<span\b[^>]*class="[^"]*itemlist_pval[^"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1],
    );

    results.push(cleanObject({
      distributor: displayDistributorName("ChipDip"),
      title,
      manufacturer: manufacturer || undefined,
      available_quantity: parseRussianNumber(quantityText),
      listed_as_delivery: /item__avail_delivery/i.test(availabilityCell) || undefined,
      lead_time: leadTime,
      price_rub: parseRussianNumber(htmlText(priceMarkup)),
      minimum_order_quantity: Number(row.match(/\bdata-min="(\d+)"/i)?.[1]) || undefined,
      product_url: productUrl,
    }));
  }
  return results;
}

function promelecQuantity(card, label) {
  const pattern = new RegExp(
    `<div[^>]*class="[^"]*table-list__mob-title[^"]*"[^>]*>\\s*${label}\\s*<\\/div>\\s*<div[^>]*class="[^"]*table-list__counter[^"]*"[^>]*>\\s*<span[^>]*>([^<]+)<\\/span>`,
    "i",
  );
  return parseRussianNumber(card.match(pattern)?.[1]);
}

function parsePromelecResults(html, limit) {
  const starts = [...html.matchAll(/<div\b[^>]*class="[^"]*\btable-list__item\b[^"]*"[^>]*>/gi)]
    .map((match) => match.index)
    .filter((index) => index !== undefined);
  const results = [];

  for (let index = 0; index < starts.length && results.length < limit; index += 1) {
    const card = html.slice(starts[index], starts[index + 1] ?? html.length);
    const product = card.match(/<a\b(?=[^>]*href="([^"]*\/product\/[^"]*)")(?=[^>]*class="[^"]*product-preview__title[^"]*")[^>]*>([\s\S]*?)<\/a>/i);
    const title = htmlText(product?.[2]);
    const productUrl = absoluteUrl("https://www.promelec.ru", product?.[1]);
    if (!title || !productUrl) continue;

    const manufacturer = htmlText(
      card.match(/Производитель:\s*<\/div>\s*<div[^>]*class="param-cell"[^>]*>([\s\S]*?)<\/div>/i)?.[1],
    );
    const priceMarkup = card.match(/<span\b[^>]*class="[^"]*\btable-list__price\b[^"]*"[^>]*>\s*от\s*([^<]+)<span\b[^>]*class="rub"/i)?.[1];
    const description = htmlText(card.match(/<span\b[^>]*class="[^"]*product-preview__code[^"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1]);

    results.push(cleanObject({
      distributor: displayDistributorName("Promelec"),
      title,
      description: description || undefined,
      manufacturer: manufacturer || undefined,
      available_quantity: promelecQuantity(card, "Наличие:"),
      available_to_order_quantity: promelecQuantity(card, "Под заказ:"),
      price_from_rub: parseRussianNumber(priceMarkup),
      product_url: productUrl,
    }));
  }
  return results;
}

async function searchChipDipPublic(input) {
  const limit = Math.min(10, input.limit ?? 10);
  const url = new URL("https://www.chipdip.ru/search");
  url.searchParams.set("searchtext", input.query);
  const html = await fetchPublicCatalogHtml("ChipDip", url);
  const candidates = parseChipDipResults(html, limit);
  return {
    distributor: displayDistributorName("ChipDip"),
    source: "User-authorized public HTML search, not a supplier API",
    query: input.query,
    source_url: url.toString(),
    result_summary: { returned: candidates.length, request_count: 1 },
    notice: "One search page was requested. Product pages are not fetched; delivery listings are not equivalent to local shelf stock.",
    candidates,
  };
}

async function searchPromelecPublic(input) {
  const limit = Math.min(10, input.limit ?? 10);
  const url = new URL("https://www.promelec.ru/search/");
  url.searchParams.set("query", input.query);
  const html = await fetchPublicCatalogHtml("Promelec", url);
  let candidates = parsePromelecResults(html, limit);
  if (input.include_product_details === true && candidates.length > 0) {
    candidates = await enrichCandidatesWithCards("Promelec", candidates, limit, fetchPromelecProductCard);
  }
  return {
    distributor: displayDistributorName("Promelec"),
    source: "User-authorized public HTML search and product cards, not a supplier API",
    query: input.query,
    source_url: url.toString(),
    result_summary: {
      returned: candidates.length,
      request_count: 1 + (input.include_product_details === true ? candidates.length : 0),
    },
    notice: "One search page was requested. Product cards are fetched only when include_product_details is true; price is the displayed 'from' price and may depend on quantity.",
    candidates,
  };
}

function parsePromelecProductCard(html) {
  const priceFrom = html.match(/<div class="price_from">[\s\S]*?<h3>([\d.,]+)\s*руб\.?<\/h3>/i)?.[1];
  const sections = [];
  const sectionStarts = [...html.matchAll(/<div class="js-accordion-wrap">/gi)].map((match) => match.index);
  for (let index = 0; index < sectionStarts.length; index += 1) {
    const block = html.slice(sectionStarts[index], sectionStarts[index + 1] ?? html.length);
    const title = htmlText(block.match(/<div class="popup-product-table__title hide-sm-mob">([\s\S]*?)<\/div>/i)?.[1]);
    const warehouses = [];
    for (const offerMatch of block.matchAll(/<li class="table-popup-list__item">([\s\S]*?)<\/li>/gi)) {
      const offer = offerMatch[1];
      const minQtys = [...offer.matchAll(/data-min-qty="(\d+)"/gi)].map((match) => Number(match[1]));
      const prices = [...offer.matchAll(/data-index-price="\d+">([\d.,]+)/gi)].map((match) => Number(match[1].replace(",", ".")));
      const priceBreaks = minQtys.map((breakQuantity, breakIndex) =>
        cleanObject({ break_quantity: breakQuantity, unit_price: prices[breakIndex] }),
      );
      const amountAttr = offer.match(/jsAmountInWarehouse[\s\S]*?data-amount="(\d+)"/i)?.[1];
      const amountText = htmlText(offer.match(/<span class="table-list__counter">([\s\S]*?)<\/span>/i)?.[1]);
      const minQtyAttr = offer.match(/jsMinAmount[\s\S]*?data-amount="(\d+)"/i)?.[1];
      const minQtyText = offer.match(/Мин:?\s*([\d\s]+)\s*шт/i)?.[1];
      const term = htmlText(offer.match(/<div class="col-table col-table_3">[\s\S]*?<span class="table-list__counter">([\s\S]*?)<\/span>/i)?.[1]);
      const vendor = offer.match(/data-vendor="(\d+)"/i)?.[1];
      warehouses.push(cleanObject({
        available_quantity: amountAttr ? Number(amountAttr) : parseRussianNumber(amountText),
        minimum_order_quantity: minQtyAttr ? Number(minQtyAttr) : parseRussianNumber(minQtyText),
        lead_time: term || undefined,
        price_breaks: priceBreaks.length > 0 ? priceBreaks : undefined,
        vendor_id: vendor,
      }));
    }
    if (warehouses.length > 0) sections.push(cleanObject({ warehouse_group: title || undefined, warehouses }));
  }
  return cleanObject({
    price_from_rub: parseRussianNumber(priceFrom),
    warehouses: sections.length > 0 ? sections : undefined,
  });
}

async function fetchPromelecProductCard(html) {
  const card = parsePromelecProductCard(html);
  return card && card.warehouses
    ? { product_details: card }
    : {};
}

async function enrichCandidatesWithCards(distributor, candidates, limit, parseCard) {
  const enriched = [];
  for (const candidate of candidates.slice(0, Math.min(limit, 5))) {
    const url = candidate.product_url;
    if (!url) {
      enriched.push(candidate);
      continue;
    }
    try {
      const html = await fetchPublicCatalogHtml(distributor, url);
      const details = await parseCard(html);
      enriched.push(cleanObject({ ...candidate, ...details }));
    } catch {
      enriched.push(candidate);
    }
  }
  return enriched;
}

function parseElectronshikProductCard(html) {
  const offer = html.match(/<tr class="dms_offer[\s\S]*?<\/tr>/i)?.[0];
  if (!offer) return undefined;
  const quantity = parseRussianNumber(htmlText(offer.match(/<td class="offer-header-avail[^>]*>([\s\S]*?)<\/td>/i)?.[1]));
  const shipText = htmlText(offer.match(/<td class="offer-header-dt[^>]*>([\s\S]*?)<\/td>/i)?.[1]);
  const priceInteger = offer.match(/class='integer'>([^<]*)</i)?.[1];
  const priceFraction = offer.match(/class='fraction'>,([^<]*)</i)?.[1];
  const fromQty = offer.match(/от\s*([\d\s]+)\s*шт/i)?.[1];
  return cleanObject({
    available_quantity: quantity,
    lead_time: shipText && !/^[\s]*[—–-][\s]*$/.test(shipText) ? shipText : undefined,
    price_from_rub: priceInteger && priceFraction ? parseRussianNumber(`${priceInteger}.${priceFraction}`) : undefined,
    minimum_order_quantity: parseRussianNumber(fromQty),
  });
}

async function fetchElectronshikProductCard(html) {
  const card = parseElectronshikProductCard(html);
  return card ? { product_details: card } : {};
}

function elitanDatasheetUrls(value) {
  const paths = String(value ?? "")
    .split(/\s+/)
    .map((entry) => entry.split("~")[0])
    .filter(Boolean);
  return paths.length > 0 ? paths.slice(0, 5).map((path) => `https://www.elitan.ru/pdf/${path}`) : undefined;
}

function summarizeElitanItem(item) {
  const title = item?.partname_array?.[0] ?? item?.partname;
  const manufacturer = item?.namemfg ?? item?.partname_array?.[1];
  const batches = (item?.stock ?? []).slice(0, 10).map((stock) =>
    cleanObject({
      minimum_order: firstNumber(stock?.mincount ?? stock?.min_count),
      term_delay_days: firstNumber(stock?.term_delay),
      pack: firstNumber(stock?.pack),
    }),
  );
  const minimumOrder = batches
    .map((batch) => batch.minimum_order)
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b)[0];
  const minimumDelay = batches
    .map((batch) => batch.term_delay_days)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b)[0];
  const leadTime = Number.isFinite(minimumDelay)
    ? minimumDelay > 0
      ? `от ${minimumDelay} дн.`
      : "со склада"
    : undefined;
  const partnameFull = String(item?.partname_full ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+@/g, "@")
    .trim()
    .split(/[;,]/)[0].trim()
    || (item?.partname_array?.[0] && item?.partname_array?.[1]
      ? `${item.partname_array[0].replace(/<[^>]*>/g, "").trim()}@${item.partname_array[1].replace(/<[^>]*>/g, "").trim()}`
      : undefined);
  return cleanObject({
    distributor: displayDistributorName("Elitan"),
    title: htmlText(title),
    manufacturer: manufacturer || undefined,
    partname_full: partnameFull,
    housing: item?.housing || undefined,
    description: htmlText(item?.bignote) || undefined,
    quantity_available: firstNumber(item?.count_stock),
    minimum_order_quantity: minimumOrder,
    lead_time: leadTime,
    minimum_term_delay_days: firstNumber(item?.term_delay),
    min_price_rub: elitanRubPrice(item?.min_price),
    standard_pack: item?.normupakovka || undefined,
    stock_batches: batches.length > 0 ? batches : undefined,
    datasheet_urls: elitanDatasheetUrls(item?.datasheets),
    product_url: item?.Ntovara ? `https://www.elitan.ru/price/item${item.Ntovara}` : undefined,
  });
}

async function fetchElitanQuickPrice(partnameFull, quantity) {
  const cardUrl = new URL("https://www.elitan.ru/price/index_json.php");
  cardUrl.searchParams.set("seenform", "y");
  cardUrl.searchParams.set("t", String(Math.floor(Date.now() / 1000)));
  cardUrl.searchParams.set("find", partnameFull);
  cardUrl.searchParams.set("flag", "everywhere");
  cardUrl.searchParams.set("mfg", "all");
  cardUrl.searchParams.set("pr", "2");
  cardUrl.searchParams.set("script", "bignote");
  const json = await fetchPublicCatalogJson("Elitan", cardUrl);
  const item = json?.items?.data?.[0];
  if (!item) return undefined;
  const batches = parseElitanBatches(item?.stock, quantity);
  const quickest = batches[0];
  return cleanObject({
    min_price_rub: elitanRubPrice(item?.min_price),
    quickest_batch: quickest
      ? cleanObject({
          lead_time: quickest.lead_time,
          term_delay_days: quickest.term_delay_days,
          available_quantity: quickest.available_quantity,
          minimum_order_quantity: quickest.minimum_order_quantity,
          unit_price_rub_for_quantity: quickest.unit_price_rub_for_quantity,
          price_breaks: (quickest.price_breaks ?? []).slice(0, 6),
        })
      : undefined,
  });
}

async function fetchPublicCatalogJson(distributor, url, options = {}) {
  const previousRequest = publicCatalogLastRequestAt.get(distributor) ?? 0;
  const minInterval = distributor === "Elitan" ? 8000 : PUBLIC_CATALOG_MIN_INTERVAL_MS;
  const wait = Math.max(0, minInterval - (Date.now() - previousRequest));
  if (wait > 0) await sleep(wait);
  publicCatalogLastRequestAt.set(distributor, Date.now());

  const headers = {
    Accept: "application/json,text/plain",
    "Accept-Language": "ru-RU,ru;q=0.9",
    "User-Agent": "ElectronicsPartsMCP/2.0 (user-initiated single-query catalog search)",
    ...(options.body ? { "Content-Type": options.contentType ?? "application/x-www-form-urlencoded; charset=UTF-8" } : {}),
    ...(options.headers ?? {}),
  };
  if (distributor === "Elitan" && ELITAN_COOKIE) {
    headers.Cookie = ELITAN_COOKIE;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      body: options.body,
      signal: controller.signal,
    });
    if (response.status === 429) {
      throw new Error(`${label} limited the request (HTTP 429). No retry was attempted.`);
    }
    if (!response.ok) {
      throw new Error(`${label} public search returned HTTP ${response.status} for ${url}. No retry was attempted.`);
    }

    const maxBytes = options.maxBytes ?? PUBLIC_CATALOG_MAX_RESPONSE_BYTES;
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(`${label} search response exceeds the ${Math.round(maxBytes / 1024 / 1024)} MiB parsing limit.`);
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new Error(`${label} search response exceeds the ${Math.round(maxBytes / 1024 / 1024)} MiB parsing limit.`);
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      if (publicCatalogChallengeDetected(text)) {
        throw new Error(`${label} returned a CAPTCHA or access challenge. The MCP stopped without attempting to bypass it.`);
      }
      throw new Error(`${label} returned an invalid JSON response (${String(text).slice(0, 160).replace(/\s+/g, " ")}). No retry was attempted.`);
    }
    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${label} public search timed out after ${options.timeoutMs ?? REQUEST_TIMEOUT_MS} ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function elitanProductDetails(items) {
  const item = Array.isArray(items) ? items[0] : undefined;
  if (!item) return undefined;
  const batches = (item?.stock ?? []).slice(0, 15).map((stock) =>
    cleanObject({
      minimum_order: firstNumber(stock?.mincount ?? stock?.min_count),
      term_delay_days: firstNumber(stock?.term_delay),
      pack: firstNumber(stock?.pack),
      note: stock?.note || undefined,
    }),
  );
  return cleanObject({
    price_rub: firstNumber(item?.min_price),
    stock_batches: batches.length > 0 ? batches : undefined,
  });
}

function elitanRubPrice(value) {
  const match = String(value ?? "").replace(/['\s]/g, "").match(/\d+[.,]?\d*/);
  return match ? Number(match[0].replace(",", ".")) : undefined;
}

function parseElitanPrices(prices) {
  return String(prices ?? "")
    .split(";")
    .map((pair) => {
      const [price, count] = pair.split("-").map((part) => part.trim());
      return cleanObject({
        unit_price: elitanRubPrice(price),
        minimum_order: parseRussianNumber(count),
      });
    })
    .filter((breakLevel) => breakLevel.unit_price !== undefined);
}

function elitanUnitPriceForQuantity(priceBreaks, quantity) {
  const target = firstNumber(quantity) ?? 1;
  const eligible = priceBreaks.filter((level) => level.minimum_order !== undefined && level.minimum_order <= target);
  if (eligible.length === 0) return undefined;
  eligible.sort((a, b) => b.minimum_order - a.minimum_order);
  return eligible[0].unit_price;
}

function parseElitanBatches(stocks, quantity) {
  const batches = (Array.isArray(stocks) ? stocks : []).map((stock) => {
    const priceBreaks = parseElitanPrices(stock?.prices);
    return cleanObject({
      available_quantity: firstNumber(stock?.stock),
      lead_time: String(stock?.term_delay_string ?? "").trim() || undefined,
      term_delay_days: firstNumber(stock?.term_delay),
      minimum_order_quantity: firstNumber(stock?.min_count),
      pack_multiple: firstNumber(stock?.norm),
      risk_logistik_days: firstNumber(stock?.risk_logistik_delivery),
      risk_reserv_days: firstNumber(stock?.risk_reserv),
      note: stock?.note || undefined,
      unit_price_rub_for_quantity: elitanUnitPriceForQuantity(priceBreaks, quantity),
      price_breaks: priceBreaks,
    });
  });
  batches.sort((a, b) => {
    const delayA = Number.isFinite(a.term_delay_days) ? a.term_delay_days : Number.MAX_SAFE_INTEGER;
    const delayB = Number.isFinite(b.term_delay_days) ? b.term_delay_days : Number.MAX_SAFE_INTEGER;
    return delayA - delayB;
  });
  return batches;
}

function parseElitanAnalysis(json) {
  const data = json?.analysis?.[0]?.data;
  if (!data || typeof data !== "object") return undefined;
  return Object.values(data).map((row) =>
    cleanObject({
      source: row?.type || undefined,
      term: firstNumber(row?.term_delay) !== undefined
        ? (firstNumber(row?.term_delay) > 0 ? `от ${firstNumber(row?.term_delay)} дн.` : "сегодня")
        : undefined,
      quantity: parseRussianNumber(row?.stock),
      opt_quantity: parseRussianNumber(row?.normupakovka),
      opt_price: elitanRubPrice(row?.price),
      is_min_price: row?.min_price === 1 || undefined,
    }),
  );
}

async function elitanCardDetails(partnameFull, quantity) {
  const time = String(Math.floor(Date.now() / 1000));
  const cardUrl = new URL("https://www.elitan.ru/price/index_json.php");
  cardUrl.searchParams.set("seenform", "y");
  cardUrl.searchParams.set("t", time);
  cardUrl.searchParams.set("find", partnameFull);
  cardUrl.searchParams.set("flag", "everywhere");
  cardUrl.searchParams.set("mfg", "all");
  cardUrl.searchParams.set("pr", "2");
  cardUrl.searchParams.set("script", "bignote");
  const json = await fetchPublicCatalogJson("Elitan", cardUrl);
  const item = json?.items?.data?.[0];
  if (!item) throw new Error("Elitan card endpoint returned no item for the given partname_full.");

  const analysisUrl = new URL("https://www.elitan.ru/ajax/get_analysis_json");
  analysisUrl.searchParams.set("partname", partnameFull);
  let analysis;
  try {
    analysis = await fetchPublicCatalogJson("Elitan", analysisUrl);
  } catch {
    analysis = undefined;
  }

  return cleanObject({
    title: String(item?.partname_array?.[0] ?? item?.partname).replace(/<[^>]*>/g, "").trim(),
    partname_full: String(item?.partname_full ?? partnameFull).replace(/<[^>]*>/g, "").replace(/\s+@/g, "@").trim(),
    brand: item?.namemfg || undefined,
    housing: item?.housing || undefined,
    description: htmlText(item?.big2 || item?.bignote) || undefined,
    low_price_rub: firstNumber(item?.min_price),
    available_quantity: firstNumber(item?.count_stock),
    nds_percent: firstNumber(json?.nds_percent),
    datasheet_urls: elitanDatasheetUrls(item?.datasheets),
    market_analysis: parseElitanAnalysis(analysis),
    batches: parseElitanBatches(item?.stock, quantity),
  });
}

async function searchElitanPublic(input) {
  const limit = Math.min(10, input.limit ?? 10);
  const url = new URL("https://www.elitan.ru/price/index_json.php");
  url.searchParams.set("t", String(Math.floor(Date.now() / 1000)));
  url.searchParams.set("find", input.query.toUpperCase().replace(",", ".").replace("\\", "/"));
  url.searchParams.set("delay", "");
  url.searchParams.set("mfg", "");
  url.searchParams.set("bignotesearch", "");
  url.searchParams.set("group", "");
  url.searchParams.set("seenform", "y");

  const json = await fetchPublicCatalogJson("Elitan", url);
  let items = Array.isArray(json?.items?.data) ? json.items.data : [];
  let candidates = items.slice(0, limit).map(summarizeElitanItem);
  let cardDetails;
  let quickPrice;
  let extraRequests = 0;
  if (items.length > 0) {
    const firstItem = items[0];
    const partnameFull = String(firstItem?.partname_full ?? firstItem?.partname ?? "")
      .replace(/<[^>]*>/g, "")
      .replace(/\s+@/g, "@")
      .trim()
      .split(/[;,]/)[0].trim();
    if (input.include_product_details === true) {
      try {
        cardDetails = await elitanCardDetails(partnameFull, input.quantity ?? 3);
        extraRequests += 2;
      } catch {
        cardDetails = undefined;
      }
    } else {
      try {
        quickPrice = await fetchElitanQuickPrice(partnameFull, input.quantity ?? 3);
        extraRequests += 1;
      } catch {
        quickPrice = undefined;
      }
    }
  }
  if (candidates.length > 0) {
    if (quickPrice) {
      candidates[0] = { ...candidates[0], ...quickPrice };
    } else if (cardDetails) {
      candidates[0] = { ...candidates[0], min_price_rub: cardDetails.low_price_rub };
    }
    const quickest = candidates[0].quickest_batch;
    const firstBreak = quickest?.price_breaks?.[0];
    if (candidates[0].min_price_rub === undefined && firstBreak?.unit_price !== undefined) {
      candidates[0].min_price_rub = firstBreak.unit_price;
    }
    if (firstBreak?.unit_price !== undefined) {
      candidates[0].price_rub = firstBreak.unit_price;
      candidates[0].lead_time = quickest?.lead_time ?? candidates[0].lead_time;
    }
  }
  const productDetails = input.include_product_details === true && items.length > 0
    ? elitanProductDetails(items)
    : undefined;
  return {
    distributor: displayDistributorName("Elitan"),
    source: ELITAN_COOKIE
      ? "User-authorized search JSON and card JSON endpoints with a browser session cookie (ELITAN_COOKIE), not a supplier API"
      : "User-authorized public search JSON and card JSON endpoints, not a supplier API",
    query: input.query,
    source_url: url.toString(),
    result_summary: {
      total_matches: json?.count_search,
      returned: candidates.length,
      request_count: 1 + extraRequests,
      authenticated: Boolean(ELITAN_COOKIE),
    },
    notice: ELITAN_COOKIE
      ? "Requests carry the ELITAN_COOKIE session. Without it, exact batches, prices, and discounts are hidden behind login; with it, the search page returns personalized data. min_price_rub of every candidate comes from the search JSON; for the first candidate the price breaks of the quickest batch are fetched automatically (one extra request). Full cards are fetched only when include_product_details is true."
      : "No ELITAN_COOKIE session: exact batches, prices, and discounts are hidden behind login. To get them, log in at elitan.ru, copy the session cookie, and set ELITAN_COOKIE. min_price_rub comes from the search JSON when available; full cards are fetched only when include_product_details is true.",
    product_details: productDetails,
    card_details: cardDetails,
    candidates,
  };
}

function parseBerelcomResults(html, limit) {
  const results = [];
  const cardStarts = [...html.matchAll(/<div class="product-card"/gi)].map((match) => match.index);
  for (let index = 0; index < cardStarts.length && results.length < limit; index += 1) {
    const card = html.slice(cardStarts[index], cardStarts[index + 1] ?? html.length);
    const title = htmlText(
      card.match(/<p class="product__title">\s*<a\b[^>]*itemprop="name"[^>]*>([\s\S]*?)<\/a>/i)?.[1],
    );
    const productUrl = absoluteUrl(
      "https://shop.berelcom.ru",
      card.match(/<a\b[^>]*href="([^"]*\/product\/[^"]*)"[^>]*itemprop="name"/i)?.[1],
    );
    if (!title || !productUrl) continue;

    const descBlock = card.match(/<p class="product__desc"[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "";
    const quantityText = descBlock.match(/Доступно\s*(?:&nbsp;|&#160;|\s)*([\d\s]+)\s*шт/i)?.[1];
    const leadTime = htmlText(descBlock.match(/Комплектация:[^<]*/i)?.[0] ?? "").replace(/^Комплектация:\s*/i, "");
    const manufacturer = htmlText(descBlock.match(/Производитель:[^<]*/i)?.[0] ?? "").replace(/^Производитель:\s*/i, "");

    const price = card.match(/<meta itemprop="price" content="([\d.]+)"/i)?.[1];
    const priceBreaks = [];
    for (const breakMatch of card.matchAll(/<p class="product__price price-for-product-list[^"]*"[^>]*>([\s\S]*?)<\/p>/gi)) {
      const block = htmlText(breakMatch[1]);
      const unitPrice = block.match(/([\d.,]+)\s*(?:р\.|₽|руб)/)?.[1] ?? block.match(/([\d.,]+)/)?.[1];
      const breakQuantity = block.match(/от\s*([\d\s]+)\s*шт/i)?.[1];
      priceBreaks.push(cleanObject({
        break_quantity: parseRussianNumber(breakQuantity),
        unit_price: parseRussianNumber(unitPrice),
      }));
    }

    const minimumOrderQuantity = priceBreaks
      .map((level) => level.break_quantity)
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((a, b) => a - b)[0];

    results.push(cleanObject({
      distributor: displayDistributorName("Berelcom"),
      title,
      manufacturer: manufacturer || undefined,
      description: htmlText(descBlock) || undefined,
      available_quantity: parseRussianNumber(quantityText),
      minimum_order_quantity: minimumOrderQuantity,
      lead_time: leadTime || undefined,
      price_rub: parseRussianNumber(price),
      price_breaks: priceBreaks.length > 0 ? priceBreaks : undefined,
      product_url: productUrl,
    }));
  }
  return results;
}

async function searchBerelcomPublic(input) {
  const limit = Math.min(10, input.limit ?? 10);
  const url = new URL("https://shop.berelcom.ru/find/");
  url.searchParams.set("search", input.query);
  url.searchParams.set("type", "0");
  const html = await fetchPublicCatalogHtml("Berelcom", url);
  const candidates = parseBerelcomResults(html, limit);
  return {
    distributor: displayDistributorName("Berelcom"),
    source: "User-authorized public HTML search, not a supplier API",
    query: input.query,
    source_url: url.toString(),
    result_summary: { returned: candidates.length, request_count: 1 },
    notice: "One search page was requested. Product pages are not fetched; 'Доступно' is the quantity shown on the search page and may differ from the final warehouse stock.",
    candidates,
  };
}

function parseBerelcomMap(html) {
  const sections = [];
  const seen = new Set();
  const add = (level, href, name) => {
    const ids = href?.match(/^\/catalog\/(\d+)(?:\/(\d+)(?:\/(\d+))?)?\/?$/i);
    const id = ids ? ids.slice(1).filter(Boolean).join("/") : undefined;
    if (!id || seen.has(id)) return;
    seen.add(id);
    sections.push(cleanObject({
      id,
      level,
      name: htmlText(name) || undefined,
      url: absoluteUrl("https://shop.berelcom.ru", href),
    }));
  };
  for (const match of html.matchAll(/<div class="catalog-list">\s*<p class="catalog-list__head">\s*<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    add(1, match[1], match[2]);
  }
  for (const match of html.matchAll(/<li>\s*<a\b[^>]*href="(\/catalog\/\d+\/\d+\/)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    add(2, match[1], match[2]);
  }
  for (const match of html.matchAll(/<li data-action="accordion">\s*<a\b[^>]*href="(\/catalog\/\d+\/\d+\/\d+\/)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    add(3, match[1], match[2]);
  }
  return sections;
}

function stemRussianWord(word) {
  return String(word).replace(/(?:овый|евый|ая|ое|ые|ие|ый|ий|ой|ей|ов|ев|а|я|ы|и|о|е|у|ю|ь)$/u, "");
}

function resolveBerelcomSection(sections, text) {
  if (!text) return undefined;
  const path = String(text).trim().split(/[?#]/)[0];
  const urlId = path.match(/^https?:\/\/shop\.berelcom\.ru\/catalog\/(\d+(?:\/\d+){0,2})\/?$/i)?.[1]
    ?? path.match(/^\/?catalog\/(\d+(?:\/\d+){0,2})\/?$/i)?.[1]
    ?? path.match(/^(\d+(?:\/\d+){0,2})$/)?.[1];
  if (urlId) {
    return sections.find((entry) => entry.id === urlId)
      ?? { id: urlId, level: urlId.split("/").length, url: `https://shop.berelcom.ru/catalog/${urlId}/` };
  }
  const normalized = normalizeCategoryText(path);
  if (!normalized) return undefined;
  const exactName = sections.find((entry) => normalizeCategoryText(entry.name) === normalized);
  if (exactName) return exactName;
  const inputWords = normalized.split(" ").filter((word) => word.length >= 3);
  if (inputWords.length === 0) return undefined;
  const stemsMatch = (inputWord, nameWord) => {
    const inputStem = stemRussianWord(inputWord);
    const nameStem = stemRussianWord(nameWord);
    return nameStem === inputStem || nameStem.includes(inputStem) || (inputStem.includes(nameStem) && inputStem.length >= 4);
  };
  const scored = sections.map((entry) => {
    const nameWords = normalizeCategoryText(entry.name).split(" ").filter((word) => word.length >= 3);
    return {
      entry,
      nameWords,
      matchedWords: inputWords.filter((inputWord) => nameWords.some((nameWord) => stemsMatch(inputWord, nameWord))),
    };
  });
  const matchCounts = new Map();
  for (const { matchedWords } of scored) {
    for (const word of matchedWords) matchCounts.set(word, (matchCounts.get(word) ?? 0) + 1);
  }
  const positionWeight = (word, index) => (/^\d+$/.test(word) ? 1 : index === 0 ? 1 : index === 1 ? 0.4 : 0.3);
  const byId = new Map(sections.map((entry) => [entry.id, entry]));
  const ranked = scored
    .map(({ entry, nameWords, matchedWords }) => {
      let score = 0;
      for (const inputWord of matchedWords) {
        const inputStem = stemRussianWord(inputWord);
        for (const nameWord of nameWords) {
          const nameStem = stemRussianWord(nameWord);
          if (stemsMatch(inputWord, nameWord)) {
            const containmentFactor = nameStem === inputStem || (inputStem.includes(nameStem) && inputStem.length >= 4)
              ? 1
              : 0.5 * Math.min(1, inputStem.length / nameStem.length);
            score += (nameWord.length * positionWeight(inputWord, inputWords.indexOf(inputWord)) * containmentFactor) / (matchCounts.get(inputWord) ?? 1);
          }
        }
      }
      const parentId = entry.id.includes("/") ? entry.id.split("/").slice(0, -1).join("/") : undefined;
      const parent = parentId ? byId.get(parentId) : undefined;
      let parentBonus = 0;
      if (parent) {
        const parentNameWords = normalizeCategoryText(parent.name).split(" ").filter((word) => word.length >= 3);
        for (const inputWord of inputWords) {
          if (parentNameWords.some((nameWord) => stemsMatch(inputWord, nameWord))) {
            const parentMatchLength = parentNameWords.reduce(
              (sum, nameWord) => (stemsMatch(inputWord, nameWord) ? sum + nameWord.length : sum),
              0,
            );
            parentBonus += (parentMatchLength * positionWeight(inputWord, inputWords.indexOf(inputWord)) * 0.5) / (matchCounts.get(inputWord) ?? 1);
          }
        }
      }
      return { entry, nameWords, matchedWords, parentBonus, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score
        || b.matchedWords.length - a.matchedWords.length
        || a.nameWords.length - b.nameWords.length
        || b.parentBonus - a.parentBonus
        || b.entry.level - a.entry.level
        || a.entry.id.length - b.entry.id.length,
    );
  return ranked[0]?.entry;
}

const BERELCOM_UNIT_EN_RU = {
  mkf: "мкФ", nf: "нФ", pf: "пФ", kf: "кФ", mf: "мФ",
  kohm: "кОм", mohm: "МОм", ohm: "Ом",
  mhz: "МГц", khz: "кГц", ghz: "ГГц", hz: "Гц",
  kv: "кВ", mv: "мВ", v: "В",
  ua: "мкА", ma: "мА", a: "А",
  mw: "мВт", w: "Вт",
  uh: "мкГн", mh: "мГн",
  us: "мкс", ms: "мс",
};

const BERELCOM_UNIT_RU_EN = {
  мкф: "mkF", нф: "nF", пф: "pF", кф: "kF", мф: "mF",
  ком: "kOhm", мом: "mOhm", ом: "Ohm",
  мгц: "MHz", кгц: "kHz", ггц: "GHz", гц: "Hz",
  кв: "kV", мв: "mV", в: "V",
  мка: "uA", ма: "mA", а: "A",
  мвт: "mW", вт: "W",
  мкгн: "uH", мгн: "mH",
  мкс: "us", мс: "ms",
};

function berelcomUnitAliases(text) {
  const enToRu = String(text).replace(
    /(\d[\d.,]*)\s*(mkf|kohm|mohm|ohm|mhz|khz|ghz|hz|kv|mv|v|ua|ma|a|mw|w|uh|mh|us|ms|nf|pf|kf|mf)(?![a-z0-9])/gi,
    (match, number, unit) => `${number}${BERELCOM_UNIT_EN_RU[unit.toLowerCase()] ?? unit}`,
  );
  const ruToEn = String(text).replace(
    /(\d[\d.,]*)\s*(мкф|нф|пф|кф|мф|ком|мом|ом|мгц|кгц|ггц|гц|кв|мв|в|мка|ма|а|мвт|вт|мкгн|мгн|мкс|мс)(?![а-яёa-z0-9])/gi,
    (match, number, unit) => `${number}${BERELCOM_UNIT_RU_EN[unit.toLowerCase()] ?? unit}`,
  );
  return [enToRu, ruToEn];
}

function berelcomSearchText(candidate) {
  const base = JSON.stringify(cleanObject({ ...candidate, _search_text: undefined }));
  return [base, ...berelcomUnitAliases(base)].join(" ");
}

async function searchBerelcomParametric(input) {
  const limit = Math.min(10, input.limit ?? 10);
  const maxPages = 3;
  const pageStart = Math.max(1, input.page ?? 1);
  let requestCount = 0;
  let sections = [];

  const fetchMap = async () => {
    if (sections.length === 0) {
      const mapHtml = await fetchPublicCatalogHtml("Berelcom", "https://shop.berelcom.ru/map/");
      requestCount++;
      sections = parseBerelcomMap(mapHtml);
    }
  };

  let section;
  if (input.category) {
    section = resolveBerelcomSection([], input.category);
  }
  if (!section && input.component_type) {
    await fetchMap();
    section = resolveBerelcomSection(sections, input.component_type);
  }
  if (!section) {
    await fetchMap();
    return cleanObject({
      distributor: displayDistributorName("Berelcom"),
      source: "User-authorized public HTML catalog map (https://shop.berelcom.ru/map/)",
      notice: `Категория не распознана по описанию${input.component_type ? ` «${input.component_type}»` : ""}. Укажите явный category (ID или URL раздела, например «3300000/3301000») или описание, например «керамический конденсатор 0805», «чип резистор 0603», «полевой транзистор MOSFET». Доступные разделы первого уровня ниже.`,
      available_sections: sections.filter((entry) => entry.level === 1).map((entry) => cleanObject({ id: entry.id, name: entry.name, url: entry.url })),
      result_summary: { returned: 0, request_count: requestCount },
    });
  }

  const baseUrl = new URL(section.url);
  baseUrl.searchParams.set("count", "100");
  const parts = [];
  let lastPage = 1;
  let pagesFetched = 0;
  for (let page = pageStart; page <= pageStart + maxPages - 1 && page <= lastPage; page += 1) {
    const target = new URL(baseUrl);
    if (page > 1) target.searchParams.set("page", String(page));
    const html = await fetchPublicCatalogHtml("Berelcom", target);
    requestCount++;
    pagesFetched += 1;
    const pageParts = parseBerelcomResults(html, 1000).map((candidate) => ({
      ...candidate,
      quantity_available: candidate.available_quantity,
    }));
    parts.push(...pageParts);
    lastPage = Math.max(lastPage, ...[...html.matchAll(/[?&]page=(\d+)/g)].map((match) => Number(match[1])));
    if (pageParts.length === 0) break;
  }

  const selected = selectComponents({
    distributorName: displayDistributorName("Berelcom"),
    query: input.component_type ?? input.category ?? section.url,
    parts: parts.map((candidate) => ({
      ...candidate,
      distributor_part_number: candidate.product_url,
      _search_text: berelcomSearchText(candidate),
    })),
    filters: input.filters,
    manufacturer: input.manufacturer,
    quantity: input.quantity,
    inStockOnly: input.in_stock_only,
    rohsOnly: input.rohs_only,
    limit,
    total: parts.length,
  });

  return cleanObject({
    ...selected,
    note: undefined,
    source: "User-authorized public HTML catalog section, filtered locally (the site has no parametric search)",
    category: input.category,
    category_name: section.name,
    category_url: section.url,
    result_summary: cleanObject({
      ...(selected.result_summary ?? {}),
      category_total: parts.length,
      pages_fetched: pagesFetched,
      request_count: requestCount,
    }),
    notice: "Фильтрация локальная по тексту названий и описаний карточек раздела (на сайте параметрического поиска нет). Единицы сопоставляются в русском и английском написании (мкФ/mkF, В/V, кОм/kOhm и т.п.); сопоставление по подстроке, числовые значения могут совпадать частично («0.1 мкФ» содержит «1 мкФ»). «Доступно» — остаток, показанный в разделе; RoHS определяется по тексту карточки; при отсутствии строгих совпадений возвращаются ранжированные кандидаты с unmet_requirements.",
    candidates: selected.candidates.map(({ distributor_part_number, ...candidate }) => ({
      ...candidate,
      matched_filters: cleanObject(Object.fromEntries(
        Object.entries(candidate.matched_filters ?? {}).map(([name, value]) => [
          name,
          String(value).length > 160 ? `${String(value).slice(0, 160)}…` : value,
        ]),
      )),
    })),
  });
}

function parseElectronshikResults(html, limit) {
  const results = [];
  const rows = html.matchAll(/<tr\b[^>]*class="product-row"[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const rowMatch of rows) {
    if (results.length >= limit) break;
    const row = rowMatch[1];
    const nameCellTag = row.match(/<td\b[^>]*class="product-row-name-cell"[^>]*>/i)?.[0] ?? "";
    const nameCell = row.match(/<td\b[^>]*class="product-row-name-cell"[^>]*>([\s\S]*?)<\/td>/i)?.[1] ?? "";
    const title = htmlText(nameCell.match(/<a\b[^>]*class="part-name"[^>]*>([\s\S]*?)<\/a>/i)?.[1]);
    const productUrl = absoluteUrl(
      "https://www.electronshik.ru",
      nameCell.match(/<a\b[^>]*class="part-name"[^>]*href="([^"]*)"/i)?.[1],
    );
    if (!title || !productUrl) continue;

    const manufacturer = nameCellTag.match(/data-producer_code="([^"]*)"/i)?.[1]
      ?? htmlText(nameCell.match(/<span\b[^>]*class="part-producer"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "").replace(/^\(|\)$/g, "");
    const category = nameCellTag.match(/data-cat="([^"]*)"/i)?.[1];
    const priceFromAttr = nameCellTag.match(/data-price="([\d.]+)"/i)?.[1];

    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => match[1]);
    const quantityText = htmlText(cells[1] ?? "");
    const priceMarkup = htmlText(cells[2] ?? "");
    const priceInteger = priceMarkup.match(/class='integer'>([^<]*)</i)?.[1];
    const priceFraction = priceMarkup.match(/class='fraction'>,([^<]*)</i)?.[1];
    const leadTime = htmlText(cells[3] ?? "");
    const isDash = /^[\s]*[—–-][\s]*$/.test(leadTime);
    const priceNumber = parseRussianNumber(priceFromAttr)
      ?? parseRussianNumber(priceInteger && priceFraction ? `${priceInteger}.${priceFraction}` : undefined);

    results.push(cleanObject({
      distributor: displayDistributorName("Electronshik"),
      title,
      manufacturer: manufacturer || undefined,
      description: category || undefined,
      available_quantity: parseRussianNumber(quantityText),
      lead_time: isDash ? undefined : leadTime || undefined,
      price_rub: priceNumber > 0 ? priceNumber : undefined,
      product_url: productUrl,
    }));
  }
  return results;
}

async function searchElectronshikPublic(input) {
  const limit = Math.min(10, input.limit ?? 10);
  const url = new URL("https://www.electronshik.ru/search");
  url.searchParams.set("query", input.query);
  const html = await fetchPublicCatalogHtml("Electronshik", url);
  let candidates = parseElectronshikResults(html, limit);
  const total = html.match(/<div class="section-items-count">\s*Найдено:\s*(\d+)/i)?.[1];
  if (input.include_product_details === true && candidates.length > 0) {
    candidates = await enrichCandidatesWithCards("Electronshik", candidates, limit, fetchElectronshikProductCard);
  }
  return {
    distributor: displayDistributorName("Electronshik"),
    source: "User-authorized public HTML search and product cards, not a supplier API",
    query: input.query,
    source_url: url.toString(),
    result_summary: {
      total_matches: total ? Number(total) : undefined,
      returned: candidates.length,
      request_count: 1 + (input.include_product_details === true ? candidates.length : 0),
    },
    notice: "One search page was requested. Product cards are fetched only when include_product_details is true; availability and price may depend on the region and logged-in state.",
    candidates,
  };
}

function parsePlatanResults(html, limit) {
  const results = [];
  const starts = [...html.matchAll(/<tr\b(?=[^>]*class='border-bottom')[^>]*>/gi)]
    .map((match) => match.index)
    .filter((index) => index !== undefined);
  for (let index = 0; index < starts.length && results.length < limit; index += 1) {
    const row = html.slice(starts[index], starts[index + 1] ?? html.length);
    const product = row.match(/<a\b(?=[^>]*class='link')(?=[^>]*href='([^']*)')[^>]*>([\s\S]*?)<\/a>/i);
    const title = htmlText(product?.[2]);
    const productUrl = absoluteUrl("https://www.platan.ru", product?.[1]);
    if (!title || !productUrl) continue;

    const titleParts = title.split(",").map((part) => part.trim()).filter(Boolean);
    const name = titleParts[0];
    const description = titleParts.length > 1 ? titleParts.slice(1).join(", ") : undefined;
    const manufacturer = htmlText(
      row.match(/<small\b[^>]*class='text-muted'[^>]*>([\s\S]*?)<\/small>/i)?.[1],
    ) || undefined;
    const quantityText = row.match(/<span class="green"><b>([\d\s]+)\s*шт\.?<\/b>/i)?.[1];
    const availableDate = htmlText(row.match(/<span class="text-dotted">([^<]*)<\/span>/i)?.[1]);

    const priceBreaks = [];
    for (const breakMatch of row.matchAll(
      /<td class='font-weight-bold'>([\d.,]+)[\s\S]*?<\/td><td class='left-align pl-0'>от\s*([\d\s]+)\s*шт<\/td>/gi,
    )) {
      priceBreaks.push(cleanObject({
        unit_price: parseRussianNumber(breakMatch[1]),
        break_quantity: parseRussianNumber(breakMatch[2]),
      }));
    }
    const minOrder = parseRussianNumber(row.match(/name='minzakaz' value='(\d+)'/i)?.[1]);
    const inStockNow = /fa fa-check/i.test(row) || undefined;
    const datasheet = row.match(/href="(https:\/\/doc\.platan\.ru\/[^"]*\.pdf)"/i)?.[1];
    const itemId = row.match(/\/cgi-bin\/qwery\.pl\/id=(\d+)/i)?.[1];

    results.push(cleanObject({
      distributor: displayDistributorName("Platan"),
      title: name || title,
      manufacturer,
      description,
      available_quantity: parseRussianNumber(quantityText),
      minimum_order_quantity: minOrder,
      lead_time: inStockNow ? "со склада" : availableDate ? `поставка ${availableDate}` : undefined,
      in_stock_now: inStockNow,
      restock_date: availableDate || undefined,
      price_breaks: priceBreaks.length > 0 ? priceBreaks : undefined,
      datasheet_url: datasheet,
      item_id: itemId,
      product_url: productUrl,
    }));
  }
  return results;
}

async function searchPlatanPublic(input) {
  const limit = Math.min(10, input.limit ?? 10);
  const url = new URL("https://www.platan.ru/cgi-bin/qwery_i.pl");
  url.searchParams.set("code", input.query);
  const html = await fetchPublicCatalogHtml("Platan", url);
  const candidates = parsePlatanResults(html, limit);
  const total = html.match(/<h1[^>]*>[\s\S]*?<sub>(\d+)<\/sub>/i)?.[1];
  return {
    distributor: displayDistributorName("Platan"),
    source: "User-authorized public HTML search, not a supplier API",
    query: input.query,
    source_url: url.toString(),
    result_summary: {
      total_matches: total ? Number(total) : undefined,
      returned: candidates.length,
      request_count: 1,
    },
    notice: "One search page was requested. Product pages are not fetched; the page is served in windows-1251 and availability depends on the region.",
    candidates,
  };
}

// ---------------------------------------------------------------------------
// Parametric (by-parameters) search. These tools run ONLY when explicitly
// requested: they are never called by the unified search.
// ---------------------------------------------------------------------------

const ELITAN_PARAM_FILTER_TITLES = {
  body_type: "Типогабарит корпуса",
  resistance: "Сопротивление",
  tolerance: "Отклонение",
  tkr: "ТКС",
  mfg: "Изготовитель",
  term_delay: "Макс. срок отгрузки",
  capacity: "Ёмкость",
  voltage: "Напряжение",
  esr: "ESR",
  power: "Мощность",
  t_min: "Температура мин.",
  t_max: "Температура макс.",
  x: "Размер X",
  y: "Размер Y",
  purpose: "Назначение",
  frequency: "Частота",
  type: "Тип",
  pins_type: "Тип выводов",
  pins_count: "Количество выводов",
  impedance: "Импеданс",
  current: "Ток",
  output_distance: "Расстояние между выводами",
  ansi: "Тип по ANSI",
  old_iec: "Тип по IEC",
  noise_level: "Уровень шума",
  material_color: "Материал/цвет",
  material_type: "Тип материала",
};

const PARAMETRIC_CATEGORIES = {
  elitan: [
    { key: "smres", title: "Чип резисторы (SMD)", keywords: ["чип резистор", "chip resistor", "резистор smd", "резистор 0402", "резистор 0603", "резистор 0805", "резистор 1206", "резистор 1210", "резистор 2512", "smd резистор"] },
    { key: "rescf", title: "Резисторы углеродистые плёночные", keywords: ["резистор углеродистый", "резистор плёночный", "carbon film"] },
    { key: "resmof", title: "Резисторы металлооксидные", keywords: ["резистор металлооксидный", "metal oxide"] },
    { key: "resmf", title: "Резисторы металлоплёночные", keywords: ["резистор металлоплёночный", "metal film"] },
    { key: "resw", title: "Резисторы проволочные", keywords: ["резистор проволочный", "wirewound"] },
    { key: "resc", title: "Резисторы (прочие)", keywords: ["резистор"] },
    { key: "smccap", title: "Чип конденсаторы керамические", keywords: ["керамический конденсатор", "mlcc", "чип конденсатор", "конденсатор smd", "chip capacitor", "конденсатор керамический"] },
    { key: "smtcap", title: "Чип конденсаторы танталовые", keywords: ["танталовый конденсатор", "tantalum capacitor", "тантал"] },
    { key: "smacap", title: "Чип конденсаторы алюминиевые", keywords: ["алюминиевый конденсатор", "электролитический конденсатор smd", "electrolytic smd"] },
    { key: "acapr", title: "Конденсаторы алюминиевые радиальные", keywords: ["алюминиевый конденсатор выводной", "электролитический конденсатор"] },
    { key: "acapa", title: "Конденсаторы алюминиевые аксиальные", keywords: ["аксиальный конденсатор"] },
    { key: "acaps", title: "Конденсаторы алюминиевые (прочие)", keywords: [] },
    { key: "acapi", title: "Конденсаторы алюминиевые импортные", keywords: [] },
    { key: "ccapr", title: "Конденсаторы керамические радиальные", keywords: ["керамический конденсатор выводной"] },
    { key: "ccapd", title: "Конденсаторы керамические дисковые", keywords: ["керамический дисковый конденсатор", "дисковый конденсатор"] },
    { key: "tcapr", title: "Конденсаторы танталовые выводные", keywords: ["танталовый конденсатор выводной"] },
    { key: "pcapr", title: "Конденсаторы полимерные", keywords: ["полимерный конденсатор", "polymer capacitor"] },
    { key: "qrz", title: "Кварцевые резонаторы", keywords: ["кварцевый резонатор", "quartz resonator", "кварц"] },
    { key: "fan", title: "Вентиляторы", keywords: ["вентилятор", "fan"] },
    { key: "smbead", title: "Ферритовые бусины (SMD)", keywords: ["ферритовая бусина", "ferrite bead", "феррит", "ферритовый фильтр"] },
    { key: "connector", title: "Разъёмы", keywords: ["разъем", "разъём", "connector"] },
    { key: "hst", title: "Термоусадочные трубки", keywords: ["термоусадка", "термоусадочная трубка", "heat shrink"] },
    { key: "fuse", title: "Предохранители", keywords: ["предохранитель", "fuse"] },
    { key: "led", title: "Светодиоды", keywords: ["светодиод", "led"] },
    { key: "solder", title: "Припой", keywords: ["припой", "solder"] },
  ],
  chipdip: [
    { key: "chip-rezistory-smd-dlya-poverhnostnogo-montazha-1672", title: "Чип резисторы (SMD)", keywords: ["чип резистор", "chip resistor", "резистор smd", "резистор 0402", "резистор 0603", "резистор 0805", "резистор 1206", "резистор 1210", "резистор 2512", "smd резистор"] },
    { key: "kondensatory-keramicheskie-smd-dlya-poverhnostnogo-montazha-1876", title: "Конденсаторы керамические SMD", keywords: ["керамический конденсатор", "mlcc", "чип конденсатор", "конденсатор smd", "chip capacitor", "конденсатор керамический"] },
    { key: "kondensatory-elektroliticheskie-smd-dlya-poverhnostnogo-montazha-1640", title: "Конденсаторы электролитические SMD", keywords: ["электролитический конденсатор smd", "электролит smd", "electrolytic smd"] },
    { key: "kondensatory-elektroliticheskie-tantalovye-1641", title: "Конденсаторы танталовые", keywords: ["танталовый конденсатор", "tantalum", "тантал"] },
    { key: "induktivnosti-smd-dlya-poverhnostnogo-montazha-1717", title: "Индуктивности SMD", keywords: ["индуктивность smd", "индуктивность 0603", "индуктивность 0805", "индуктивность 1206", "катушка индуктивности smd", "inductor"] },
    { key: "ionistory-superkondensatory-1620", title: "Ионисторы (суперконденсаторы)", keywords: ["ионистор", "суперконденсатор", "supercapacitor", "ionistor"] },
    { key: "tranzistory-polevye-fets-mosfets-1789", title: "Полевые транзисторы (FET, MOSFET)", keywords: ["полевой транзистор", "mosfet", "fet", "транзистор полевой", "n-канал", "p-канал"] },
    { key: "tranzistory-bipolyarnye-bjts-1788", title: "Биполярные транзисторы (BJT)", keywords: ["биполярный транзистор", "bjt", "транзистор биполярный"] },
    { key: "diody-shottki-1804", title: "Диоды Шоттки", keywords: ["диод шоттки", "шоттки", "schottky"] },
    { key: "diody-vypryamitelnye-2174", title: "Диоды выпрямительные", keywords: ["выпрямительный диод", "диод выпрямительный"] },
    { key: "stabilitrony-1810", title: "Стабилитроны", keywords: ["стабилитрон", "zener"] },
    { key: "chip-smd-predohraniteli-dlya-poverhnostnogo-montazha-2452", title: "Чип предохранители (SMD)", keywords: ["предохранитель smd", "чип предохранитель", "предохранитель чип"] },
    { key: "kvartsevye-rezonatory-1727", title: "Кварцевые резонаторы", keywords: ["кварцевый резонатор", "quartz resonator", "кварц"] },
    { key: "kvartsevye-generatory-1726", title: "Кварцевые генераторы", keywords: ["кварцевый генератор", "oscillator", "генератор кварцевый"] },
    { key: "varistory-1707", title: "Варисторы", keywords: ["варистор", "varistor"] },
    { key: "ntc-termistory-1709", title: "Термисторы NTC", keywords: ["термистор", "ntc", "thermistor"] },
    { key: "optopary-i-izolyatory-3174", title: "Оптопары и изоляторы", keywords: ["оптопара", "оптрон", "optocoupler", "изолятор цифровой"] },
  ],
  promelec: [
    { key: "6/79", title: "Постоянные резисторы", keywords: ["постоянный резистор", "чип резистор", "chip resistor", "резистор 0402", "резистор 0603", "резистор 0805", "резистор 1206", "резистор 2512"] },
    { key: "5/48", title: "Керамические конденсаторы", keywords: ["керамический конденсатор", "mlcc", "чип конденсатор", "конденсатор smd"] },
    { key: "5/46", title: "Электролитические конденсаторы", keywords: ["электролитический конденсатор", "электролит"] },
    { key: "5/47", title: "Танталовые конденсаторы", keywords: ["танталовый конденсатор", "tantalum", "тантал"] },
    { key: "5/51", title: "Суперконденсаторы", keywords: ["ионистор", "суперконденсатор", "supercapacitor"] },
    { key: "4/216", title: "Полевые транзисторы", keywords: ["полевой транзистор", "mosfet", "fet"] },
    { key: "4/216/230", title: "Одиночные MOSFET", keywords: ["одиночный mosfet", "mosfet smd"] },
    { key: "4/215", title: "Биполярные транзисторы", keywords: ["биполярный транзистор", "bjt"] },
    { key: "3/165", title: "Диоды Шоттки", keywords: ["диод шоттки", "шоттки", "schottky"] },
    { key: "3/1382", title: "Выпрямительные и импульсные диоды", keywords: ["выпрямительный диод", "диод выпрямительный"] },
    { key: "3/166", title: "Стабилитроны", keywords: ["стабилитрон", "zener"] },
    { key: "1856/247", title: "Дроссели, индуктивности", keywords: ["индуктивность", "дроссель", "inductor"] },
    { key: "409/454", title: "Кварцевые резонаторы", keywords: ["кварцевый резонатор", "quartz", "кварц"] },
    { key: "411/1313", title: "Предохранители", keywords: ["предохранитель", "fuse"] },
    { key: "411/1202", title: "Защитные диоды TVS и ESD", keywords: ["tvs", "esd", "защитный диод", "супрессор"] },
  ],
  electronshik: [
    { key: "rezistory-postoyannye", title: "Постоянные резисторы", keywords: ["постоянный резистор", "чип резистор", "chip resistor", "резистор 0402", "резистор 0603", "резистор 0805", "резистор 1206", "резистор 2512"] },
    { key: "kondensatory-keramicheskie", title: "Керамические конденсаторы", keywords: ["керамический конденсатор", "mlcc", "чип конденсатор", "конденсатор smd"] },
    { key: "kondensatory-elektroliticheskie-alyuminievye", title: "Электролитические алюминиевые конденсаторы", keywords: ["электролитический конденсатор", "алюминиевый конденсатор", "электролит"] },
    { key: "kondensatory-elektroliticheskie-tantalovye", title: "Танталовые конденсаторы", keywords: ["танталовый конденсатор", "tantalum", "тантал"] },
    { key: "polevye-tranzistory", title: "Полевые транзисторы", keywords: ["полевой транзистор", "mosfet", "fet"] },
    { key: "bipolyarnye-tranzistory", title: "Биполярные транзисторы", keywords: ["биполярный транзистор", "bjt"] },
    { key: "diody-vypryamitelnye", title: "Выпрямительные диоды", keywords: ["выпрямительный диод", "диод выпрямительный"] },
    { key: "diody-zashchitnye", title: "Защитные диоды (TVS)", keywords: ["tvs", "esd", "защитный диод", "супрессор"] },
    { key: "stabilitrony", title: "Стабилитроны", keywords: ["стабилитрон", "zener"] },
    { key: "drosseli", title: "Дроссели", keywords: ["дроссель", "индуктивность", "inductor"] },
    { key: "kvartsevye-rezonatory", title: "Кварцевые резонаторы", keywords: ["кварцевый резонатор", "quartz", "кварц"] },
    { key: "varistory", title: "Варисторы", keywords: ["варистор", "varistor"] },
    { key: "optopary", title: "Оптопары", keywords: ["оптопара", "оптрон", "optocoupler"] },
    { key: "predohraniteli-plavkie", title: "Плавкие предохранители", keywords: ["предохранитель", "fuse"] },
  ],
  platan: [
    { key: "10703", title: "Резисторы чип (SMD)", keywords: ["чип резистор", "chip resistor", "резистор smd", "резистор 0402", "резистор 0603", "резистор 0805", "резистор 1206", "резистор 2512"] },
    { key: "53936", title: "Резисторы выводные", keywords: ["резистор постоянный", "резистор выводной"] },
    { key: "11408", title: "Резисторы мощные", keywords: ["резистор мощный"] },
    { key: "872", title: "Резисторы прецизионные", keywords: ["резистор прецизионный"] },
    { key: "79433", title: "Резисторы токоизмерительные", keywords: ["резистор токоизмерительный", "шунт"] },
    { key: "10702", title: "Резисторы переменные", keywords: ["резистор переменный", "потенциометр"] },
    { key: "62240", title: "Резисторы подстроечные", keywords: ["резистор подстроечный"] },
    { key: "10701", title: "Резисторные сборки", keywords: ["резисторная сборка"] },
    { key: "10605", title: "Конденсаторы электролитические радиальные", keywords: ["конденсатор электролитический", "электролит радиальный", "electrolytic radial"] },
    { key: "200268", title: "Конденсаторы электролитические аксиальные", keywords: ["конденсатор электролитический аксиальный", "electrolytic axial"] },
    { key: "91549", title: "Конденсаторы электролитические SMD", keywords: ["конденсатор электролитический smd", "электролит smd", "electrolytic smd", "алюминиевый конденсатор smd"] },
    { key: "91083", title: "Конденсаторы керамические выводные", keywords: ["керамический конденсатор выводной"] },
    { key: "200006", title: "Конденсаторы керамические дисковые", keywords: ["керамический дисковый конденсатор", "дисковый конденсатор"] },
    { key: "200005", title: "Конденсаторы керамические высоковольтные", keywords: ["керамический высоковольтный конденсатор"] },
    { key: "10601", title: "Конденсаторы керамические ЧИП", keywords: ["керамический конденсатор", "mlcc", "чип конденсатор", "конденсатор smd", "chip capacitor", "конденсатор керамический"] },
    { key: "10607", title: "Конденсаторы танталовые", keywords: ["танталовый конденсатор", "tantalum", "тантал"] },
    { key: "200015", title: "Конденсаторы танталовые SMD", keywords: ["танталовый конденсатор smd", "tantalum smd", "тантал smd"] },
    { key: "77298", title: "Конденсаторы полимерные", keywords: ["полимерный конденсатор", "polymer capacitor"] },
    { key: "10602", title: "Конденсаторы плёночные", keywords: ["пленочный конденсатор", "film capacitor", "плёнчатый конденсатор"] },
    { key: "200002", title: "Конденсаторы снабберные", keywords: ["снабберный конденсатор", "snubber"] },
    { key: "10603", title: "Конденсаторы подстроечные", keywords: ["подстроечный конденсатор"] },
    { key: "10608", title: "Суперконденсаторы, ионисторы", keywords: ["ионистор", "суперконденсатор", "supercapacitor", "ionistor"] },
    { key: "10609", title: "Конденсаторы пусковые", keywords: ["пусковой конденсатор"] },
    { key: "31107", title: "Конденсаторы силовые", keywords: ["силовой конденсатор"] },
    { key: "13840", title: "Конденсаторы фазовые косинусные", keywords: ["фазовый конденсатор", "косинусный конденсатор"] },
    { key: "10604", title: "Конденсаторы разные", keywords: ["конденсатор"] },
    { key: "10663", title: "NTC термисторы", keywords: ["термистор", "ntc", "thermistor"] },
    { key: "312", title: "PTC термисторы, позисторы", keywords: ["позистор", "ptc термистор"] },
    { key: "32502", title: "Варисторы", keywords: ["варистор", "varistor"] },
    { key: "200148", title: "ЧИП SMD предохранители", keywords: ["предохранитель smd", "чип предохранитель"] },
    { key: "32505", title: "Самовосстанавливающиеся предохранители", keywords: ["самовосстанавливающийся предохранитель", "pptc", "resettable fuse"] },
    { key: "85192", title: "Вставки плавкие, предохранители", keywords: ["предохранитель", "fuse", "вставка плавкая"] },
    { key: "202", title: "Транзисторы биполярные", keywords: ["биполярный транзистор", "bjt", "транзистор биполярный"] },
    { key: "204", title: "Транзисторы полевые", keywords: ["полевой транзистор", "mosfet", "fet", "транзистор полевой", "n-канал", "p-канал"] },
    { key: "201", title: "IGBT транзисторы", keywords: ["igbt"] },
    { key: "401", title: "Диоды выпрямительные", keywords: ["выпрямительный диод", "диод выпрямительный"] },
    { key: "72852", title: "Диоды Шоттки", keywords: ["диод шоттки", "шоттки", "schottky"] },
    { key: "410", title: "Стабилитроны", keywords: ["стабилитрон", "zener"] },
    { key: "98634", title: "ESD защитные диоды", keywords: ["esd", "защитный диод", "супрессор", "tvs"] },
    { key: "21001", title: "Оптопары, оптроны импортные", keywords: ["оптопара", "оптрон", "optocoupler"] },
    { key: "10901", title: "SMD индуктивности", keywords: ["индуктивность smd", "индуктивность 0603", "индуктивность 0805", "индуктивность 1206", "катушка индуктивности smd", "inductor"] },
    { key: "73335", title: "Дроссели выводные", keywords: ["дроссель выводной"] },
    { key: "10801", title: "Кварцевые резонаторы", keywords: ["кварцевый резонатор", "quartz resonator", "кварц"] },
    { key: "10804", title: "Кварцевые генераторы", keywords: ["кварцевый генератор", "oscillator", "генератор кварцевый"] },
  ],
};

function normalizeCategoryText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/g, " ")
    .trim();
}

function resolveParametricCategory(distributor, text) {
  if (!text) return undefined;
  const registry = PARAMETRIC_CATEGORIES[distributor] ?? [];
  const trimmed = String(text).trim();
  const direct = registry.find((entry) =>
    entry.key === trimmed
    || trimmed.includes(`/${entry.key}/`)
    || trimmed.endsWith(entry.key)
    || trimmed === entry.title,
  );
  if (direct) return direct;
  const normalized = normalizeCategoryText(trimmed);
  if (!normalized) return undefined;
  const candidates = registry
    .map((entry) => {
      const score = (entry.keywords ?? []).reduce((sum, keyword) => {
        const kw = normalizeCategoryText(keyword);
        if (!kw) return sum;
        if (normalized.includes(kw) || (kw.includes(normalized) && normalized.length >= 4)) return sum + kw.length;
        return sum;
      }, 0);
      return { entry, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);
  return candidates[0]?.entry;
}

function parametricCategoryList(distributor) {
  return (PARAMETRIC_CATEGORIES[distributor] ?? []).map((entry) => ({ key: entry.key, title: entry.title }));
}

function parametricCategoryFallback(distributor, componentType) {
  const resolved = resolveParametricCategory(distributor, componentType);
  if (resolved) return resolved;
  return {
    distributor,
    source: "Parametric category registry of the MCP server (static list of known categories)",
    notice: "Категория не распознана по описанию. Укажите явный идентификатор или одно из описаний: например «чип резистор 0805», «керамический конденсатор SMD», «полевой транзистор MOSFET», «индуктивность SMD». Доступные категории ниже.",
    available_categories: parametricCategoryList(distributor),
  };
}

function parseElitanParamCategories(html) {
  const categories = [];
  for (const match of html.matchAll(/\/param\/cat\/([a-z0-9_]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const title = htmlText(match[2]);
    if (!title || categories.some((entry) => entry.code === match[1])) continue;
    categories.push({ code: match[1], title });
  }
  return categories.slice(0, 60);
}

function parseElitanFilterOptions(json) {
  const filters = [];
  for (const [name, optionsHtml] of Object.entries(json ?? {})) {
    if (typeof optionsHtml !== "string" || !optionsHtml.includes("<option")) continue;
    const options = [];
    for (const option of optionsHtml.matchAll(/<option value=([^>]*)>([\s\S]*?)<\/option>/gi)) {
      const label = htmlText(option[2]).replace(/\s*\(\d+\)\s*$/, "");
      const count = Number(option[2].match(/\((\d+)\)<\/span>/)?.[1]);
      const value = decodeHtml(option[1].replace(/^"|"$/g, "").trim());
      options.push(cleanObject({ value, label: label || value, count: count || undefined }));
    }
    if (options.length === 0) continue;
    filters.push({
      name,
      title: ELITAN_PARAM_FILTER_TITLES[name] ?? name,
      options: options.slice(0, 50),
    });
  }
  return filters;
}

function summarizeElitanParamItem(item) {
  const parameters = cleanObject({
    body_type: item?.body_type || undefined,
    resistance: item?.resistance || undefined,
    tolerance: item?.tolerance || undefined,
    tkr: item?.tkr || undefined,
    capacity: item?.capacity || undefined,
    voltage: item?.voltage || undefined,
    esr: item?.esr || undefined,
    power: item?.power || undefined,
    frequency: item?.frequency || undefined,
    current: item?.current || undefined,
    impedance: item?.impedance || undefined,
    pins_count: item?.pins_count || undefined,
    type: item?.type || undefined,
    material_type: item?.material_type || undefined,
  });
  const firstStock = item?.stock?.[0];
  const partnameFull = String(item?.partname_full ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+@/g, "@")
    .trim()
    .split(/[;,]/)[0].trim()
    || (item?.partname_array?.[0] && item?.partname_array?.[1]
      ? `${item.partname_array[0].replace(/<[^>]*>/g, "").trim()}@${item.partname_array[1].replace(/<[^>]*>/g, "").trim()}`
      : undefined);
  return cleanObject({
    distributor: displayDistributorName("Elitan"),
    title: htmlText(item?.partname_array?.[0] ?? item?.partname),
    manufacturer: item?.namemfg || item?.partname_array?.[1] || undefined,
    partname_full: partnameFull,
    housing: item?.housing || undefined,
    quantity_available: firstNumber(item?.count_stock),
    minimum_order_quantity: firstNumber(firstStock?.mincount ?? firstStock?.min_count),
    term_delay_days: firstNumber(item?.term_delay),
    min_price_rub: elitanRubPrice(item?.min_price),
    parameters: Object.keys(parameters).length > 0 ? parameters : undefined,
    product_url: item?.Ntovara ? `https://www.elitan.ru/price/item${item.Ntovara}` : undefined,
  });
}

async function fetchElitanGetdata(url) {
  const options = { maxBytes: 8 * 1024 * 1024, timeoutMs: 60000 };
  try {
    return await fetchPublicCatalogJson("Elitan", url, options);
  } catch (error) {
    const message = errorMessage(error);
    const recoverable = message.includes("invalid JSON") || message.includes("timed out") || message.includes("Fatal error");
    if (!recoverable) throw error;
    await sleep(8000);
    return await fetchPublicCatalogJson("Elitan", url, options);
  }
}

async function searchElitanParametric(input) {
  const limit = Math.min(10, input.limit ?? 10);
  let elType = input.el_type;
  if (!elType && input.component_type) {
    elType = resolveParametricCategory("elitan", input.component_type)?.key;
  }
  if (!elType) {
    return {
      distributor: displayDistributorName("Elitan"),
      source: "Parametric category registry of the MCP server (static list of known categories, https://www.elitan.ru/param/)",
      notice: "Укажите el_type (код категории) или component_type (например «чип резистор 0805», «керамический конденсатор SMD») и, при необходимости, filters. Доступные категории ниже.",
      categories: parametricCategoryList("elitan").map((entry) => ({ code: entry.key, title: entry.title })),
    };
  }
  const baseFilters = input.filters ?? {};
  const filteredEntries = Object.entries(baseFilters);
  if (filteredEntries.length === 0) {
    const json = await fetchPublicCatalogJson("Elitan", "https://www.elitan.ru/price/requests/get_data_list.php", {
      method: "POST",
      body: new URLSearchParams({ el_type: elType }).toString(),
    });
    return {
      distributor: displayDistributorName("Elitan"),
      source: "User-authorized public parametric filter list (get_data_list.php)",
      el_type: elType,
      notice: "Укажите filters — значения берите из списков ниже (поле value, НЕ подпись): например tolerance=F (это ±1%), resistance=4700.0000 (это 4.7кОм, Омы с точкой и 4 знаками), body_type=0805, term_delay — максимальный срок отгрузки в днях.",
      available_filters: parseElitanFilterOptions(json),
    };
  }
  let requestCount = 0;
  let quickPrice;

  const fetchFiltered = async (entries) => {
    const data = cleanObject({
      el_type: elType,
      order: input.order ?? "partname,asc",
      count_cur_val: String(input.count_cur_val ?? 100),
      ...Object.fromEntries(entries),
    });
    const url = new URL("https://www.elitan.ru/param/getdata");
    url.searchParams.set("t", String(Math.floor(Date.now() / 1000)));
    url.searchParams.set("data", JSON.stringify(data));
    const json = await fetchElitanGetdata(url);
    requestCount++;
    return { json, filters: Object.fromEntries(entries) };
  };

  const candidatesFrom = (json) => {
    const items = Array.isArray(json?.items?.data) ? json.items.data : [];
    return items.slice(0, limit).map(summarizeElitanParamItem);
  };

  const exact = await fetchFiltered(filteredEntries);
  const exactCandidates = candidatesFrom(exact.json);
  const isExactEmpty = exact.json?.count_search === 0 || exactCandidates.length === 0;
  if (!isExactEmpty) {
    const candidates = exactCandidates;
    if (candidates.length > 0 && candidates[0].partname_full) {
      try {
        quickPrice = await fetchElitanQuickPrice(candidates[0].partname_full, 3);
      } catch {
        quickPrice = undefined;
      }
      if (quickPrice) {
        candidates[0] = { ...candidates[0], ...quickPrice };
        const quickest = candidates[0].quickest_batch;
        const firstBreak = quickest?.price_breaks?.[0];
        if (candidates[0].min_price_rub === undefined && firstBreak?.unit_price !== undefined) {
          candidates[0].min_price_rub = firstBreak.unit_price;
        }
        if (firstBreak?.unit_price !== undefined) {
          candidates[0].price_rub = firstBreak.unit_price;
          candidates[0].lead_time = quickest?.lead_time ?? candidates[0].lead_time;
        }
      }
    }
    return {
      distributor: displayDistributorName("Elitan"),
      source: "User-authorized public parametric search JSON (/param/getdata) with the optional ELITAN_COOKIE session",
      el_type: elType,
      filters_applied: exact.filters,
      result_summary: {
        total_matches: exact.json?.count_search,
        returned: candidates.length,
        request_count: requestCount + (quickPrice ? 1 : 0),
        authenticated: Boolean(ELITAN_COOKIE),
      },
      notice: "Ответ /param/getdata может быть большим: сервер возвращает сотни позиций с подробными партиями; показаны только первые позиции в компактном виде. Значения фильтров — из списков (value), например tolerance=F (±1%), resistance=4700.0000 (4.7кОм). Для первого кандидата цена самой быстрой партии догружается автоматически (price_rub/quickest_batch, один дополнительный запрос). Если вернулось 0 позиций — проверьте точность значений фильтров через вызов без filters.",
      candidates,
    };
  }

  const exactFilters = Object.fromEntries(filteredEntries);
  const attempts = [];
  let relaxed;
  const maxAttempts = Math.min(filteredEntries.length - 1, 4);
  for (let keep = filteredEntries.length - 1; keep >= Math.max(1, filteredEntries.length - maxAttempts); keep--) {
    const subset = filteredEntries.slice(0, keep);
    const attempt = await fetchFiltered(subset);
    const attemptCandidates = candidatesFrom(attempt.json);
    attempts.push({ kept_filters: keep, total_matches: attempt.json?.count_search ?? 0 });
    if (attempt.json?.count_search !== 0 && attemptCandidates.length > 0) {
      relaxed = { json: attempt.json, filters: subset, candidates: attemptCandidates };
      break;
    }
  }

  const noticeParts = [
    `Точный поиск по ${filteredEntries.length} параметр(ам) (${Object.values(exactFilters).join(" + ")}) дал 0 вариантов.`,
  ];
  if (relaxed) {
    noticeParts.push(`Количество параметров уменьшено до ${relaxed.filters.length}: ${Object.values(relaxed.filters).join(" + ")}.`);
  } else {
    noticeParts.push("Поиск с меньшим количеством параметров тоже не дал результатов.");
  }

  return {
    distributor: displayDistributorName("Elitan"),
    source: "User-authorized public parametric search JSON (/param/getdata) with the optional ELITAN_COOKIE session",
    el_type: elType,
    exact_match: {
      total_matches: 0,
      filters: exactFilters,
      note: "Точная комбинация параметров не дала результатов; количество параметров уменьшено автоматически.",
    },
    applied_filters: relaxed ? Object.fromEntries(relaxed.filters) : {},
    dropped_filters: relaxed ? Object.fromEntries(filteredEntries.slice(relaxed.filters.length)) : exactFilters,
    attempts,
    result_summary: {
      total_matches: relaxed?.json?.count_search,
      returned: relaxed?.candidates.length ?? 0,
      request_count: requestCount,
      authenticated: Boolean(ELITAN_COOKIE),
    },
    notice: noticeParts.join(" "),
    candidates: relaxed?.candidates ?? [],
  };
}

function parseChipDipFilters(html, options = {}) {
  const maxValues = options.maxValues ?? 40;
  const maxFilters = options.maxFilters ?? 20;
  const filters = [];
  const starts = [...html.matchAll(/<div class="filter_selector[^"]*"[^>]*data-name="([^"]*)"[^>]*>/gi)]
    .map((match) => ({ name: match[1], index: match.index }));
  for (let index = 0; index < starts.length; index += 1) {
    const block = html.slice(starts[index].index, starts[index + 1]?.index ?? html.length);
    const name = starts[index].name;
    const title = htmlText(block.match(/<div class="filter_name[^"]*">([\s\S]*?)<\/div>/i)?.[1]) || name;
    const values = [];
    for (const checkbox of block.matchAll(/<input\b[^>]*type="checkbox"[^>]*name="([^"]*)"[^>]*value="([^"]*)"[^>]*class="[^"]*filter_control[^"]*"([^>]*)>/gi)) {
      if (checkbox[1] !== name) continue;
      const labelBlock = block.slice(checkbox.index, block.indexOf("</label>", checkbox.index));
      const label = htmlText(labelBlock.match(/class="l-name">([\s\S]*?)<\/span>/i)?.[1]);
      const count = Number(labelBlock.match(/<sub class="count">(\d+)<\/sub>/i)?.[1]);
      values.push(cleanObject({
        value: checkbox[2],
        label: label || checkbox[2],
        count: count || undefined,
        selected: /checked/i.test(checkbox[3]),
        disabled: /disabled/i.test(checkbox[3]),
      }));
    }
    if (values.length === 0) continue;
    filters.push(cleanObject({ name, title, values: values.slice(0, maxValues) }));
  }
  return filters.slice(0, maxFilters);
}

function parseCapacitancePf(value) {
  const match = String(value).replace(/\s/g, "").match(/^([\d.,]+)(мкф|нф|пф|uf|µf|nf|pf|ф|f)?$/i);
  if (!match) return null;
  const number = Number(match[1].replace(",", "."));
  if (!Number.isFinite(number)) return null;
  const unit = (match[2] ?? "пф").toLowerCase();
  const multipliers = { пф: 1, pf: 1, нф: 1e3, nf: 1e3, мкф: 1e6, uf: 1e6, "µf": 1e6, ф: 1e12, f: 1e12 };
  if (!(unit in multipliers)) return null;
  return number * multipliers[unit];
}

async function resolveChipDipFilterCodes(categoryPath, filters) {
  const rawKeys = new Set(["p.0", "moq", "locid", "rating"]);
  const needsResolution = Object.entries(filters).some(([name]) => !rawKeys.has(name) && !/^x\.\d+$/.test(name));
  if (!needsResolution) return { filters, resolved: undefined, discoveryUsed: false };
  const path = categoryPath.startsWith("/") ? categoryPath : `/catalog/${categoryPath}`;
  const html = await fetchPublicCatalogHtml("ChipDip", new URL(`https://www.chipdip.ru${path}`));
  const available = parseChipDipFilters(html, { maxValues: 500, maxFilters: 100 });
  const resolved = {};
  const mapping = {};
  for (const [name, value] of Object.entries(filters)) {
    const byName = available.find((entry) => entry.name === name);
    const byTitle = byName ?? available.find((entry) => {
      const filterTitle = normalizeCategoryText(entry.title);
      const requestedName = normalizeCategoryText(name);
      return filterTitle === requestedName || filterTitle.includes(requestedName) || requestedName.includes(filterTitle);
    });
    if (!byTitle) {
      resolved[name] = value;
      mapping[name] = { requested: value, note: "фильтр не найден на странице; передан как есть" };
      continue;
    }
    const byValue = byTitle.values.find((entry) => entry.value === value);
    const requestedPf = parseCapacitancePf(value);
    const strictMatch = (entry) => {
      const label = normalizeCategoryText(entry.label);
      const requestedValue = normalizeCategoryText(value);
      if (requestedPf !== null) {
        const labelPf = parseCapacitancePf(entry.label);
        if (labelPf !== null) return requestedPf === labelPf;
      }
      if (label === requestedValue) return true;
      const requestedNumber = parseRussianNumber(value);
      const labelNumber = parseRussianNumber(entry.label);
      if (requestedNumber !== undefined && labelNumber !== undefined && requestedNumber === labelNumber) return true;
      return false;
    };
    const byLabel = byValue ?? byTitle.values.find(strictMatch) ?? byTitle.values.find((entry) => {
      const label = normalizeCategoryText(entry.label);
      const requestedValue = normalizeCategoryText(value);
      const labelHasLetters = /[a-zа-я]/.test(label);
      const valueHasLetters = /[a-zа-я]/.test(requestedValue);
      if (labelHasLetters && valueHasLetters && (label.includes(requestedValue) || requestedValue.includes(label))) return true;
      const bareNumberPattern = (number) => `(^|\\D)${number.replace(".", "\\.")}(\\D|$)`;
      if (/^[\d.]+$/.test(requestedValue) && new RegExp(bareNumberPattern(requestedValue)).test(label)) return true;
      if (/^[\d.]+$/.test(label) && new RegExp(bareNumberPattern(label)).test(requestedValue)) return true;
      return false;
    });
    if (byLabel) {
      resolved[byTitle.name] = byLabel.value;
      mapping[byTitle.name] = {
        requested: value,
        title: byTitle.title,
        resolved_value: byLabel.value,
        resolved_label: byLabel.label,
      };
    } else {
      resolved[byTitle.name] = value;
      mapping[byTitle.name] = { requested: value, title: byTitle.title, note: "значение не найдено в списке фильтра; передано как есть" };
    }
  }
  return { filters: resolved, resolved: mapping, discoveryUsed: true };
}

async function searchChipDipParametric(input) {
  const limit = Math.min(10, input.limit ?? 10);
  let path = input.category;
  if (!path && input.component_type) {
    path = resolveParametricCategory("chipdip", input.component_type)?.key;
  }
  if (!path) return parametricCategoryFallback("chipdip", input.component_type);
  if (/\s|[а-яё]/i.test(path) && !/^https?:\/\//i.test(path)) {
    const resolved = resolveParametricCategory("chipdip", path);
    if (resolved) path = resolved.key;
  }
  if (/^https?:\/\//i.test(path)) {
    const parsed = new URL(path);
    if (parsed.hostname !== "www.chipdip.ru") {
      throw new Error("category must be a chipdip.ru catalog URL or a slug like ionistory-superkondensatory-1620.");
    }
    path = parsed.pathname;
  }
  if (!path.startsWith("/")) path = `/catalog/${path}`;
  const url = new URL(`https://www.chipdip.ru${path}`);
  let filters = input.filters ?? {};
  let resolvedFilters;
  if (Object.keys(filters).length > 0) {
    const resolution = await resolveChipDipFilterCodes(path, filters);
    filters = resolution.filters;
    resolvedFilters = resolution.resolved;
  }
  const filteredEntries = Object.entries(filters);
  let requestCount = resolvedFilters ? 1 : 0;

  const buildUrl = (entries) => {
    const built = new URL(`https://www.chipdip.ru${path}`);
    for (const [name, value] of entries) built.searchParams.set(name, value);
    if (input.page && input.page > 1) built.searchParams.set("page", String(input.page));
    return built;
  };
  const totalFromHtml = (html) => {
    const count = html.match(/<sub class="count[^"]*">\s*([\d\s]+)\s*из/i)?.[1];
    return count ? Number(count.replace(/\s/g, "")) : undefined;
  };
  const fetchFiltered = async (entries) => {
    const target = buildUrl(entries);
    try {
      const html = await fetchPublicCatalogHtml("ChipDip", target);
      requestCount++;
      return { html, url: target, total: totalFromHtml(html), candidates: parseChipDipResults(html, limit) };
    } catch (error) {
      if (error instanceof Error && /HTTP 404/.test(error.message)) {
        requestCount++;
        return { html: undefined, url: target, total: 0, candidates: [] };
      }
      throw error;
    }
  };

  if (filteredEntries.length === 0) {
    const html = await fetchPublicCatalogHtml("ChipDip", url);
    requestCount++;
    const availableFilters = parseChipDipFilters(html);
    const candidates = parseChipDipResults(html, limit);
    const count = totalFromHtml(html);
    return {
      distributor: displayDistributorName("ChipDip"),
      source: "User-authorized public parametric HTML page of the ChipDip catalog",
      category: input.category,
      category_url: url.toString(),
      result_summary: {
        category_total: count,
        returned: candidates.length,
        request_count: requestCount,
      },
      available_filters: availableFilters,
      notice: "p.0 — бренд, x.<id> — характеристики категории, moq — мин. количество заказа (1..5), locid — магазины. Фильтры можно задавать по названию и подписи: например {\"Ёмкость\": \"10 мкФ\"} или {\"Бренд\": \"Murata\"} — коды сайта подставятся автоматически (см. resolved_filters). При пустом filters возвращаются доступные фильтры с подписями и количеством позиций.",
      candidates,
    };
  }

  const exact = await fetchFiltered(filteredEntries);
  const isExactEmpty = exact.total === 0 || exact.candidates.length === 0;
  if (!isExactEmpty) {
    return {
      distributor: displayDistributorName("ChipDip"),
      source: "User-authorized public parametric HTML page of the ChipDip catalog",
      category: input.category,
      category_url: exact.url.toString(),
      filters_applied: Object.fromEntries(filteredEntries),
      resolved_filters: resolvedFilters,
      result_summary: {
        category_total: exact.total,
        returned: exact.candidates.length,
        request_count: requestCount,
      },
      available_filters: undefined,
      notice: "p.0 — бренд, x.<id> — характеристики категории, moq — мин. количество заказа (1..5), locid — магазины. Фильтры можно задавать по названию и подписи: например {\"Ёмкость\": \"10 мкФ\"} или {\"Бренд\": \"Murata\"} — коды сайта подставятся автоматически (см. resolved_filters). При пустом filters возвращаются доступные фильтры с подписями и количеством позиций.",
      candidates: exact.candidates,
    };
  }

  const exactFilters = Object.fromEntries(filteredEntries);
  const attempts = [];
  let relaxed;
  const maxAttempts = Math.min(filteredEntries.length - 1, 4);
  for (let keep = filteredEntries.length - 1; keep >= Math.max(1, filteredEntries.length - maxAttempts); keep--) {
    const subset = filteredEntries.slice(0, keep);
    const attempt = await fetchFiltered(subset);
    attempts.push({ kept_filters: keep, total_matches: attempt.total ?? 0, url: attempt.url.toString() });
    if (attempt.total !== 0 && attempt.candidates.length > 0) {
      relaxed = { ...attempt, filters: subset };
      break;
    }
  }

  const noticeParts = [
    `Точный поиск по ${filteredEntries.length} параметр(ам) (${Object.values(exactFilters).join(" + ")}) дал 0 вариантов.`,
  ];
  if (relaxed) {
    noticeParts.push(`Количество параметров уменьшено до ${relaxed.filters.length}: ${Object.values(Object.fromEntries(relaxed.filters)).join(" + ")}.`);
  } else {
    noticeParts.push("Поиск с меньшим количеством параметров тоже не дал результатов.");
  }

  return {
    distributor: displayDistributorName("ChipDip"),
    source: "User-authorized public parametric HTML page of the ChipDip catalog",
    category: input.category,
    category_url: relaxed ? relaxed.url.toString() : exact.url.toString(),
    exact_match: {
      total_matches: 0,
      filters: exactFilters,
      url: exact.url.toString(),
      note: "Точная комбинация параметров не дала результатов; количество параметров уменьшено автоматически.",
    },
    applied_filters: relaxed ? Object.fromEntries(relaxed.filters) : {},
    dropped_filters: relaxed ? Object.fromEntries(filteredEntries.slice(relaxed.filters.length)) : exactFilters,
    attempts,
    resolved_filters: resolvedFilters,
    result_summary: {
      category_total: relaxed?.total,
      returned: relaxed?.candidates.length ?? 0,
      request_count: requestCount,
    },
    notice: noticeParts.join(" "),
    candidates: relaxed?.candidates ?? [],
  };
}

function parsePromelecFilters(html) {
  const radios = [];
  for (const match of html.matchAll(/<input[^>]*type="radio"[^>]*name="filter"[^>]*value="([^"]*)"([^>]*)>/gi)) {
    radios.push(cleanObject({ value: match[1], selected: /checked/i.test(match[2]) }));
  }
  const brands = [];
  const body3 = [];
  for (const match of html.matchAll(/<input[^>]*type="checkbox"[^>]*class="[^"]*js-filter-item[^"]*"[^>]*value="(\d+)"[^>]*>/gi)) {
    const labelBlock = html.slice(match.index, html.indexOf("</li>", match.index));
    if (/js-filter-brand/i.test(match[0])) {
      brands.push(cleanObject({
        id: match[1],
        label: htmlText(labelBlock.match(/class="label-text">([\s\S]*?)<\/span>/i)?.[1]) || match[1],
      }));
    } else if (/js-filter-body3/i.test(match[0])) {
      body3.push(cleanObject({
        id: match[1],
        label: htmlText(labelBlock.match(/data-val="([^"]*)"/i)?.[1]) || match[1],
      }));
    }
  }
  const smartCategory = html.match(/data-curent-category="(\d+)"/i)?.[1];
  return cleanObject({
    radios,
    brands: brands.slice(0, 200),
    body3: body3.slice(0, 200),
    smart_category: smartCategory ? Number(smartCategory) : undefined,
  });
}

async function searchPromelecParametric(input) {
  const limit = Math.min(10, input.limit ?? 10);
  let path = input.category;
  if (!path && input.component_type) {
    path = resolveParametricCategory("promelec", input.component_type)?.key;
  }
  if (!path) return parametricCategoryFallback("promelec", input.component_type);
  if (/\s|[а-яё]/i.test(path) && !/^https?:\/\//i.test(path)) {
    const resolved = resolveParametricCategory("promelec", path);
    if (resolved) path = resolved.key;
  }
  if (/^https?:\/\//i.test(path)) {
    const parsed = new URL(path);
    if (parsed.hostname !== "www.promelec.ru") {
      throw new Error("category must be a promelec.ru catalog URL or a path like 4/216 (Полевые транзисторы).");
    }
    path = parsed.pathname;
  }
  if (!path.startsWith("/catalog/")) path = `/catalog/${path}`;
  const baseUrl = new URL(`https://www.promelec.ru${path.replace(/\/+$/, "")}/`);
  const filteredEntries = Object.entries(input.filters ?? {});
  let requestCount = 0;

  const buildUrl = (entries) => {
    const built = new URL(baseUrl);
    if (entries.length > 0) {
      built.searchParams.set("smartFilter", "0");
      for (const [name, value] of entries) built.searchParams.set(name, value);
    }
    if (input.page && input.page > 1) built.searchParams.set("page", String(input.page));
    return built;
  };
  const totalFromHtml = (html) => {
    const count = html.match(/<div class="faset-list__category[^"]*">\s*<span>\s*\((\d+)\)/i)?.[1];
    return count ? Number(count) : undefined;
  };
  const fetchFiltered = async (entries) => {
    const target = buildUrl(entries);
    try {
      const html = await fetchPublicCatalogHtml("Promelec", target);
      requestCount++;
      return { html, url: target, total: totalFromHtml(html), candidates: parsePromelecResults(html, limit) };
    } catch (error) {
      if (error instanceof Error && /HTTP 404/.test(error.message)) {
        requestCount++;
        return { html: undefined, url: target, total: 0, candidates: [] };
      }
      throw error;
    }
  };

  if (filteredEntries.length === 0) {
    const result = await fetchFiltered([]);
    const availableFilters = parsePromelecFilters(result.html);
    return {
      distributor: displayDistributorName("Promelec"),
      source: "User-authorized public parametric HTML page of the Промэлектроника catalog",
      category: input.category,
      category_url: result.url.toString(),
      result_summary: {
        category_total: result.total,
        returned: result.candidates.length,
        request_count: requestCount,
      },
      available_filters: availableFilters,
      notice: "Фильтры: brand=<ID производителя> (несколько через ;), body3=<ID корпуса>, instock=1, special, novelty, kolm; числовые характеристики — param-<id>-from/to (ID из AJAX «Умный фильтр»). При пустом filters возвращаются доступные значения.",
      candidates: result.candidates,
    };
  }

  const exact = await fetchFiltered(filteredEntries);
  const isExactEmpty = exact.total === 0 || exact.candidates.length === 0;
  if (!isExactEmpty) {
    return {
      distributor: displayDistributorName("Promelec"),
      source: "User-authorized public parametric HTML page of the Промэлектроника catalog",
      category: input.category,
      category_url: exact.url.toString(),
      filters_applied: Object.fromEntries(filteredEntries),
      result_summary: {
        category_total: exact.total,
        returned: exact.candidates.length,
        request_count: requestCount,
      },
      available_filters: undefined,
      notice: "Фильтры: brand=<ID производителя> (несколько через ;), body3=<ID корпуса>, instock=1, special, novelty, kolm; числовые характеристики — param-<id>-from/to (ID из AJAX «Умный фильтр»). При пустом filters возвращаются доступные значения.",
      candidates: exact.candidates,
    };
  }

  const exactFilters = Object.fromEntries(filteredEntries);
  const attempts = [];
  let relaxed;
  const maxAttempts = Math.min(filteredEntries.length - 1, 4);
  for (let keep = filteredEntries.length - 1; keep >= Math.max(1, filteredEntries.length - maxAttempts); keep--) {
    const subset = filteredEntries.slice(0, keep);
    const attempt = await fetchFiltered(subset);
    attempts.push({ kept_filters: keep, total_matches: attempt.total ?? 0, url: attempt.url.toString() });
    if (attempt.total !== 0 && attempt.candidates.length > 0) {
      relaxed = { ...attempt, filters: subset };
      break;
    }
  }

  const noticeParts = [
    `Точный поиск по ${filteredEntries.length} параметр(ам) (${Object.values(exactFilters).join(" + ")}) дал 0 вариантов.`,
  ];
  if (relaxed) {
    noticeParts.push(`Количество параметров уменьшено до ${relaxed.filters.length}: ${Object.values(Object.fromEntries(relaxed.filters)).join(" + ")}.`);
  } else {
    noticeParts.push("Поиск с меньшим количеством параметров тоже не дал результатов.");
  }

  return {
    distributor: displayDistributorName("Promelec"),
    source: "User-authorized public parametric HTML page of the Промэлектроника catalog",
    category: input.category,
    category_url: relaxed ? relaxed.url.toString() : exact.url.toString(),
    exact_match: {
      total_matches: 0,
      filters: exactFilters,
      url: exact.url.toString(),
      note: "Точная комбинация параметров не дала результатов; количество параметров уменьшено автоматически.",
    },
    applied_filters: relaxed ? Object.fromEntries(relaxed.filters) : {},
    dropped_filters: relaxed ? Object.fromEntries(filteredEntries.slice(relaxed.filters.length)) : exactFilters,
    attempts,
    result_summary: {
      category_total: relaxed?.total,
      returned: relaxed?.candidates.length ?? 0,
      request_count: requestCount,
    },
    notice: noticeParts.join(" "),
    candidates: relaxed?.candidates ?? [],
  };
}

function parseElectronshikParamFields(html) {
  const fields = [];
  for (const block of html.matchAll(/<li\b[^>]*class="filter-param-block"[^>]*>([\s\S]*?)<\/li>/gi)) {
    const tag = block[1].match(/<div class="filter-param-name"[^>]*>/i)?.[0] ?? "";
    const title = tag.match(/data-title="([^"]*)"/i)?.[1];
    const field = tag.match(/data-field="([^"]*)"/i)?.[1];
    const node = tag.match(/data-node="([^"]*)"/i)?.[1];
    const sc = tag.match(/data-sc="([^"]*)"/i)?.[1];
    if (!field) continue;
    fields.push(cleanObject({ field, title: decodeHtml(title) || undefined, node, sc }));
  }
  return fields;
}

function electronshikNumericValue(value) {
  const match = String(value ?? "").replace(/\s/g, "").match(/^([\d.,]+)(мкф|нф|пф|мф|uf|µf|nf|pf|mf|кв|мв|в|v|квт|вт|w|kw)?$/i);
  if (!match) return String(value);
  const number = Number(match[1].replace(",", "."));
  if (!Number.isFinite(number)) return String(value);
  const multipliers = {
    "мкф": 1e-6, "uf": 1e-6, "µf": 1e-6,
    "нф": 1e-9, "nf": 1e-9,
    "пф": 1e-12, "pf": 1e-12,
    "мф": 1e-3, "mf": 1e-3,
    "кв": 1e3, "kv": 1e3, "мв": 1e-3, "mv": 1e-3,
    "квт": 1e3, "kw": 1e3, "вт": 1, "w": 1,
    "в": 1, "v": 1,
  };
  return String(number * (multipliers[match[2]?.toLowerCase()] ?? 1));
}

async function electronshikApplyFilters(category, filters, node) {
  const body = new URLSearchParams();
  for (const [field, value] of Object.entries(filters)) {
    body.append(`find[${field}][node]`, node ?? "");
    body.append(`find[${field}][field]`, field);
    const isList = field.startsWith("kpd_t");
    if (isList) {
      body.append(`find[${field}][type]`, "T");
      body.append(`find[${field}][is_range]`, "0");
      body.append(`find[${field}][is_simple_range]`, "0");
      body.append(`find[${field}][values][0]`, value);
      body.append(`find[${field}][range][]`, "");
    } else {
      const numeric = electronshikNumericValue(value);
      body.append(`find[${field}][type]`, "N");
      body.append(`find[${field}][is_range]`, "0");
      body.append(`find[${field}][is_simple_range]`, "1");
      body.append(`find[${field}][dim]`, "");
      body.append(`find[${field}][range][min]`, numeric);
      body.append(`find[${field}][range][max]`, numeric);
      body.append(`find[${field}][values][0]`, "");
    }
  }
  body.append("parametric", "1");
  body.append("view", "table");
  body.append("node", node ?? "");
  body.append("sc", "");
  body.append("hidden[]", "");
  return fetchPublicCatalogHtml(
    "Electronshik",
    `https://www.electronshik.ru/catalog/${category}`,
    { method: "POST", body: body.toString() },
  );
}

async function searchElectronshikParametric(input) {
  const limit = Math.min(10, input.limit ?? 10);
  let category = input.category;
  if (!category && input.component_type) {
    category = resolveParametricCategory("electronshik", input.component_type)?.key;
  }
  if (!category) return parametricCategoryFallback("electronshik", input.component_type);
  if (/\s|[а-яё]/i.test(category) && !/^https?:\/\//i.test(category)) {
    const resolved = resolveParametricCategory("electronshik", category);
    if (resolved) category = resolved.key;
  }
  if (/^https?:\/\//i.test(category)) {
    category = new URL(category).pathname.replace(/^\/+|\/+$/g, "");
  }
  category = String(category).replace(/^\/+|\/+$/g, "");
  const filters = input.filters ?? {};
  const filteredEntries = Object.entries(filters);
  const baseUrl = `https://www.electronshik.ru/catalog/${category}`;
  let requestCount = 0;

  const totalFromHtml = (html) => {
    const total = html.match(/<div class="section-items-count">\s*Найдено:\s*([\d\s]+)/i)?.[1];
    return total ? Number(total.replace(/\s/g, "")) : undefined;
  };

  if (filteredEntries.length === 0) {
    const html = await fetchPublicCatalogHtml("Electronshik", baseUrl);
    requestCount++;
    const fields = parseElectronshikParamFields(html);
    const candidates = parseElectronshikResults(html, limit);
    return {
      distributor: displayDistributorName("Electronshik"),
      source: "User-authorized public parametric HTML page of the ДКО Электронщик catalog",
      category,
      result_summary: {
        total_matches: totalFromHtml(html),
        returned: candidates.length,
        request_count: requestCount,
      },
      available_filters: fields,
      notice: "Поля фильтров: kpd_d* (числовые), kpd_t* (списки). Значения передавайте как на сайте («50 В», «0805»). Прямой GET с find[...] не фильтрует — применяется POST, затем результат читается по короткому URL (tinyurl).",
      candidates,
    };
  }

  const fetchFiltered = async (entries) => {
    const target = Object.fromEntries(entries);
    const html = await electronshikApplyFilters(category, target, node);
    requestCount++;
    return { html, total: totalFromHtml(html), candidates: parseElectronshikResults(html, limit), filters: target };
  };

  let node = input.node;
  if (!node) {
    const html = await fetchPublicCatalogHtml("Electronshik", baseUrl);
    requestCount++;
    node = parseElectronshikParamFields(html).find((entry) => entry.field)?.node;
  }

  const exact = await fetchFiltered(filteredEntries);
  if (exact.total !== 0 && exact.candidates.length > 0) {
    return {
      distributor: displayDistributorName("Electronshik"),
      source: "User-authorized public parametric filter of the ДКО Электронщик catalog (POST apply; the filtered list is returned directly in the POST response)",
      category,
      filters_applied: exact.filters,
      result_summary: {
        total_matches: exact.total,
        returned: exact.candidates.length,
        request_count: requestCount,
      },
      notice: "Фильтры применяются POST-запросом, отфильтрованный список приходит прямо в ответе. Числовые фильтры (kpd_d*, kpd_rd*) принимают диапазон в базовых единицах — ёмкость в фарадах («10 мкФ»/«0.00001»), напряжение в вольтах («50 В»); списковые (kpd_t*) — значения как на сайте («0805»). Пагинация отфильтрованных результатов сайтом не поддерживается — возвращается первый экран (до 40 строк).",
      candidates: exact.candidates,
    };
  }

  const exactFilters = Object.fromEntries(filteredEntries);
  const attempts = [];
  let relaxed;
  const maxAttempts = Math.min(filteredEntries.length - 1, 4);
  for (let keep = filteredEntries.length - 1; keep >= Math.max(1, filteredEntries.length - maxAttempts); keep--) {
    const subset = filteredEntries.slice(0, keep);
    const attempt = await fetchFiltered(subset);
    attempts.push({ kept_filters: keep, total_matches: attempt.total ?? attempt.candidates.length });
    if (attempt.total !== 0 && attempt.candidates.length > 0) {
      relaxed = attempt;
      break;
    }
  }

  const noticeParts = [
    `Точный поиск по ${filteredEntries.length} параметр(ам) (${Object.values(exactFilters).join(" + ")}) дал 0 вариантов.`,
  ];
  if (relaxed) {
    noticeParts.push(`Количество параметров уменьшено до ${Object.keys(relaxed.filters).length}: ${Object.values(relaxed.filters).join(" + ")}.`);
  } else {
    noticeParts.push("Поиск с меньшим количеством параметров тоже не дал результатов.");
  }

  return {
    distributor: displayDistributorName("Electronshik"),
    source: "User-authorized public parametric filter of the ДКО Электронщик catalog (POST apply; the filtered list is returned directly in the POST response)",
    category,
    exact_match: {
      total_matches: 0,
      filters: exactFilters,
      note: "Точная комбинация параметров не дала результатов; количество параметров уменьшено автоматически.",
    },
    applied_filters: relaxed?.filters ?? {},
    dropped_filters: relaxed
      ? Object.fromEntries(filteredEntries.slice(Object.keys(relaxed.filters).length))
      : exactFilters,
    attempts,
    result_summary: {
      total_matches: relaxed?.total,
      returned: relaxed?.candidates.length ?? 0,
      request_count: requestCount,
    },
    notice: noticeParts.join(" "),
    candidates: relaxed?.candidates ?? [],
  };
}

function parsePlatanFilterParams(html) {
  const items = [];
  for (const match of html.matchAll(/<tr\b[^>]*class='[^']*(?:parametr_head|parametr_no_head)[^']*'[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const title = htmlText(match[1].match(/<b>([\s\S]*?)<\/b>/i)?.[1]);
    items.push({ type: "head", title: title ?? "", index: match.index });
  }
  for (const match of html.matchAll(/<tr\b[^>]*id="parametr_(\d+)"[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const name = match[2].match(/name="(p_\d+_\d+_\d+)"[^>]*>/i)?.[1]
      ?? match[2].match(/name=(p_\d+_\d+_\d+)[^>]*>/i)?.[1];
    if (!name) continue;
    const values = [];
    for (const checkbox of match[2].matchAll(/<input[^>]*type="checkbox"[^>]*name="[^"]*"[^>]*value="([^"]*)"([^>]*)>/gi)) {
      values.push(cleanObject({
        value: decodeHtml(checkbox[1]),
        label: decodeHtml(checkbox[1]),
        selected: /checked/i.test(checkbox[2]),
      }));
    }
    for (const option of match[2].matchAll(/<option value='([^']*)'([^>]*)>([\s\S]*?)<\/option>/gi)) {
      values.push(cleanObject({
        value: decodeHtml(option[1]),
        label: htmlText(option[3]) || decodeHtml(option[1]),
        selected: /selected/i.test(option[2]),
      }));
    }
    const rangeInputs = [...match[2].matchAll(
      /<input[^>]*type="text"[^>]*name="(p_2_(\d+)_(\d+))"[^>]*>/gi,
    )].map((input) => cleanObject({
      name: input[1],
      slot: Number(input[2]),
      id: input[3],
    }));
    items.push({
      type: "row",
      id: match[1],
      name,
      values: values.slice(0, 100),
      range: rangeInputs.length > 0 ? rangeInputs : undefined,
      index: match.index,
    });
  }
  items.sort((a, b) => a.index - b.index);
  let currentTitle;
  const rows = [];
  for (const item of items) {
    if (item.type === "head") {
      currentTitle = item.title;
      continue;
    }
    rows.push(cleanObject({
      id: item.id,
      name: item.name,
      title: currentTitle || undefined,
      kind: item.range ? "range" : "list",
      values: item.values,
      range: item.range,
    }));
  }
  return rows;
}

function parsePlatanCategoryCards(html, limit) {
  const results = [];
  const starts = [...html.matchAll(/<div class='card border p-1[^']*'[^>]*>/gi)]
    .map((match) => match.index)
    .filter((index) => index !== undefined);
  for (let index = 0; index < starts.length && results.length < limit; index += 1) {
    const card = html.slice(starts[index], starts[index + 1] ?? html.length);
    const product = card.match(/<a\b[^>]*class='[^']*link[^']*'[^>]*href='([^']*)'[^>]*>([\s\S]*?)<\/a>/i);
    const title = htmlText(product?.[2]);
    const productUrl = absoluteUrl("https://www.platan.ru", product?.[1]);
    if (!title || !productUrl) continue;
    const manufacturer = [...card.matchAll(/<small\b[^>]*class='text-muted[^']*'[^>]*>([\s\S]*?)<\/small>/gi)]
      .map((match) => htmlText(match[1]))
      .find((value) => value && !value.startsWith("Код:")) || undefined;
    const quantityText = card.match(/<span class='font-weight-bold'>([\d\s]+)\s*шт/i)?.[1];
    const priceMarkup = card.match(/<td class='text-monospace[^']*price[^']*'>([\d.,]+)<\/td>/i)?.[1];
    const priceNote = htmlText(card.match(/<td[^>]*>(?:\/шт|от\s*[\d\s]+шт)[^<]*<\/td>/i)?.[0] ?? "");
    const itemId = card.match(/\/cgi-bin\/qwery\.pl\/id=(\d+)/i)?.[1];
    const titleParts = title.split(",").map((part) => part.trim()).filter(Boolean);
    results.push(cleanObject({
      distributor: displayDistributorName("Platan"),
      title: titleParts[0],
      manufacturer,
      description: titleParts.length > 1 ? titleParts.slice(1).join(", ") : undefined,
      available_quantity: parseRussianNumber(quantityText),
      price_rub: parseRussianNumber(priceMarkup),
      price_note: priceNote || undefined,
      item_id: itemId,
      product_url: productUrl,
    }));
  }
  return results;
}

function platanParamTitle(html) {
  return htmlText(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "");
}

function platanParamTotal(html) {
  return html.match(/<h1[^>]*>[\s\S]*?<sub>(\d+)<\/sub>/i)?.[1];
}

function matchPlatanParamTitle(params, name) {
  const exact = params.find(
    (entry) => entry.title === name || normalizeText(entry.title) === normalizeText(name),
  );
  if (exact) return exact;
  const normalized = normalizeText(name);
  if (!normalized) return undefined;
  return params.find(
    (entry) => normalizeText(entry.title).includes(normalized) || normalized.includes(normalizeText(entry.title)),
  );
}

function buildPlatanParamQuery(resolved, input) {
  const query = [];
  for (const { param, values } of resolved) {
    for (const entry of values) {
      if (param.range) {
        const min = param.range.find((field) => field.slot === 1)?.name;
        const max = param.range.find((field) => field.slot === 2)?.name;
        const pair = entry.split("-");
        if (pair.length === 2 && pair[0].trim() !== "" && pair[1].trim() !== "") {
          if (min) query.push(`${min}=${toCp1251Url(pair[0].trim())}`);
          if (max) query.push(`${max}=${toCp1251Url(pair[1].trim())}`);
        } else {
          if (min) query.push(`${min}=${toCp1251Url(entry)}`);
          if (max) query.push(`${max}=${toCp1251Url(entry)}`);
        }
        continue;
      }
      query.push(`${param.name}=${toCp1251Url(entry)}`);
    }
  }
  query.push("sh=0");
  if (input.sort) query.push(`sort=${input.sort}`);
  if (input.page && input.page > 1) query.push(`page=${input.page}`);
  return query.join("&");
}

async function searchPlatanParametric(input) {
  const limit = Math.min(10, input.limit ?? 10);
  let categoryId = input.category_id;
  if (!categoryId && input.component_type) {
    const resolved = resolveParametricCategory("platan", input.component_type);
    if (resolved) categoryId = Number(resolved.key);
  }
  if (!categoryId) return parametricCategoryFallback("platan", input.component_type);
  const baseUrl = `https://www.platan.ru/shop/${categoryId}`;

  const filters = { ...(input.filters ?? {}) };
  if (input.parameter && input.value !== undefined) filters[input.parameter] = input.value;

  if (Object.keys(filters).length === 0) {
    const html = await fetchPublicCatalogHtml("Platan", baseUrl);
    const params = parsePlatanFilterParams(html);
    const candidates = parsePlatanCategoryCards(html, limit);
    return {
      distributor: displayDistributorName("Platan"),
      source: "User-authorized public parametric HTML page of the Platan catalog",
      category_id: categoryId,
      category_title: platanParamTitle(html),
      category_url: baseUrl,
      available_filters: params,
      result_summary: {
        total_matches: platanParamTotal(html) ? Number(platanParamTotal(html)) : undefined,
        returned: candidates.length,
        request_count: 1,
      },
      notice:
        "Передайте filters (название параметра из available_filters → значение) или parameter+value. Несколько параметров комбинируются в одном запросе; несколько значений одного параметра — через ; (OR). Кириллица кодируется в windows-1251.",
      candidates,
    };
  }

  let params;
  let resolvedTitle;
  let requestCount = 0;
  const needResolve = Object.keys(filters).some((name) => !/^p_\d+_\d+_\d+$/.test(name));
  if (needResolve) {
    const html = await fetchPublicCatalogHtml("Platan", baseUrl);
    requestCount++;
    params = parsePlatanFilterParams(html);
    resolvedTitle = platanParamTitle(html);
  }

  const resolved = [];
  for (const [name, rawValue] of Object.entries(filters)) {
    let param;
    if (/^p_\d+_\d+_\d+$/.test(name)) {
      param = params?.find((entry) => entry.name === name) ?? { name };
    } else {
      param = matchPlatanParamTitle(params, name);
      if (!param) {
        throw new Error(
          `Параметр «${name}» не найден; доступные: ${params.map((entry) => `${entry.title} (${entry.name})`).join(", ") || "нет"}.`,
        );
      }
    }
    const values = String(rawValue).split(";").map((entry) => entry.trim()).filter(Boolean);
    if (values.length > 0) resolved.push({ param, values });
  }

  const namedFilters = (list) => Object.fromEntries(list.map(({ param, values }) => [param.title ?? param.name, values.join(";")]));

  async function platanFilteredFetch(resolvedList) {
    const query = buildPlatanParamQuery(resolvedList, input);
    try {
      const html = await fetchPublicCatalogHtml("Platan", `${baseUrl}?${query}`);
      requestCount++;
      return { ok: true, html, query, filters: resolvedList };
    } catch (error) {
      if (error instanceof Error && /HTTP 404/.test(error.message)) {
        requestCount++;
        return { ok: false, query };
      }
      throw error;
    }
  }

  const exact = await platanFilteredFetch(resolved);
  if (exact.ok) {
    const candidates = parsePlatanCategoryCards(exact.html, limit);
    return {
      distributor: displayDistributorName("Platan"),
      source: "User-authorized public parametric GET of the Platan catalog",
      category_id: categoryId,
      category_title: platanParamTitle(exact.html),
      category_url: `${baseUrl}?${exact.query}`,
      filters: namedFilters(exact.filters),
      result_summary: {
        total_matches: platanParamTotal(exact.html) ? Number(platanParamTotal(exact.html)) : undefined,
        returned: candidates.length,
        request_count: requestCount,
      },
      notice:
        "Комбинация нескольких параметров в одном запросе работает (например p_2_0_3701=470&p_2_0_3708=6.3). Параметр kind=range в available_filters — диапазон от/до.",
      candidates,
    };
  }

  const exactFilters = namedFilters(resolved);
  const attempts = [];
  let relaxed;
  const maxAttempts = Math.min(resolved.length - 1, 4);
  for (let keep = resolved.length - 1; keep >= Math.max(1, resolved.length - maxAttempts); keep--) {
    const subset = resolved.slice(0, keep);
    const attempt = await platanFilteredFetch(subset);
    attempts.push({ kept: subset.length, ok: attempt.ok, query: attempt.query });
    if (attempt.ok) {
      relaxed = attempt;
      break;
    }
  }

  const resultSummary = {
    request_count: requestCount,
    returned: 0,
  };
  const candidates = [];
  const noticeParts = [
    `Точный поиск по ${resolved.length} параметр(ам) (${Object.values(exactFilters).join(" + ")}) дал 0 вариантов.`,
  ];

  if (relaxed) {
    candidates.push(...parsePlatanCategoryCards(relaxed.html, limit));
    resultSummary.total_matches = platanParamTotal(relaxed.html) ? Number(platanParamTotal(relaxed.html)) : undefined;
    resultSummary.returned = candidates.length;
    noticeParts.push(
      `Количество параметров уменьшено до ${relaxed.filters.length}: ${Object.values(namedFilters(relaxed.filters)).join(" + ")}.`,
    );
  } else {
    resultSummary.total_matches = 0;
    noticeParts.push("Поиск с меньшим количеством параметров тоже не дал результатов (сайт возвращает HTTP 404 на пустую выдачу).");
  }

  return {
    distributor: displayDistributorName("Platan"),
    source: "User-authorized public parametric GET of the Platan catalog",
    category_id: categoryId,
    category_title: relaxed ? platanParamTitle(relaxed.html) : (resolvedTitle ?? ""),
    category_url: relaxed ? `${baseUrl}?${relaxed.query}` : `${baseUrl}?${exact.query}`,
    exact_match: {
      total_matches: 0,
      filters: exactFilters,
      url: `${baseUrl}?${exact.query}`,
      note: "Точная комбинация параметров не дала результатов; количество параметров уменьшено автоматически.",
    },
    applied_filters: relaxed ? namedFilters(relaxed.filters) : {},
    dropped_filters: relaxed ? namedFilters(resolved.slice(relaxed.filters.length)) : namedFilters(resolved),
    attempts: attempts.map((entry) => ({ kept_parameters: entry.kept, total_matches: entry.ok ? undefined : 0, url: `${baseUrl}?${entry.query}` })),
    result_summary: resultSummary,
    notice: noticeParts.join(" "),
    candidates,
  };
}

function matchDigiKeyParametricFilters(parametricFilters, filters) {
  const matched = [];
  for (const [name, value] of Object.entries(filters ?? {})) {
    const expectedName = normalizeText(name);
    const parameter = parametricFilters.find((entry) => {
      const candidate = normalizeText(entry?.ParameterName ?? "");
      return candidate !== "" && (candidate.includes(expectedName) || expectedName.includes(candidate));
    });
    if (!parameter) continue;
    const expectedValue = normalizeText(value);
    const filterValue = (parameter.FilterValues ?? []).find((entry) => {
      const candidate = normalizeText(entry?.ValueName ?? "");
      return (
        candidate !== "" &&
        (candidate === expectedValue || (expectedValue.length > candidate.length && expectedValue.includes(candidate)))
      );
    });
    if (filterValue?.ValueId === undefined) continue;
    matched.push({ ParameterId: parameter.ParameterId, FilterValues: [{ Id: filterValue.ValueId }] });
  }
  return matched;
}

function digiKeyLeafCategoryIds(first) {
  const product = first?.Products?.[0] ?? first?.ExactMatches?.[0];
  const category = product?.Product?.Category ?? product?.Category;
  const children = Array.isArray(category?.ChildCategories) ? category.ChildCategories : [];
  const ids = children.map((child) => child?.CategoryId).filter((id) => Number.isInteger(id));
  if (ids.length > 0) return ids;
  const ownId = category?.CategoryId;
  return Number.isInteger(ownId) ? [ownId] : [];
}

async function searchDigiKeyParametric(input) {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const fetchLimit = Math.min(MAX_FETCH, Math.max(limit * 3, DEFAULT_LIMIT));
  const searchOptions = [];
  if (input.in_stock_only || input.quantity !== undefined) searchOptions.push("InStock");
  if (input.rohs_only) searchOptions.push("RohsCompliant");
  const buildBody = (parameterFilters) => cleanObject({
    Keywords: input.query,
    Limit: fetchLimit,
    Offset: 0,
    FilterOptionsRequest: {
      ...(searchOptions.length > 0 ? { SearchOptions: searchOptions } : {}),
      ...(parameterFilters ? { ParameterFilterRequest: parameterFilters } : {}),
    },
  });
  const first = await digiKeyRequest("/products/v4/search/keyword", {
    method: "POST",
    body: buildBody(undefined),
    site: input.site,
    currency: input.currency,
  });
  const parametricFilters = first?.FilterOptions?.ParametricFilters ?? [];
  const mapped = matchDigiKeyParametricFilters(parametricFilters, input.filters ?? {});
  let response = first;
  let matched = mapped;
  let usedCategory;
  if (mapped.length > 0) {
    for (const leafId of digiKeyLeafCategoryIds(first)) {
      try {
        response = await digiKeyRequest("/products/v4/search/keyword", {
          method: "POST",
          body: buildBody({ CategoryFilter: { Id: leafId }, ParameterFilters: mapped }),
          site: input.site,
          currency: input.currency,
        });
        usedCategory = leafId;
        break;
      } catch {
        // parent categories reject parametric filters; try the next leaf category
      }
    }
    if (usedCategory === undefined) {
      matched = [];
      response = first;
    }
  }
  const products = [...(response.ExactMatches ?? []), ...(response.Products ?? [])].map((product) =>
    summarizeDigiKeyProduct(product?.Product ?? product),
  );
  const selected = selectComponents({
    distributorName: "DigiKey",
    query: input.query,
    parts: products,
    filters: input.filters ?? {},
    manufacturer: input.manufacturer,
    quantity: input.quantity,
    inStockOnly: input.in_stock_only,
    rohsOnly: input.rohs_only,
    limit,
    total: response.ProductsCount ?? response.TotalCount ?? products.length,
  });
  return {
    ...selected,
    parametric: {
      mode: matched.length > 0 ? "server-side ParameterFilterRequest" : "client-side parameter ranking only",
      matched_filters: matched.length > 0 ? matched.map((entry) => ({ parameter_id: entry.ParameterId })) : undefined,
      leaf_category_id: usedCategory,
      available_parametric_filters: parametricFilters.slice(0, 30).map((entry) => ({
        parameter_id: entry.ParameterId,
        name: entry.ParameterName,
        values: (entry.FilterValues ?? []).slice(0, 25).map((value) => cleanObject({
          value_id: value.ValueId,
          name: value.ValueName,
          count: value.ProductCount,
          range_type: value.RangeFilterType,
        })),
      })),
      note: matched.length === 0
        ? "DigiKey API не нашёл серверных параметрических значений под заданные фильтры; фильтры применены клиентски к результатам keyword-поиска. Доступные серверные параметры возвращены в available_parametric_filters."
        : undefined,
    },
  };
}

async function searchMouserParametric(input) {
  const result = await searchMouser(input);
  return {
    ...result,
    notice: "Mouser Search API не поддерживает серверный параметрический поиск (только keyword + InStock/RoHS); фильтры применены клиентски к результатам keyword-запроса по полям ответа.",
  };
}

async function searchLcscParametric(input) {
  const result = await searchLcsc(input);
  return {
    ...result,
    notice: "LCSC Open API не поддерживает серверный параметрический поиск (только keyword/категория); фильтры применены клиентски к результатам keyword-запроса по атрибутам товаров.",
  };
}

async function withSourceDeadline(sourcePromise, deadlineMs, label) {
  if (!deadlineMs || deadlineMs <= 0) return sourcePromise;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), deadlineMs);
  });
  const result = await Promise.race([sourcePromise, timeout]);
  clearTimeout(timer);
  if (result?.timedOut) {
    return { error: `${label} did not respond within ${Math.round(deadlineMs / 1000)} s. The response was returned without it; retry with fewer distributors or a larger timeout_seconds.` };
  }
  return result;
}

async function searchElectronicsComponents(input) {
  const distributors = input.distributors ?? ["digikey", "mouser", "lcsc"];
  const deadlineMs = (input.timeout_seconds ?? 90) * 1000;
  const publicInput = input.include_product_details === true
    ? { ...input, include_product_details: true }
    : { ...input, include_product_details: false };
  const sources = await Promise.all(
    distributors.map(async (name) => {
      try {
        const promise = name === "digikey"
          ? searchDigiKey(input)
          : name === "mouser"
            ? searchMouser(input)
            : name === "lcsc"
              ? searchLcsc(input)
              : name === "chipdip"
                ? searchChipDipPublic(publicInput)
                : name === "promelec"
                  ? searchPromelecPublic(publicInput)
                  : name === "elitan"
                    ? searchElitanPublic(publicInput)
                    : name === "berelcom"
                      ? searchBerelcomPublic(publicInput)
                      : name === "electronshik"
                        ? searchElectronshikPublic(publicInput)
                        : searchPlatanPublic(publicInput);
        const result = await withSourceDeadline(promise, deadlineMs, name);
        if (result?.error && !result?.candidates) return { distributor: displayDistributorName(name), error: result.error };
        return { distributor: displayDistributorName(name), result };
      } catch (error) {
        return { distributor: displayDistributorName(name), error: errorMessage(error) };
      }
    }),
  );

  return {
    query: input.query,
    sources,
    note: "JLCPCB's official Components API is code-based. Search LCSC first to obtain C-codes, then call get_jlcpcb_component_details for assembly stock and pricing. ChipDip, Промэлектроника, Elitan, Berelcom, ДКО Электронщик, and Platan public searches run only when explicitly listed in distributors. include_product_details fetches Промэлектроника and ДКО Электронщик product cards for warehouse stock, minimum order, lead time, and price breaks. All listed distributors are queried in parallel; timeout_seconds bounds the whole response.",
  };
}

const searchInputSchema = {
  query: z.string().min(1).max(250).describe("Search phrase or manufacturer part number. Include electrical constraints for Mouser."),
  filters: z.record(z.string(), z.string()).optional().describe("Required parameter name/value pairs, for example {\"Resistance\": \"10 kOhms\", \"Tolerance\": \"1%\", \"Package / Case\": \"0603\"}."),
  manufacturer: z.string().min(1).max(120).optional().describe("Required manufacturer name or a distinctive substring."),
  quantity: z.number().int().positive().optional().describe("Minimum immediately available quantity."),
  in_stock_only: z.boolean().optional().describe("Require a positive available quantity."),
  rohs_only: z.boolean().optional().describe("Require a RoHS-compliant result."),
  limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT).describe("Maximum ranked candidates to return."),
};

const unifiedSearchInputSchema = {
  ...searchInputSchema,
  distributors: z
    .array(z.enum(["digikey", "mouser", "lcsc", "chipdip", "promelec", "elitan", "berelcom", "electronshik", "platan"]))
    .min(1)
    .max(10)
    .optional()
    .default(["digikey", "mouser", "lcsc"])
    .describe("Catalogs to query. LCSC requires approved API credentials; ChipDip, Promelec, Elitan, Berelcom, Electronshik, and Platan perform one explicitly requested public search page."),
  include_product_details: z.boolean().optional().default(false).describe("When true, fetches Promelec and Electronshik product cards of returned candidates (up to 5 each) for warehouse stock, minimum order quantity, lead time, and price breaks. Adds one request per candidate with the 5-second interval."),
  timeout_seconds: z.number().int().min(5).max(600).optional().default(90).describe("Per-source deadline in seconds; the whole response waits at most this long for each distributor, and timed-out sources are reported as errors. All distributors are queried in parallel."),
  site: z.string().length(2).optional().describe("DigiKey site code, for example US, DE, or JP."),
  currency: z.string().length(3).optional().describe("Currency code for DigiKey and LCSC pricing, for example USD or EUR."),
};

const publicHtmlSearchInputSchema = {
  query: z.string().min(2).max(120).describe("Explicit user-requested product search phrase or manufacturer part number."),
  limit: z.number().int().min(1).max(10).optional().default(10).describe("Maximum public search rows to parse from one page."),
  include_product_details: z.boolean().optional().default(false).describe("When true, fetches the product card of each returned candidate (up to 5) to obtain warehouse stock, minimum order quantity, lead time, and price breaks. Adds one request per candidate with the same 5-second interval."),
};

function registerElectronicsPartsTools(server) {
  server.registerTool(
    "search_electronics_components",
    {
      title: "Search electronics components across distributors",
      description:
        "Search DigiKey, Mouser, and LCSC from one tool. All selected distributors are queried in parallel (multi-agent style) and each returns independently ranked candidates with availability, price, and matched requirements. timeout_seconds bounds the response. ChipDip, Promelec, Elitan, Berelcom, Electronshik, and Platan public searches run only when explicitly selected. JLCPCB official assembly details are retrieved separately by LCSC C-code.",
      inputSchema: unifiedSearchInputSchema,
    },
    (input) => runTool(() => searchElectronicsComponents(input)),
  );
}

function registerDigiKeyTools(server) {
  server.registerTool(
    "search_digikey_components",
    {
      title: "Search and select DigiKey components",
      description:
        "Search DigiKey and rank components against required catalog parameters. Use parameter names such as Resistance, Tolerance, Package / Case, Voltage - Rated, Current - Output, or Mounting Type. Returns strict matches first, or the closest candidates with unmet requirements.",
      inputSchema: {
        ...searchInputSchema,
        site: z.string().length(2).optional().describe("DigiKey site code, for example US, DE, or JP."),
        currency: z.string().length(3).optional().describe("Currency code for displayed catalog pricing, for example USD or EUR."),
      },
    },
    (input) => runTool(() => searchDigiKey(input)),
  );
  server.registerTool(
    "get_digikey_component_details",
    {
      title: "Get DigiKey component details",
      description: "Get detailed catalog parameters, availability, pricing, and datasheet information for a DigiKey or manufacturer part number.",
      inputSchema: {
        part_number: z.string().min(1).max(120),
        manufacturer_id: z.string().min(1).max(50).optional().describe("Use only to disambiguate a manufacturer part number."),
        site: z.string().length(2).optional(),
        currency: z.string().length(3).optional(),
      },
    },
    (input) => runTool(() => digiKeyDetails(input)),
  );
}

function registerMouserTools(server) {
  server.registerTool(
    "search_mouser_components",
    {
      title: "Search and select Mouser components",
      description:
        "Search Mouser and rank components against availability, manufacturer, and returned catalog text. Include electrical constraints in query and filters. Mouser's public Search API does not expose a universal structured parameter filter, so filter matches are verified against returned description, category, and specification fields.",
      inputSchema: searchInputSchema,
    },
    (input) => runTool(() => searchMouser(input)),
  );
  server.registerTool(
    "get_mouser_component_details",
    {
      title: "Get Mouser component details",
      description: "Get availability, price breaks, lifecycle, datasheet, and returned specification fields for an exact Mouser part number.",
      inputSchema: {
        part_number: z.string().min(1).max(120),
      },
    },
    (input) => runTool(() => mouserDetails(input)),
  );
}

function registerPublicCatalogTools(server) {
  server.registerTool(
    "search_chipdip_components",
    {
      title: "Search ChipDip public catalog page",
      description:
        "Fetch and parse one user-authorized public ChipDip HTML search page. No API, login, crawling, product-page requests, or retries are used. The server waits at least five seconds between ChipDip requests and stops on CAPTCHA or HTTP 429. Use only when the user explicitly requests ChipDip search and has permission for automated access.",
      inputSchema: publicHtmlSearchInputSchema,
    },
    (input) => runTool(() => searchChipDipPublic(input)),
  );
  server.registerTool(
    "search_promelec_components",
    {
      title: "Search Promelec public catalog page",
      description:
        "Fetch and parse one user-authorized public Promelec HTML search page. No API, login, crawling, or retries are used. The server waits at least five seconds between Promelec requests and stops on CAPTCHA or HTTP 429. Set include_product_details to fetch product cards for warehouse stock, minimum order, lead time, and price breaks. Use only when the user explicitly requests Promelec search and has permission for automated access.",
      inputSchema: publicHtmlSearchInputSchema,
    },
    (input) => runTool(() => searchPromelecPublic(input)),
  );
  server.registerTool(
    "get_promelec_component_details",
    {
      title: "Get Promelec product card details",
      description:
        "Fetch and parse one user-authorized public Promelec product card (https://www.promelec.ru/product/<id>/). Returns warehouse groups with stock, minimum order quantity, lead time, and price breaks per warehouse. No API, login, crawling, or retries are used. The server waits at least five seconds between Promelec requests and stops on CAPTCHA or HTTP 429. Use only when the user explicitly requests Promelec details and has permission for automated access.",
      inputSchema: {
        product_url: z.string().url().describe("Promelec product card URL, for example https://www.promelec.ru/product/810670/."),
      },
    },
    (input) => runTool(async () => {
      const url = new URL(input.product_url);
      if (url.hostname !== "www.promelec.ru" || !/^\/product\/\d+\/?$/.test(url.pathname)) {
        throw new Error("product_url must be a Промэлектроника product card URL, for example https://www.promelec.ru/product/810670/.");
      }
      const html = await fetchPublicCatalogHtml("Promelec", url);
      const details = parsePromelecProductCard(html);
      if (!details?.warehouses) throw new Error("Промэлектроника product card returned no warehouse data.");
      return { distributor: displayDistributorName("Promelec"), product_url: url.toString(), ...details };
    }),
  );
  server.registerTool(
    "search_elitan_components",
    {
      title: "Search Elitan public catalog",
      description:
        "Fetch and parse one user-authorized public Elitan search JSON (https://www.elitan.ru/price/index_json.php). No API, login, crawling, or retries are used. The server waits at least five seconds between Elitan requests and stops on HTTP 429 or CAPTCHA. Set include_product_details to fetch the card JSON endpoints with batches ordered by lead time, each priced for the given quantity. Use only when the user explicitly requests Elitan search and has permission for automated access.",
      inputSchema: {
        ...publicHtmlSearchInputSchema,
        quantity: z.number().int().min(1).max(1000000).optional().default(3).describe("Quantity to price each batch for; each batch gets a unit_price_rub_for_quantity based on its price breaks. Default 3."),
      },
    },
    (input) => runTool(() => searchElitanPublic(input)),
  );
  server.registerTool(
    "get_elitan_component_details",
    {
      title: "Get Elitan product card details",
      description:
        "Call Elitan's own card JSON endpoints (https://www.elitan.ru/price/index_json.php?script=bignote and /ajax/get_analysis_json) with the optional ELITAN_COOKIE session. Returns market analysis per warehouse, available quantity, low price, and every orderable batch with price breaks, minimum order, lead time, pack multiple, and risks. No HTML parsing, API, login, crawling, or retries are used. The server waits at least five seconds between Elitan requests and stops on CAPTCHA or HTTP 429. Use only when the user explicitly requests Elitan details and has permission for automated access.",
      inputSchema: {
        partname_full: z.string().min(3).max(120).describe("Elitan partname with manufacturer ticker, for example ESP32-S3-WROOM-1-N8@ESPRESSYST. Take it from the search results or the product page title."),
        product_url: z.string().url().optional().describe("Elitan product card URL for reference, for example https://www.elitan.ru/price/item30083210."),
        quantity: z.number().int().min(1).max(1000000).optional().default(3).describe("Quantity to price each batch for; batches are ordered by lead time (0 first) and each gets a unit_price_rub_for_quantity based on its price breaks. Default 3."),
      },
    },
    (input) => runTool(async () => {
      if (input.product_url) {
        const url = new URL(input.product_url);
        if (url.hostname !== "www.elitan.ru" || !/^\/price\/item\d+/.test(url.pathname)) {
          throw new Error("product_url must be an Elitan product card URL, for example https://www.elitan.ru/price/item30083210.");
        }
      }
      const details = await elitanCardDetails(input.partname_full, input.quantity ?? 3);
      return {
        distributor: displayDistributorName("Elitan"),
        partname_full: input.partname_full,
        product_url: input.product_url,
        quantity_priced: input.quantity ?? 3,
        authenticated: Boolean(ELITAN_COOKIE),
        product_details: details,
      };
    }),
  );
  server.registerTool(
    "search_berelcom_components",
    {
      title: "Search Berelcom public catalog page",
      description:
        "Fetch and parse one user-authorized public Berelcom (shop.berelcom.ru) HTML search page. No API, login, crawling, product-page requests, or retries are used. The server waits at least five seconds between Berelcom requests and stops on CAPTCHA or HTTP 429. Use only when the user explicitly requests Berelcom search and has permission for automated access.",
      inputSchema: publicHtmlSearchInputSchema,
    },
    (input) => runTool(() => searchBerelcomPublic(input)),
  );
  server.registerTool(
    "search_electronshik_components",
    {
      title: "Search Electronshik public catalog page",
      description:
        "Fetch and parse one user-authorized public Electronshik (www.electronshik.ru) HTML search page. No API, login, crawling, or retries are used. The server waits at least five seconds between Electronshik requests and stops on CAPTCHA or HTTP 429. Set include_product_details to fetch product cards for minimum order and price 'from'. Use only when the user explicitly requests Electronshik search and has permission for automated access.",
      inputSchema: publicHtmlSearchInputSchema,
    },
    (input) => runTool(() => searchElectronshikPublic(input)),
  );
  server.registerTool(
    "get_electronshik_component_details",
    {
      title: "Get Electronshik product card details",
      description:
        "Fetch and parse one user-authorized public Electronshik product card (https://www.electronshik.ru/item/<producer>/<part>). Returns the primary offer's stock, minimum order quantity, price from, and shipping term. No API, login, crawling, or retries are used. The server waits at least five seconds between Electronshik requests and stops on CAPTCHA or HTTP 429. Use only when the user explicitly requests Electronshik details and has permission for automated access.",
      inputSchema: {
        product_url: z.string().url().describe("Electronshik product card URL, for example https://www.electronshik.ru/item/SILIUP/SP30P03TH."),
      },
    },
    (input) => runTool(async () => {
      const url = new URL(input.product_url);
      if (url.hostname !== "www.electronshik.ru" || !/^\/item\/[^/]+\/[^/]+/.test(url.pathname)) {
        throw new Error("product_url must be a ДКО Электронщик product card URL, for example https://www.electronshik.ru/item/SILIUP/SP30P03TH.");
      }
      const html = await fetchPublicCatalogHtml("Electronshik", url);
      const details = parseElectronshikProductCard(html);
      if (!details) throw new Error("ДКО Электронщик product card returned no offer data.");
      return { distributor: displayDistributorName("Electronshik"), product_url: url.toString(), product_details: details };
    }),
  );
  server.registerTool(
    "search_platan_components",
    {
      title: "Search Platan public catalog page",
      description:
        "Fetch and parse one user-authorized public Platan (www.platan.ru) HTML search page. No API, login, crawling, product-page requests, or retries are used. The server waits at least five seconds between Platan requests and stops on CAPTCHA or HTTP 429. Use only when the user explicitly requests Platan search and has permission for automated access.",
      inputSchema: publicHtmlSearchInputSchema,
    },
    (input) => runTool(() => searchPlatanPublic(input)),
  );
}

function registerParametricTools(server) {
  server.registerTool(
    "search_elitan_parametric",
    {
      title: "Parametric search on Elitan catalog",
      description:
        "Parametric (by-parameters) search on Elitan (https://www.elitan.ru/param/). Runs ONLY on explicit demand and is never used by the unified search. Pass a free-text component_type (e.g. «чип резистор 0805») instead of el_type and the category is resolved automatically. Call without filters to list available filter values with counts. If the exact filter combination yields no results (count_search = 0), the tool reports exact_match total_matches=0 and automatically retries with fewer parameters (dropping them one by one from the end, up to 4 attempts), returning the relaxed results in candidates along with applied_filters/dropped_filters. Response of /param/getdata can be huge; only the first positions are returned in compact form.",
      inputSchema: {
        el_type: z.string().max(40).optional().describe("Elitan parametric category code, for example smres (chip resistors) or smccap. Omit to resolve automatically from component_type."),
        component_type: z.string().max(200).optional().describe("Text description of the component to resolve the category automatically, for example «чип резистор 0805» or «керамический конденсатор SMD». Ignored when el_type is given."),
        filters: z.record(z.string(), z.string()).optional().describe("Filter values taken from the filter lists (the value field, NOT the label), for example {\"body_type\": \"0805\", \"resistance\": \"4700.0000\", \"tolerance\": \"F\", \"tkr\": \"100\", \"mfg\": \"...\", \"term_delay\": \"0\"}. resistance/tkr are in Ohms with a dot and 4 decimals (4700.0000 = 4.7 kOhm); tolerance uses letters (F = ±1%); multiple values of one filter are comma-separated."),
        order: z.string().max(60).optional().default("partname,asc").describe("Sort order for the parametric endpoint, for example partname,asc or partname,desc."),
        count_cur_val: z.number().int().min(1).max(1000).optional().default(100).describe("Page size hint for the parametric endpoint (1, 10, 100 or 1000)."),
        limit: z.number().int().min(1).max(10).optional().default(10).describe("Maximum candidates to return."),
      },
    },
    (input) => runTool(() => searchElitanParametric(input)),
  );
  server.registerTool(
    "search_chipdip_parametric",
    {
      title: "Parametric search on ChipDip catalog page",
      description:
        "Parametric (by-parameters) search on ChipDip catalog pages (https://www.chipdip.ru/catalog/<slug>-<id>?p.0=...&x.<id>=...&moq=...). Runs ONLY on explicit demand. Pass a free-text component_type (e.g. «чип резистор 0805») instead of category and the category is resolved automatically. Call without filters to receive available filters with labels and counts (values of x.<id> are site-encoded). If the exact filter combination yields no results (count «N из M» = 0), the tool reports exact_match total_matches=0 and automatically retries with fewer parameters (dropping them one by one from the end, up to 4 attempts), returning the relaxed results in candidates along with applied_filters/dropped_filters. One public HTML page per request, at least five seconds between ChipDip requests, stops on CAPTCHA or HTTP 429.",
      inputSchema: {
        category: z.string().min(1).max(200).optional().describe("ChipDip category slug or full URL, for example ionistory-superkondensatory-1620. Omit to resolve automatically from component_type."),
        component_type: z.string().max(200).optional().describe("Text description of the component to resolve the category automatically, for example «чип резистор 0805» or «керамический конденсатор SMD». Ignored when category is given."),
        filters: z.record(z.string(), z.string()).optional().describe("Filter name/value pairs, for example {\"p.0\": \"BIGCAP\", \"moq\": \"3\"}. p.0 is the brand, x.<id> are category parameters, moq is the minimum order range (1..5), locid is a shop."),
        page: z.number().int().min(1).optional().default(1).describe("Results page (20 rows per page)."),
        limit: z.number().int().min(1).max(10).optional().default(10).describe("Maximum candidates to return."),
      },
    },
    (input) => runTool(() => searchChipDipParametric(input)),
  );
  server.registerTool(
    "search_promelec_parametric",
    {
      title: "Parametric search on Promelec catalog page",
      description:
        "Parametric (by-parameters) search on Promelec catalog groups (https://www.promelec.ru/catalog/<gr>/<sub>/?brand=...&body3=...&instock=1&smartFilter=0). Runs ONLY on explicit demand. Pass a free-text component_type (e.g. «полевой транзистор MOSFET») instead of category and the category is resolved automatically. Call without filters to receive available brand/body3 values with IDs. If the exact filter combination yields no results (the site answers HTTP 404 on an empty listing or count = 0), the tool reports exact_match total_matches=0 and automatically retries with fewer parameters (dropping them one by one from the end, up to 4 attempts), returning the relaxed results in candidates along with applied_filters/dropped_filters. One public HTML page per request, at least five seconds between Promelec requests, stops on CAPTCHA or HTTP 429.",
      inputSchema: {
        category: z.string().min(1).max(200).optional().describe("Promelec category path or full URL, for example 4/216 (Полевые транзисторы) or https://www.promelec.ru/catalog/4/216/. Omit to resolve automatically from component_type."),
        component_type: z.string().max(200).optional().describe("Text description of the component to resolve the category automatically, for example «полевой транзистор MOSFET» or «керамический конденсатор». Ignored when category is given."),
        filters: z.record(z.string(), z.string()).optional().describe("Filter name/value pairs, for example {\"brand\": \"583;3938\", \"body3\": \"1\", \"instock\": \"1\"}. brand/body3 IDs come from the page (see available_filters); numeric characteristics use param-<id>-from / param-<id>-to."),
        page: z.number().int().min(1).optional().default(1).describe("Results page (20 rows per page)."),
        limit: z.number().int().min(1).max(10).optional().default(10).describe("Maximum candidates to return."),
      },
    },
    (input) => runTool(() => searchPromelecParametric(input)),
  );
  server.registerTool(
    "search_electronshik_parametric",
    {
      title: "Parametric search on Electronshik catalog",
      description:
        "Parametric (by-parameters) search on Electronshik catalog subsections (https://www.electronshik.ru/catalog/<slug>). Runs ONLY on explicit demand. Pass a free-text component_type (e.g. «керамический конденсатор SMD») instead of category and the category is resolved automatically. Filters are applied by POST and the filtered list is returned directly in the POST response (numerics in base units, e.g. «10 мкФ» for capacitance, «50 В» for voltage). Call without filters to receive available filter fields (kpd_d* numeric, kpd_t* lists). If the exact filter combination yields no results (Найдено: 0), the tool reports exact_match total_matches=0 and automatically retries with fewer parameters (dropping them one by one from the end, up to 4 attempts), returning the relaxed results in candidates along with applied_filters/dropped_filters. One to two public requests per query, at least five seconds between Electronshik requests.",
      inputSchema: {
        category: z.string().min(1).max(120).optional().describe("Electronshik catalog subsection slug, for example kondensatory-keramicheskie. Omit to resolve automatically from component_type."),
        component_type: z.string().max(200).optional().describe("Text description of the component to resolve the category automatically, for example «керамический конденсатор SMD» or «чип резистор». Ignored when category is given."),
        filters: z.record(z.string(), z.string()).optional().describe("Filter field/value pairs, for example {\"kpd_d2\": \"50 В\", \"kpd_t4\": \"0805\"}. Values as shown on the site."),
        node: z.string().min(1).max(30).optional().describe("Section node ID from the page (optional; discovered automatically when omitted)."),
        page: z.number().int().min(1).optional().default(1).describe("Results page."),
        limit: z.number().int().min(1).max(10).optional().default(10).describe("Maximum candidates to return."),
      },
    },
    (input) => runTool(() => searchElectronshikParametric(input)),
  );
  server.registerTool(
    "search_platan_parametric",
    {
      title: "Parametric search on Platan catalog",
      description:
        "Parametric (by-parameters) search on Platan catalog subsections (https://www.platan.ru/shop/<id>?p_<type>_<slot>_<paramId>=<value>&sh=0). Runs ONLY on explicit demand. Pass a free-text component_type (e.g. «чип резистор 0805», «конденсатор электролитический SMD») instead of category_id and the category is resolved automatically. Pass filters (parameter title or p_<type>_<slot>_<id> name → value; several values of one parameter separated by ; work as OR) or the legacy parameter/value pair. Multiple different parameters are combined in ONE request (e.g. p_2_0_3701=470&p_2_0_3708=6.3). Cyrillic values are encoded in windows-1251. Call without filters to receive the available parameters of the category. If the exact filter combination yields no results (the site answers HTTP 404 on an empty listing), the tool reports exact_match total_matches=0 and automatically retries with fewer parameters (dropping them one by one from the end, up to 4 attempts), returning the relaxed results in candidates along with applied_filters/dropped_filters.",
      inputSchema: {
        category_id: z.number().int().min(1).optional().describe("Platan catalog subsection ID, for example 91549 (Конденсаторы электролитические SMD) or 10703 (Резисторы чип SMD). Omit to resolve automatically from component_type."),
        component_type: z.string().max(200).optional().describe("Text description of the component to resolve the category automatically, for example «чип резистор 0805» or «конденсатор электролитический SMD». Ignored when category_id is given."),
        filters: z.record(z.string(), z.string()).optional().describe("Required parameter name/value pairs, for example {\"Емкость (значение), мкФ\": \"470\", \"Диаметр корпуса D,мм\": \"6.3\"} or raw names like {\"p_2_0_3701\": \"470\"}. Several values of one parameter separated by ; work as OR; range parameters (kind=range) accept from-to like \"10-100\"."),
        parameter: z.string().min(1).max(60).optional().describe("Legacy single parameter name (p_1_0_677) or its title (Производитель). Prefer filters instead."),
        value: z.string().min(1).max(200).optional().describe("Legacy single parameter value; several values are separated by ;. Prefer filters instead."),
        sort: z.number().int().min(1).max(20).optional().describe("Platan sort code, for example 12 = cheapest first."),
        page: z.number().int().min(1).optional().default(1).describe("Results page (36 rows per page)."),
        limit: z.number().int().min(1).max(10).optional().default(10).describe("Maximum candidates to return."),
      },
    },
    (input) => runTool(() => searchPlatanParametric(input)),
  );
  server.registerTool(
    "search_berelcom_parametric",
    {
      title: "Parametric search on Berelcom catalog (local filtering)",
      description:
        "Parametric (by-parameters) search on Berelcom catalog sections (https://shop.berelcom.ru/map/). Runs ONLY on explicit demand and is never used by the unified search. The site has no server-side parametric search, so the catalog section is parsed from public HTML pages (/catalog/<id>/ with count=100, up to 3 pages) and the filters are applied locally to the parsed titles and descriptions (unit spellings are matched in both Russian and English, e.g. мкФ/mkF, В/V, кОм/kOhm). Pass a free-text component_type (e.g. «керамический конденсатор 0805», «чип резистор 0603») instead of category and the section is resolved automatically from the catalog map (/map/). If no candidate satisfies every requirement, the tool returns candidates ranked by the number of matched requirements with unmet_requirements. One public HTML page per request, at least five seconds between Berelcom requests, stops on CAPTCHA or HTTP 429.",
      inputSchema: {
        category: z.string().min(1).max(200).optional().describe("Berelcom catalog section path or full URL, for example 3300000/3301000 (Керамические) or https://shop.berelcom.ru/catalog/3300000/3301000/. Omit to resolve automatically from component_type."),
        component_type: z.string().max(200).optional().describe("Text description of the component to resolve the catalog section automatically from /map/, for example «керамический конденсатор 0805» or «чип резистор». Ignored when category is given."),
        filters: z.record(z.string(), z.string()).optional().describe("Filter name/value pairs, for example {\"Емкость\": \"1 мкФ\", \"Напряжение\": \"16 В\", \"Температура\": \"X7R\", \"Допуск\": \"10%\", \"Корпус\": \"0805\"}. Applied locally to the parsed product titles/descriptions."),
        manufacturer: z.string().min(1).max(120).optional().describe("Required manufacturer name or a distinctive substring."),
        quantity: z.number().int().positive().optional().describe("Minimum immediately available quantity."),
        in_stock_only: z.boolean().optional().describe("Require a positive available quantity."),
        rohs_only: z.boolean().optional().describe("Require a RoHS-compliant result (detected from the product card text)."),
        page: z.number().int().min(1).optional().default(1).describe("First catalog page to parse (100 products per page; up to 3 pages total)."),
        limit: z.number().int().min(1).max(10).optional().default(10).describe("Maximum candidates to return."),
      },
    },
    (input) => runTool(() => searchBerelcomParametric(input)),
  );
  server.registerTool(
    "search_digikey_parametric",
    {
      title: "Parametric search on DigiKey API",
      description:
        "Parametric (by-parameters) search on the DigiKey Product Information API. Runs ONLY on explicit demand. Uses the official API: first a keyword request reads the available server-side parametric filters, then the search is repeated with ParameterFilterRequest when the requested parameter/value pairs are found. Otherwise falls back to client-side ranking of the keyword results. Requires DIGIKEY_CLIENT_ID/DIGIKEY_CLIENT_SECRET.",
      inputSchema: {
        ...searchInputSchema,
        site: z.string().length(2).optional().describe("DigiKey site code, for example US, DE, or JP."),
        currency: z.string().length(3).optional().describe("Currency code for displayed catalog pricing, for example USD or EUR."),
      },
    },
    (input) => runTool(() => searchDigiKeyParametric(input)),
  );
  server.registerTool(
    "search_mouser_parametric",
    {
      title: "Parametric search on Mouser API",
      description:
        "Parametric (by-parameters) search on the Mouser Search API. Runs ONLY on explicit demand. The API supports only keyword + InStock/RoHS, so the requested filters are applied client-side to the keyword results (ranked matching). Requires MOUSER_API_KEY.",
      inputSchema: searchInputSchema,
    },
    (input) => runTool(() => searchMouserParametric(input)),
  );
  server.registerTool(
    "search_lcsc_parametric",
    {
      title: "Parametric search on LCSC API",
      description:
        "Parametric (by-parameters) search on the LCSC Open API. Runs ONLY on explicit demand. The API supports only keyword/category search, so the requested filters are applied client-side to the keyword results (ranked matching). Requires approved LCSC API credentials.",
      inputSchema: {
        ...searchInputSchema,
        currency: z.string().length(3).optional().describe("LCSC price currency: USD, EUR, CNY, or HKD."),
      },
    },
    (input) => runTool(() => searchLcscParametric(input)),
  );
}

function registerLcscTools(server) {
  server.registerTool(
    "search_lcsc_components",
    {
      title: "Search LCSC components",
      description:
        "Search LCSC's official KeywordSearch API with live LCSC retail availability and price breaks. Requires approved LCSC API credentials and IP allowlisting. Returned filters are verified against API response fields.",
      inputSchema: {
        ...searchInputSchema,
        currency: z.string().length(3).optional().describe("LCSC price currency: USD, EUR, CNY, or HKD."),
      },
    },
    (input) => runTool(() => searchLcsc(input)),
  );
  server.registerTool(
    "get_lcsc_component_details",
    {
      title: "Get LCSC component details",
      description:
        "Retrieve product, availability, pricing, and datasheet information from LCSC's official KeywordSearch API for an LCSC C-code or manufacturer part number. Requires approved LCSC API credentials.",
      inputSchema: {
        part_number: z.string().min(1).max(120),
        currency: z.string().length(3).optional(),
      },
    },
    (input) => runTool(() => lcscDetails(input)),
  );
  server.registerTool(
    "search_lcsc_public_components",
    {
      title: "Search LCSC public site without API",
      description:
        "Search LCSC by keyword, manufacturer part number (MPN), or C-code through the same public search backends that the lcsc.com website uses in the browser. No API, credentials, cookies, login, crawling, or retries are used; one explicitly requested query per call (one or two backend requests, exactly like the lcsc.com search page performs), at least five seconds between LCSC public requests, and the server stops on CAPTCHA or HTTP 429. Exact MPN/C-code matches return full C-codes, price breaks, live stock, and datasheet URLs; keyword matches additionally fall back to the same 'Verified Third-party Channels' list the site shows for such queries. These backends are not an official API and may change; for bulk or commercial use prefer the official LCSC API tools.",
      inputSchema: {
        query: z.string().min(2).max(120).describe("Explicit user-requested keyword, manufacturer part number (e.g. AP63203WU-7), or LCSC C-code (e.g. C780769)."),
        limit: z.number().int().min(1).max(10).optional().default(10).describe("Maximum rows to return from one page."),
        page: z.number().int().min(1).optional().default(1).describe("Results page."),
        page_size: z.number().int().min(1).max(100).optional().default(25).describe("Results per page requested from the backend."),
        in_stock_only: z.boolean().optional().default(false).describe("Show only in-stock products."),
        rohs_only: z.boolean().optional().default(false).describe("Show only RoHS-certified products."),
        deals_only: z.boolean().optional().default(false).describe("Show only discounted/deal products."),
        asian_brand_only: z.boolean().optional().default(false).describe("Show only Asian domestic alternatives."),
        include_third_party: z.boolean().optional().default(true).describe("When the main backend returns fewer rows than limit, additionally query the 'Verified Third-party Channels' list that the lcsc.com search page shows for this query. Set false to use only exact MPN/C-code matches."),
        brand_ids: z.array(z.number().int().min(1)).max(20).optional().describe("LCSC internal brand IDs to restrict results (e.g. 296 = DIODES). Omit to search all brands."),
        catalog_ids: z.array(z.number().int().min(1)).max(20).optional().describe("LCSC internal catalog IDs to restrict results (e.g. 17 = Integrated Circuits). Omit to search all categories."),
        sort_field: z.string().regex(/^[A-Za-z0-9_]{1,32}$/).optional().describe("Backend sort field passed through as-is; omit for default relevance."),
        sort_type: z.enum(["asc", "desc"]).optional().describe("Sort direction; used only together with sort_field."),
      },
    },
    (input) => runTool(() => searchLcscPublic(input)),
  );
  server.registerTool(
    "get_lcsc_public_component_details",
    {
      title: "Get LCSC public product page details",
      description:
        "Fetch and parse one user-authorized public LCSC product page (https://www.lcsc.com/product-detail/C<code>.html) by C-code. Returns the page's embedded structured data: MPN, manufacturer, category, description, price, stock, and parameters. No API, credentials, cookies, login, crawling, or retries are used; at least five seconds between LCSC public requests; stops on CAPTCHA or HTTP 429. Only C-codes are resolvable without the official API. Prefer the official get_lcsc_component_details when credentials are configured.",
      inputSchema: {
        part_number: z.string().min(2).max(40).describe("LCSC C-code, for example C780769."),
      },
    },
    (input) => runTool(() => lcscPublicDetails(input)),
  );
}

function registerJlcpcbTools(server) {
  server.registerTool(
    "get_jlcpcb_component_details",
    {
      title: "Get JLCPCB assembly component details",
      description:
        "Call JLCPCB's official Components API for authoritative assembly stock, pricing, and specifications of one or more LCSC C-codes. Requires approved JLCPCB API credentials.",
      inputSchema: {
        lcsc_codes: z.array(z.string().min(2).max(40)).min(1).max(50).describe("LCSC component codes, for example ['C17976', 'C1337']."),
      },
    },
    (input) => runTool(() => jlcpcbComponentDetails(input)),
  );
  server.registerTool(
    "list_jlcpcb_component_library",
    {
      title: "List JLCPCB assembly component library",
      description:
        "Browse JLCPCB's official assembly component library. The official API is paginated and does not offer keyword filtering; use LCSC search to find a C-code before requesting authoritative JLCPCB details.",
      inputSchema: {
        page: z.number().int().min(1).optional().default(1),
        page_size: z.number().int().min(1).max(100).optional().default(30),
      },
    },
    (input) => runTool(() => jlcpcbComponentLibrary(input)),
  );
}

const server = new McpServer({
  name: "Electronics Parts",
  version: "2.15.0",
});

registerElectronicsPartsTools(server);
registerDigiKeyTools(server);
registerMouserTools(server);
registerPublicCatalogTools(server);
registerParametricTools(server);
registerLcscTools(server);
registerJlcpcbTools(server);

await server.connect(new StdioServerTransport());
