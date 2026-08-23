---
name: bom-availability
description: Analyze an electronics BOM for a requested production quantity and determine which exact MPNs are available in Russia, partially available, order-only, or not found. Persist the normalized BOM and offer snapshots in SQLite.
compatibility: OpenCode with electronics-parts MCP and sqlite-memory MCP
metadata:
  mvp: "true"
---

# BOM Availability

## Goal

Answer: **Can this BOM be fully sourced for the requested production quantity, and which lines block the build?**

## Язык

Все уточнения пользователю и итоговый отчёт — на русском языке. MPN, URL и машинные статусы сохраняются как в источнике, но при первом упоминании получают русское пояснение.

## Inputs

- BOM file/table or existing `bom_id`;
- `production_quantity` > 0;
- optional deadline.

Minimum BOM columns: exact MPN + quantity per unit. Reference designators are optional.

## Workflow

1. Parse the BOM into normalized items: `mpn`, `qty_per_unit`, optional `reference`, `notes`.
2. Do not guess an MPN from a vague description. Put unresolved rows into `INVALID_BOM_ROW`.
3. Persist a new normalized BOM with `sqlite-memory.create_bom` unless an existing `bom_id` is explicitly used.
4. For each valid row calculate `required_qty = qty_per_unit * production_quantity`.
5. For each MPN:
   - read recent SQLite offers;
   - refresh through `electronics-parts` if missing/stale/insufficient;
   - store fresh offers.
6. Classify each BOM line:
   - `AVAILABLE`: at least one eligible offer can cover required quantity within known constraints;
   - `PARTIAL`: confirmed quantities exist but are below required quantity;
   - `ORDER_ONLY`: supplier declares order/lead-time path but no current stock sufficient;
   - `NOT_FOUND`: no relevant offer returned by queried sources;
   - `UNKNOWN`: source errors or insufficient evidence prevent a reliable conclusion;
   - `INVALID_BOM_ROW`: no exact MPN/quantity.
7. Distinguish `NOT_FOUND` from `UNKNOWN`: network/API/site failure is not absence.
8. Summarize blockers ordered by severity.
9. Save `BOM_AVAILABILITY` run.

## Output

Start with:
- BOM line count;
- production quantity;
- whether the BOM is fully sourceable under known data;
- counts by status.

Then show blocker lines with:
`MPN | required | best known quantity/route | status | best supplier | lead time`.

Mention data freshness and sources that failed.

## Quality rules

- Required quantity arithmetic must be exact.
- Do not merge different MPN suffixes unless the user explicitly accepts equivalence.
- Do not invoke replacement automatically; offer/use `component-replacement` only when requested or when the user asks to solve blockers.
