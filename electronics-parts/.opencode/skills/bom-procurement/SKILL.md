---
name: bom-procurement
description: Calculate a procurement plan for an electronics BOM and production quantity using Russian supplier offers, MOQ, order multiples, price breaks and deadline. Supports cheapest, fastest and balanced modes and persists results in SQLite.
compatibility: OpenCode with electronics-parts MCP and sqlite-memory MCP
metadata:
  mvp: "true"
---

# BOM Procurement

## Goal

Answer: **Where should each BOM line be purchased for this production quantity under the chosen priority?**

## Язык

Все уточнения пользователю и итоговый отчёт — на русском языке. MPN, валюта, URL и машинные статусы сохраняются как в источнике, но при первом упоминании получают русское пояснение.

## Inputs

- existing `bom_id` or a BOM that must first be persisted;
- `production_quantity`;
- mode: `CHEAPEST` (default), `FASTEST`, or `BALANCED`;
- optional `deadline_days`.

## Preconditions

Run the availability workflow logic first or ensure recent offers exist. If critical lines are `NOT_FOUND/UNKNOWN`, procurement may still be calculated for the remaining lines but must be labeled incomplete.

Use current `offer_snapshots` when available. Keep price tiers belonging to one supplier offer together and retain whether stock is local, partner, order-only or unknown.

## Calculation rules

For each line:

1. `required_qty = qty_per_unit * production_quantity`.
2. Candidate offer must cover the requirement via confirmed stock or an explicit order route compatible with the selected mode/deadline.
3. `order_qty = max(required_qty, MOQ)`.
4. If `order_multiple` is known, round `order_qty` upward to the next valid multiple.
5. Choose the price break whose minimum quantity is <= `order_qty` and that is the best valid tier for the offer.
6. `line_total = order_qty * unit_price`.
7. Rank:
   - `CHEAPEST`: minimum line total;
   - `FASTEST`: minimum lead time, then total;
   - `BALANCED`: offers meeting deadline first, then line total; without deadline, prefer in-stock/short lead time then total.

8. Compare totals only within one currency. Do not silently mix RUB, USD, CNY or EUR. If a conversion is necessary, obtain and persist an explicit FX snapshot; otherwise return separate totals by currency.

## MVP limitation

Do **not** invent shipping costs, customs costs, payment fees or global supplier consolidation savings. If shipping cost is unavailable, state: `component_total excludes delivery`.

Do not claim global mathematical optimum across suppliers in MVP; it is a per-line procurement plan.

## Persistence

Call `sqlite-memory.save_procurement_run` with the selected items, offer IDs and a single declared currency. Then save a short `BOM_PROCUREMENT` record through `save_search_run` for history/debugging.

## Output

Show:
- component total;
- number of suppliers;
- unavailable lines;
- selected mode;
- disclaimer about delivery if unknown.
- currency and whether any FX conversion was used.

Then table:
`MPN | required | order | supplier | unit price | line total | lead time | note`.

Also identify 3–5 largest cost contributors when useful.
