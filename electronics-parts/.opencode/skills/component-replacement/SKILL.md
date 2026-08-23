---
name: component-replacement
description: Find and evaluate replacement candidates for an electronic component. Use MCP/catalog/datasheet facts to verify hard electrical constraints, package and pinout; LLM knowledge may generate hypotheses but cannot by itself prove compatibility. Also check Russian availability of viable candidates.
compatibility: OpenCode with electronics-parts MCP and sqlite-memory MCP
metadata:
  mvp: "true"
---

# Component Replacement

## Goal

Produce an auditable engineering decision, not a catalogue of similar parts. Keep four independent conclusions separate:

1. electrical compatibility;
2. PCB and external-circuit compatibility;
3. qualification and true second-source status;
4. current procurement availability in Russia.

## Language

All communication with the user and the final report must be in Russian. Keep MPNs, URLs and machine-readable status codes unchanged, but explain each status in Russian on first use.

Do not leave English sentences in the report. For example, write `В проверенных источниках не найден независимый подтверждённый кандидат`, not `No verified candidate was found in the searched sources`.

## Non-negotiable rules

- **LLM knowledge can generate a hypothesis but is never evidence.**
- Engineering facts come from sources in this order: manufacturer datasheet, manufacturer page, authorised distributor, distributor catalogue, aggregator. A distributor offer may verify price/MOQ/lead time, not pinout or VIN limits.
- State `UNVERIFIED` or `CONFLICT` rather than filling a gap from memory.
- Never claim `same die`, `тот же кристалл` or an equivalent statement unless the manufacturer explicitly says so. `Same family`, electrical compatibility or an automotive version are not proof of an identical die.
- `Second source` describes supply-chain independence: a different manufacturer is sufficient; do not make any claim about whether the silicon die is different. For the same manufacturer, report `NO_SAME_MANUFACTURER` even when the candidate is electrically preferable.
- Never claim that an analogue does not exist. Say: `No verified candidate was found in the searched sources` and retain search coverage.
- `EXACT_DROP_IN` and `QUALIFIED_DROP_IN` require `VERIFIED` electrical, package, pinout and PCB assessments, plus one verified evidence item for `package`, `pinout` and every hard requirement. The SQLite MCP enforces this.
- Do not use a numeric confidence score. Report evidence completeness and missing checks.

### Provenance is not compatibility

`VERIFIED`, `INFERRED`, `UNVERIFIED` and `CONFLICT` describe the quality of evidence, not whether a candidate matches the reference.

Use two separate fields in the report and evidence:

```text
Распиновка: VERIFIED — FAIL (назначение выводов отличается)
VIN max:     VERIFIED — FAIL (28 В < требуемых 32 В)
PCB:         INFERRED — REQUIRES_CHANGE
```

Use `CONFLICT` only when relevant reliable sources contradict each other. A datasheet-proven difference from the reference part is `VERIFIED — FAIL`, never `CONFLICT`.

## Workflow

### A. Recover history and create a run

1. Call `sqlite-memory.get_replacements(original_mpn)` only as legacy context.
2. If an application profile already exists, call `get_application_profile`; otherwise create one with `create_application_profile` when the user supplied reusable project constraints.
3. Call `start_replacement_run` before candidate evaluation. Store the actual application context, hard constraints, soft preferences and searched sources.

Application context must distinguish component capability from project need. Capture what is known:

```yaml
vin_min:  # recommended operating condition, not only absolute maximum
vin_max:
vin_transient_max:
vout:
load_nominal:
load_peak:
ambient_min:
ambient_max:
pcb_change_allowed: false
```

Unknown values remain explicitly unknown; they do not block screening.

Do not turn the reference part's maximum rating into an application hard constraint automatically. For example, `AP63203 VIN max = 32 V` does not reject a 28 V candidate until the application profile establishes `vin_max` or `vin_transient_max > 28 V` as a hard requirement.

### B. Define requirements

Query the original MPN and source links through `electronics-parts`. Separate:

- **hard constraints:** topology/function, required operating limits, output/load, safety-critical interfaces, package/pinout and unchanged external circuit when drop-in is requested;
- **soft preferences:** price, preferred supplier, low IQ, size, qualification, efficiency and availability.

For switch-mode converters also compare frequency/mode, Vref, compensation, bootstrap, inductor requirements, thermal limits and EMI features. Package name and pin count alone do not verify a land pattern or exposed-pad compatibility.

For MOSFETs and other switching semiconductors, compare RDS(on), Qg, SOA, avalanche capability and current ratings only at equivalent test conditions. Never present `maximum` versus `typical` values as a direct numerical comparison; state the guarantee type and VGS/ID/VDS/test conditions. The actual gate-driver voltage, switching frequency, load current and transient energy are application constraints, not assumed facts.

`PCB = VERIFIED` is permitted only after all of the following are checked against project evidence: schematic/net functions, the existing PCB footprint or land pattern, and the external BOM/placement needed by the candidate. Record this as `source_type: OTHER`, `source_name: PROJECT_SCHEMATIC` or `PROJECT_PCB_LAYOUT`, and store a file path/revision in `source_locator`. A manufacturer datasheet alone supports at most `PCB = INFERRED`.

Verify pinout in two directions: the candidate's manufacturer document and the reference component's manufacturer document or the project schematic/PCB. If only the candidate pinout is verified while the reference mapping is inferred, report `reference pinout: INFERRED`; do not say that the parts' pinout is confirmed compatible and do not qualify the candidate as drop-in.

### C. Discover then verify

1. Use parametric MCP search, prior research and only then LLM hypotheses.
2. Hard-filter the candidate pool; screen 5–10 candidates and fully verify only the best 3–5.
3. Record one evidence item for every critical comparison with source type, URL, page/section, revision when available and check timestamp.

Use `VERIFIED`, `INFERRED`, `UNVERIFIED` or `CONFLICT` per evidence item.

### D. Classify

- `EXACT_DROP_IN` — PCB, external BOM, firmware/configuration and operating limits unchanged.
- `QUALIFIED_DROP_IN` — same as exact drop-in, with qualification changed or improved; it may still be the same manufacturer.
- `CIRCUIT_COMPATIBLE` — footprint/pinout fit, but passive values or external circuit must change.
- `FOOTPRINT_COMPATIBLE` — physical land pattern fits but pin functions or electrical behaviour do not.
- `FUNCTIONAL_ALTERNATIVE` — solves the same function with a new schematic/PCB.
- `REDESIGN_ALTERNATIVE` — different package/topology or meaningful redesign.
- `REJECTED` — fails a hard requirement; record machine-readable reason in evidence.
- `UNVERIFIED` — evidence is insufficient to classify safely.

A candidate whose manufacturer datasheet has not been read remains `UNVERIFIED`, even if a distributor catalogue suggests that it could be a redesign alternative.

Do not call a candidate `без изменений схемы`, `прямая замена` or equivalent unless the reference pinout, external circuit and project PCB have all been verified. Before then use: `кандидат без предполагаемых изменений схемы; ожидает проверки`.

Record `second_source_status` separately. A same-manufacturer automotive version can be a `QUALIFIED_DROP_IN` and still be `NO_SAME_MANUFACTURER` as a supply-chain second source.

### E. Check procurement last

Only for non-rejected candidates, use the part-search workflow for the requested quantity. Store fresh offers with timestamp, source and stock type. Keep technical compatibility and procurement ranking separate.

### F. Persist and conclude

For each candidate call `save_replacement_assessment`, then call `complete_replacement_run`. Also save the short `PART_REPLACEMENT` search run. Do not use the legacy `save_replacement` tool for new research.

## Output

The default report is a decision document, not an audit protocol. Put the detailed verification matrix, all source URLs, complete offer snapshots and every rejected candidate into SQLite; show them in the reply only when the user asks for `подробности`, `доказательства`, `все кандидаты` or an audit-ready report.

Use exactly these three short Russian blocks by default.

### 1. `## Решение`

Limit this block to 5–7 short lines:

- reference MPN and the recommended action;
- the best candidate and its practical outcome;
- independent second source, or `В проверенных источниках независимый второй источник не найден`;
- one sentence that names the condition able to change the recommendation.

Do not repeat the same conclusion in a separate context, condition and candidate section.

When a candidate is electrically/package compatible but the project PCB was not inspected, write:

> **Технически совместим; ожидает проверки проектной PCB.**

Do not lead with the machine label `UNVERIFIED`; retain it in the persisted evidence. State that the candidate becomes `QUALIFIED_DROP_IN` only after the named PCB check. This does not relax the SQLite safety gate.

When the candidate is promising but reference pinout, project PCB or application conditions remain open, call it **`Рекомендован к квалификации`**. Do not call it an approved replacement or `QUALIFIED_DROP_IN` until those checks are closed.

### 2. `## Варианты и условия`

Show one compact table with at most four candidates and only these columns:

`Вариант | Решение | Что требуется сделать`.

Include only: the recommended candidate, a conditional independent option, a circuit-change fallback if useful, and one redesign option if relevant. Do not print a verification matrix, raw status codes, all risks or identical technical parameters here.

Describe only the delta from the reference part. For example: `нужен FB-делитель и пересчёт дросселя`, not a restatement of every electrical value from the datasheet.

For a switching-semiconductor delta, include the relevant conditions or say that conditions are not comparable. Example: `Qg может быть выше; в источниках приведены max и typ, требуется сравнение при одинаковом VGS/ID`.

### 3. `## Важно проверить`

List no more than three unresolved items that can change the recommendation, ordered by impact. Examples: maximum/transient VIN of the application, project footprint/PCB, or an unread manufacturer datasheet.

If all important conditions are closed, omit this block.

### Procurement in the default report

For the recommended candidate and, when material, the independent option, give one compact current procurement sentence: supplier, practical availability/lead time, price condition and exact `checked_at`. Do not print long URLs, stock-type codes or every supplier by default. Keep the URL, stock type, MOQ, price tiers and full timestamp in SQLite evidence and provide them on request.

### Detailed / audit report

Only on request, add `## Доказательства` with the verification matrix. There, show comparison result and evidence status separately, source URLs, stock type and all viable/rejected candidates. Include the legend: `VERIFIED — подтверждено источником`, `INFERRED — логический вывод`, `UNVERIFIED — требуется проверка`, `CONFLICT — источники расходятся`.
