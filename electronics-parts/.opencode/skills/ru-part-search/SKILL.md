---
name: ru-part-search
description: Find a specific electronic component by MPN for purchase in Russia, compare real quantity availability, MOQ, price breaks and lead time, and return cheapest, fastest and balanced options. Use for questions like "где купить", "есть ли в РФ", "нужно N штук", or "как быстро привезут".
compatibility: OpenCode with electronics-parts MCP and sqlite-memory MCP
metadata:
  mvp: "true"
---

# RU Part Search

## Goal

Answer the practical procurement question: **where can the requested quantity of this exact MPN be obtained, for how much, and how quickly?**

## Язык

Все уточнения пользователю и итоговый отчёт — на русском языке. MPN, валюта, URL и машинные статусы сохраняются как в источнике, но при первом упоминании получают русское пояснение.

## Required inputs

Extract or ask only if impossible to infer:
- exact `mpn`;
- `quantity` (default 1 if user did not specify);
- optional `deadline_days`;
- optional preference: cheapest / fastest / balanced.

Do not silently substitute a different MPN. If the MPN is ambiguous, report ambiguity.

## Workflow

1. Normalize the MPN (trim spaces, preserve manufacturer suffixes).
2. Call `sqlite-memory.get_recent_offers(mpn, ttl_minutes=30)`.
3. If cached offers are absent, incomplete for the requested quantity, or the user asked for fresh data, query `electronics-parts` sources relevant to Russia.
4. Normalize every candidate offer to:
   - supplier;
   - available quantity;
   - MOQ;
   - order multiple if known;
   - applicable unit price and price-break quantity;
   - lead time days/text;
   - product URL/identifier;
   - checked_at.
5. Save fresh normalized offers with `sqlite-memory.store_offers`.
6. For each offer calculate:
   - `order_qty = max(quantity, MOQ)` and round up to order multiple when known;
   - reject/mark insufficient if confirmed stock < requested quantity and no valid replenishment/lead-time offer exists;
   - select the price break valid for `order_qty`;
   - `line_total = order_qty * unit_price`.
7. Rank separately:
   - **cheapest**: lowest total for an eligible quantity;
   - **fastest**: shortest confirmed/declared lead time;
   - **balanced**: meets deadline first, then lowest total.
8. Never interpret "not returned by one source" as "not available in Russia". Mention failed/unqueried sources.
9. Save a short `PART_SEARCH` record through `save_search_run`.

## Output

Return a compact comparison, then three conclusions when data permits:
- Cheapest;
- Fastest;
- Recommended/balanced.

Always state:
- requested quantity;
- data freshness;
- important MOQ/stock limitation;
- whether prices exclude delivery when delivery is unknown.

## Safety / quality rules

- Do not fabricate stock or lead time.
- Do not compare price-per-piece without accounting for MOQ/order quantity.
- Preserve uncertainty in phrases such as "под заказ" or unparsed lead time.
- This skill searches the exact part. Use `component-replacement` only when the user asks for an alternative/replacement.
