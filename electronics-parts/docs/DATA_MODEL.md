# Модель данных SQLite

## Главный принцип

SQLite — не «память обо всем разговоре». В нее записываются предметные факты и результаты, которые полезны между сессиями.

## Сущности

### projects
Проекты пользователя.

### parts
Нормализованные MPN, встречавшиеся в запросах/BOM.

### boms / bom_items
Версии BOM и количество на одно изделие.

### offers
Снимки коммерческих предложений. Одна строка = один offer в конкретный момент.

### search_runs
История пользовательских операций и короткий итог.

### replacements / replacement_evidence
Legacy-таблицы для совместимости с ранней моделью данных. Их нельзя использовать для новых исследований: обновление пары original/candidate заменяет старый набор evidence.

### application_profiles / replacement_runs / replacement_assessments / replacement_evidence_v2
Append-only модель v2: профиль реального применения, snapshot hard/soft requirements и search coverage, затем отдельная оценка кандидата и evidence с source type, locator, revision и `checked_at`.

### offer_snapshots / offer_price_tiers
Снимок одного supplier offer и его ценовых ступеней. `stock_type` отделяет local/partner/order/unknown, а price tiers больше не смешиваются между предложениями.

### procurement_runs / procurement_items
Результат расчета закупки для конкретного BOM/тиража/режима.

## Правила

1. `offers` никогда не обновлять «на месте» как единственную запись — сохранять snapshots.
2. Точное время `checked_at` обязательно.
3. Денежные значения хранить как decimal-like INTEGER в копейках/центах либо REAL в текущей реализации; для production перейти на integer minor units.
4. Не считать `lead_time_text` числом без явной нормализации; хранить и text, и `lead_time_days` nullable.
5. Для replacement сохранять источник, тип источника, locator, `checked_at` и verification status каждого критического вывода.
6. `EXACT_DROP_IN` / `QUALIFIED_DROP_IN` можно сохранять только при проверенной matrix package + pinout + PCB + hard constraints.
7. Нельзя суммировать procurement totals в разных валютах без отдельно сохранённого FX snapshot.
6. Raw JSON ограничивать диагностикой; UI/skills должны работать по нормализованным полям.
