# План реализации

## Этап 0. Зафиксировать baseline существующего electronics-parts MCP

Цель: не ломать работающий поиск при добавлении нового слоя.

- Зафиксировать версию `server.mjs`/Git commit.
- Составить 10 эталонных MPN разных типов.
- Для каждого сохранить фактическую структуру ответа MCP.
- Проверить наличие полей: supplier, stock, MOQ, lead time, price breaks, URL/идентификатор товара.

Готово, когда: один и тот же набор тестов можно прогонять после каждой доработки.

## Этап 1. SQLite

1. Создать БД по `db/schema.sql`.
2. Поднять `sqlite-memory` MCP.
3. Проверить CRUD:
   - project;
   - BOM;
   - bom_items;
   - offers;
   - search_runs;
   - replacements.
4. Добавить timestamp и индексы.

Готово, когда: агент может создать проект, сохранить BOM и затем восстановить его в новой сессии.

## Этап 2. Skill `ru-part-search`

Реализовать первый end-to-end сценарий.

Критерии:
- понимает MPN и количество;
- отличает «есть 3 шт» от «нужно 20 шт»;
- учитывает MOQ;
- корректно применяет price break для требуемого/заказываемого количества;
- не смешивает наличие и срок поставки;
- записывает offer snapshots;
- выводит `cheapest`, `fastest`, `balanced`.

Готово, когда: проходит тесты PS-01..PS-06.

## Этап 3. Skill `bom-availability`

1. Поддержать CSV/XLSX через возможности агента/локальный конвертер.
2. Нормализовать обязательные поля: MPN, qty_per_unit, reference(optional).
3. Вычислять required qty по тиражу.
4. Сохранять BOM в SQLite.
5. Использовать свежие offers либо обновлять через Parts MCP.
6. Выдавать blockers.

Готово, когда: проходит BA-01..BA-06.

## Этап 4. Skill `bom-procurement`

1. Использовать сохраненный BOM и offers.
2. Реализовать price-break calculation.
3. Реализовать MOQ/order_qty.
4. Режимы CHEAPEST / FASTEST / BALANCED.
5. Не считать доставку, если она неизвестна; явно показывать это ограничение.
6. Сохранять procurement run в `search_runs` и `procurement_runs`.

Готово, когда: проходит BP-01..BP-06.

## Этап 5. Skill `component-replacement`

1. Получить исходную спецификацию из MCP/даташита.
2. Извлечь hard/soft requirements.
3. Получить кандидатов через parametric tools.
4. Разрешить LLM предложить дополнительные MPN только как hypotheses.
5. Проверить top candidates.
6. Ввести provenance/status для каждого критического поля.
7. Сохранить application context, hard/soft requirements и search coverage в `replacement_runs`.
8. Классифицировать `EXACT_DROP_IN` / `QUALIFIED_DROP_IN` / `CIRCUIT_COMPATIBLE` / `FOOTPRINT_COMPATIBLE` / `FUNCTIONAL_ALTERNATIVE` / `REDESIGN_ALTERNATIVE` / `REJECTED` / `UNVERIFIED`.
9. Проверить закупочную доступность выбранных кандидатов в РФ.
10. Сохранить append-only result в `replacement_assessments` и `replacement_evidence_v2`.

Готово, когда: проходит CR-01..CR-10 и SQLite MCP отклоняет `EXACT_DROP_IN` / `QUALIFIED_DROP_IN` при непроверенном package, pinout, PCB или hard requirement.

## Этап 6. Regression pack

- Минимум 25 приемочных тестов из `tests/test-cases.yaml`.
- Отдельно negative tests: нулевое наличие, MOQ выше потребности, конфликтующий MPN, неизвестный pinout, устаревший cache.
- После любого изменения MCP/skill прогонять весь набор.

## Этап 7. Критерии готовности

Систему можно показывать внешним пользователям, если:

- PART_SEARCH: >= 95% тестов без критических ошибок;
- BOM_AVAILABILITY: 100% корректная арифметика количества;
- BOM_PROCUREMENT: 100% корректная арифметика MOQ/price-break на тестовом наборе;
- REPLACEMENT: 0 ложных `EXACT_DROP_IN` / `QUALIFIED_DROP_IN` в тестах;
- во всех ответах отображается свежесть коммерческих данных;
- ошибки/недоступность одного источника не превращаются в утверждение «компонента нигде нет».
