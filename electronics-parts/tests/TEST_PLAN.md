# Test Plan

## 1. Что тестируем

### MCP integration
- Parts MCP returns data without breaking existing tools.
- SQLite MCP persists and restores data across sessions.

### Skill behavior
- правильный выбор workflow;
- арифметика quantities/MOQ/price breaks;
- различие NOT_FOUND и UNKNOWN;
- provenance для replacement;
- сохранение результатов.

## 2. Уровни

### L0 — schema/unit
Проверить SQL schema, constraints, indexes.

### L1 — SQLite MCP
Create project/BOM, store/read offers, store/read replacements.

The executable `sqlite-memory.test.mjs` also verifies two stop-ship invariants: an unverified drop-in is rejected by the MCP server, and a mixed-currency procurement total is rejected without an FX snapshot.

### L2 — deterministic calculations
На fixture-данных вручную известен правильный order_qty/price tier/total.

### L3 — agent acceptance
Запустить OpenCode с skill и stub/real MCP. Сравнить обязательные свойства ответа с `test-cases.yaml`.

### L4 — live supplier smoke
Небольшой набор точных MPN. Не требовать совпадения цены; проверять структуру, timestamp и отсутствие выдуманных данных.

## 3. Stop-ship ошибки

Систему нельзя показывать внешним пользователям при любом из условий:
- insufficient stock назван достаточным;
- использована неверная price tier;
- BOM quantity посчитана неверно;
- источник упал, а ответ утверждает `нет в РФ`;
- replacement помечен `EXACT_DROP_IN` / `QUALIFIED_DROP_IN` без подтвержденных pinout/package/PCB/hard constraints;
- LLM-известный параметр выдан как проверенный без источника.

## 4. Регрессия

После изменения MCP/skill прогонять минимум:
PS-01..PS-06, BA-01..BA-06, BP-01..BP-06, CR-01..CR-08.
