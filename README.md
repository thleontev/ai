# Коллекция AI инструментов

Коллекция локальных инструментов для AI-агентов на базе **OpenCode**, **Skills** и **Model Context Protocol (MCP)**. Репозиторий объединяет два самостоятельных проекта: работу с электронными компонентами и BOM, а также исследования товарных ниш и спроса на российском рынке.

Это **не единое приложение**: у каждого проекта собственные зависимости, конфигурация, инструкции и проверки. Для начала выберите нужное направление.

## Проекты

| Каталог | Назначение | Основные возможности |
| --- | --- | --- |
| [`electronics-parts/`](electronics-parts/README.md) | Подбор электронных компонентов и подготовка закупок | Поиск по MPN, наличие и цены у поставщиков, проверка BOM, планирование закупки, проверка совместимости замен |
| [`market-research/`](market-research/README.md) | Доказательное исследование товарных ниш в России | Анализ поискового интереса и спроса, сравнение источников, оценка гипотез, подготовка отчётов и PDF |

### Electronics Parts

Инструменты помогают инженеру переходить от MPN или BOM к проверяемым предложениям поставщиков и решениям о закупке:

- **OpenCode Skills:** `ru-part-search`, `bom-availability`, `bom-procurement`, `component-replacement`.
- **MCP:** `electronics-parts` для получения данных о компонентах и `sqlite-memory` для локальной истории BOM, предложений и исследований замен.
- **Источники:** DigiKey, Mouser, LCSC, JLCPCB и российские поставщики (доступность зависит от API и условий соответствующего источника).
- **Контроль качества:** параметры и совместимость замен требуют подтверждения источниками или даташитами; непроверенные факты отделяются от проверенных.

Документация: [обзор и запуск](electronics-parts/README.md) · [архитектура](electronics-parts/docs/ARCHITECTURE.md) · [модель данных](electronics-parts/docs/DATA_MODEL.md) · [план тестирования](electronics-parts/tests/TEST_PLAN.md).

### Market Research

Инструменты для воспроизводимого исследования продуктовых гипотез, прежде всего на российском рынке:

- **OpenCode Skills:** `product-research` для организации исследования и `md2pdf` для подготовки PDF-отчётов.
- **MCP:** `yandex-analytics` (Wordstat и Yandex Cloud Search API), `avito-analytics` (аналитика спроса при наличии авторизованного доступа) и необязательный `market-research-sqlite` для истории наблюдений.
- **Результат:** источники и ограничения данных, сравнение сигналов спроса, обоснованные гипотезы и решение `GO` / `TEST` / `HOLD` / `NO-GO`.
- **Принцип:** частотность запросов не равна продажам; данные отдельных площадок нельзя автоматически считать объёмом всего рынка.

Документация: [обзор и запуск](market-research/README.md) · [структура исследования](market-research/PROJECT_STRUCTURE.md) · [настройка MCP](market-research/config/opencode.mcp.example.jsonc) · [Product Research Skill](market-research/.opencode/skills/product-research/SKILL.md).

## Структура репозитория

```text
ai/
├── electronics-parts/
│   ├── .opencode/skills/      # Подбор компонентов, BOM и замены
│   ├── mcp/                   # Electronics Parts и SQLite Memory
│   ├── db/                    # Схема локальной базы
│   ├── docs/                  # Архитектура и модель данных
│   └── tests/                 # Тесты и примеры BOM
├── market-research/
│   ├── .opencode/skills/      # Product Research и md2pdf
│   ├── mcp/                   # Yandex, Avito и SQLite
│   ├── config/                # Пример настройки OpenCode MCP
│   ├── scripts/               # Валидация и сборка
│   └── tests/                 # Тесты
├── LICENSE
└── README.md
```

## Быстрый старт

**Требования:** Git, Node.js **20+**, OpenCode. Для отдельных интеграций необходимы дополнительные инструменты и разрешённый доступ к источникам данных.

Клонируйте репозиторий:

```bash
git clone https://github.com/thleontev/ai.git
cd ai
```

Для **Electronics Parts**:

```bash
cd electronics-parts
npm ci --prefix mcp/electronics-parts
npm ci --prefix mcp/sqlite-memory
npm run check
npm test
```

Затем настройте OpenCode Skills и оба MCP, создайте SQLite-базу по `db/schema.sql` и при необходимости задайте переменные окружения для API. Пошаговые действия — в [README проекта](electronics-parts/README.md).

Для **Market Research** (из корня `ai/`):

```bash
cd market-research
npm run setup
npm test
```

Затем подключите нужные MCP по [шаблону конфигурации](market-research/config/opencode.mcp.example.jsonc) и настройте авторизацию в используемых источниках. Подробности — в [README проекта](market-research/README.md).

> Команды проверки не заменяют настройку API-ключей, авторизованной сессии Авито, SQLite и Skills: эти шаги описаны внутри соответствующих проектов.

## Данные, ограничения и безопасность

- MCP-серверы и рабочие базы рассчитаны на локальное использование. Ключи API, OAuth-секреты, cookies, браузерные профили, рабочие SQLite-базы и результаты исследований **не следует коммитить**.
- Источники могут иметь ограничения доступа, квоты и условия использования. Для автоматизированного доступа соблюдайте правила поставщиков и платформ; не обходите CAPTCHA и блокировки.
- Цены, остатки и показатели спроса меняются. Для значимых решений проверяйте актуальность, первоисточники и ограничения метода.
- Детальные правила см. в [Electronics Parts SECURITY](electronics-parts/SECURITY.md) и [Market Research SECURITY](market-research/SECURITY.md).

## Лицензия

Исходный код распространяется на условиях [Apache License 2.0](LICENSE). Отдельные внешние API и источники данных регулируются собственными условиями использования.
