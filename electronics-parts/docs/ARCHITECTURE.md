# Архитектура

## 1. Цели

Сервис должен устойчиво выполнять четыре операции:

- `PART_SEARCH` — найти конкретный MPN в РФ для нужного количества и срока;
- `BOM_AVAILABILITY` — проверить, можно ли укомплектовать BOM для заданного тиража;
- `BOM_PROCUREMENT` — подобрать экономичный план закупки;
- `PART_REPLACEMENT` — найти и проверить замену проблемной позиции.

## 2. Минимальная схема

```text
                           +----------------------+
                           |      Пользователь    |
                           +----------+-----------+
                                      |
                                      v
                           +----------------------+
                           |   OpenCode Agent     |
                           | intent + reasoning   |
                           +----------+-----------+
                                      |
                    +-----------------+------------------+
                    |                                    |
                    v                                    v
          +----------------------+             +----------------------+
          | OpenCode Skills      |             | sqlite-memory MCP    |
          | 4 workflow           |             | persistent memory    |
          +----------+-----------+             +----------+-----------+
                     |                                    |
                     v                                    v
          +----------------------+             +----------------------+
          | electronics-parts   |             | SQLite               |
          | MCP                  |             | electronics-parts.db |
          +----------+-----------+             +----------------------+
                     |
      +--------------+-------------------------------+
      |              |             |                 |
      v              v             v                 v
   LCSC/JLCPCB    DigiKey/Mouser   РФ suppliers   datasheet links/data
```

## 3. Границы ответственности

### Agent

Должен:
- определить пользовательскую задачу;
- загрузить подходящий skill;
- разделить hard/soft constraints;
- вызвать MCP в правильной последовательности;
- сравнить результаты;
- объяснить решение;
- не выдавать предположение за проверенный факт.

Не должен:
- считать крупные BOM вручную в естественном языке, если это можно сделать SQL/кодом;
- использовать собственную память модели как единственный источник инженерного параметра для финального вывода о совместимости.

### Skills

Skills — оркестрация и правила качества. Они не содержат рыночные данные и не являются БД.

Каждый skill задает:
- обязательные входные данные;
- последовательность MCP-вызовов;
- правила фильтрации и ранжирования;
- что и когда сохранять в SQLite;
- формат ответа;
- fail-safe поведение.

### electronics-parts MCP

Источник внешних данных:
- MPN и карточки;
- поставщик;
- наличие;
- MOQ;
- lead time;
- price breaks;
- parametric search;
- ссылки/данные datasheet там, где доступны.

MCP не должен принимать бизнес-решение «что купить» или «что является лучшей заменой». Он поставляет факты и кандидатов.

### sqlite-memory MCP

Локальная долговременная память и простой предметный API поверх SQLite.

Минимальные операции:
- проекты;
- BOM и позиции;
- снимки offers;
- история поисков;
- сохраненные replacement-кандидаты и статус проверки.

### SQLite

Хранит только нормализованные данные и историю. Raw payload поставщика допускается хранить как JSON только для диагностики.

## 4. Основные потоки

### 4.1 PART_SEARCH

```text
MPN + qty + deadline
 -> recent cache in SQLite
 -> electronics-parts MCP
 -> normalize offers
 -> quantity/MOQ/deadline filter
 -> rank cheapest / fastest / balanced
 -> save snapshot
 -> answer
```

### 4.2 BOM_AVAILABILITY

```text
BOM + production_qty
 -> normalize BOM
 -> required_qty = qty_per_unit * production_qty
 -> save BOM
 -> for each MPN: recent offers -> MCP refresh if needed
 -> AVAILABLE / PARTIAL / ORDER_ONLY / NOT_FOUND
 -> summary + blockers
```

### 4.3 BOM_PROCUREMENT

Первая версия не решает сложную оптимизацию доставки между поставщиками.

```text
BOM availability data
 -> choose eligible offers
 -> actual_order_qty = max(required_qty, MOQ)
 -> apply correct price break
 -> item_total = actual_order_qty * unit_price
 -> choose cheapest eligible offer per line
 -> total + number of suppliers + unavailable lines
```

Режимы работы:
- `CHEAPEST` — минимум стоимости компонентов;
- `FASTEST` — минимальный срок;
- `BALANCED` — сначала deadline, затем стоимость.

Позже можно добавить стоимость доставки и глобальную оптимизацию числа поставщиков.

### 4.4 PART_REPLACEMENT

```text
original MPN
 -> load known replacement history
 -> obtain source component facts
 -> derive HARD/SOFT requirements
 -> generate candidates: MCP parametric + LLM hypotheses
 -> verify top candidates using source data/datasheets
 -> classify compatibility
 -> verify current RF availability/prices
 -> save candidates + evidence status
 -> answer
```

Классы v2:
- `EXACT_DROP_IN` — PCB, внешняя BOM и режим работы не меняются;
- `QUALIFIED_DROP_IN` — то же, но qualification отличается или лучше;
- `CIRCUIT_COMPATIBLE` — нужны изменения обвязки;
- `FOOTPRINT_COMPATIBLE` — land pattern подходит, но функция выводов или поведение не совпадает;
- `FUNCTIONAL_ALTERNATIVE` / `REDESIGN_ALTERNATIVE` — отдельная схема или PCB;
- `REJECTED` / `UNVERIFIED` — нарушено требование или недостаточно доказательств.

## 5. Provenance и доверие

Каждый критический инженерный факт относится к одному из статусов:

- `VERIFIED` — подтвержден внешним источником/даташитом;
- `INFERRED` — логический вывод из подтвержденных фактов;
- `UNVERIFIED` — гипотеза модели или неполное описание источника;
- `CONFLICT` — источники расходятся.

Для `EXACT_DROP_IN` и `QUALIFIED_DROP_IN` нельзя использовать `UNVERIFIED` по pinout/package/PCB/hard electrical constraints. SQLite MCP проверяет это до сохранения.

## 6. Cache policy

SQLite одновременно играет роль очень простого cache:

- offers сохраняются с `checked_at`;
- skill сначала смотрит свежие снимки;
- TTL задается конфигом/skill, например 15–60 минут для интерактивного поиска;
- при необходимости пользователь может потребовать принудительное обновление.

Важно: cache не должен скрывать возраст данных — в ответе указывать время проверки.

## 7. Что сознательно не входит в проект

- отдельный backend;
- web UI;
- PostgreSQL;
- Redis;
- queue;
- vector DB/RAG framework;
- multi-agent;
- сложный optimizer;
- автоматический заказ;
- автоматическое изменение BOM без явного решения пользователя.

Эти части появляются только после проверки пользовательской ценности четырех базовых workflow.
