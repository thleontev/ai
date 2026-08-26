# Yandex Analytics MCP-сервер

Локальный MCP-сервер для **Yandex Cloud Search API v2** — статистики поисковых запросов
(Вордстат) и веб-поиска — без cookies, капчи и парсинга веб-версии.

## Возможности

**Wordstat (статистика частотности):**
- `top_requests` — частотность фразы за 30 дней + похожие запросы и ассоциации
- `dynamics` — динамика частотности по дням/неделям/месяцам
- `regions_distribution` — география запросов (count / share / affinityIndex)
- `regions_tree` — справочник регионов (кэшируется)
- `raw_request` — прямой вызов любого endpoint API (для отладки)

**Web search (поисковая выдача, официальный Search API):**
- `yandex_search_sync` — синхронный поиск: URL + заголовок + сниппет (для приоритетных фраз)
- `yandex_search_deferred_submit` — пакетное отправление отложенных запросов (дешевле в ~16 раз)
- `yandex_search_deferred_get` — сбор результатов отложенных запросов по `request_id`
- `yandex_search_deferred_list` — список ожидающих отложенных запросов сессии

## Настройка доступа (один раз)

1. **Аккаунт.** Войдите в [Yandex Cloud Console](https://console.yandex.cloud) под своим
   Яндекс ID — при первом входе автоматически создаётся каталог.
2. **API-ключ.** Создайте ключ в [Yandex Cloud Console](https://console.yandex.cloud) для используемого API и сохраните секретное значение только в переменной окружения. Никогда не добавляйте ключ в Git, issue или пример конфигурации.
3. **Права и биллинг.** Выдайте сервисному аккаунту роли и подключите биллинг в соответствии с актуальной [документацией Yandex Cloud Search API](https://yandex.cloud/ru/docs/search-api/). Требования различаются между Wordstat и Search API.
4. **Folder ID.** Console → каталог → ID вида `b1g...`. Это `WORDSTAT_FOLDER_ID` /
   `SEARCH_FOLDER_ID`.

## Переменные окружения

| Переменная | Обяз. | По умолчанию | Описание |
|---|---|---|---|
| `WORDSTAT_API_KEY` | да | — | API-ключ Yandex Cloud (AI Studio) для Wordstat |
| `WORDSTAT_FOLDER_ID` | да | — | ID каталога Yandex Cloud |
| `SEARCH_API_KEY` | нет* | ключ Wordstat | API-ключ для Search API (скоуп `yc.search-api.execute`) |
| `SEARCH_FOLDER_ID` | нет* | ID Wordstat | ID каталога для Search API |
| `WORDSTAT_API_BASE` | нет | `https://searchapi.api.cloud.yandex.net/v2/wordstat` | Корень Wordstat API |
| `SEARCH_API_BASE` | нет | `https://searchapi.api.cloud.yandex.net/v2/web` | Корень Search API |
| `SEARCH_OPERATIONS_API_BASE` | нет | `https://operation.api.cloud.yandex.net` | Хост операций отложенного поиска |
| `WORDSTAT_TIMEOUT_MS` | нет | `60000` | Таймаут запроса, мс |
| `WORDSTAT_MAX_RETRIES` | нет | `3` | Ретраи на 429/5xx |

\* Если не заданы — используются значения `WORDSTAT_API_KEY` / `WORDSTAT_FOLDER_ID`.

## Установка и запуск

```powershell
cd <путь-к-клону>\product-research
npm run setup
npm run check
```

## Регистрация в opencode.jsonc

Используйте блок `yandex-analytics` из `config/opencode.mcp.example.jsonc` в корне репозитория. Замените `C:\path\to\product-research` на абсолютный путь к своему клону; секретные значения передаются только из переменных окружения.

```jsonc
"mcp": {
  "yandex-analytics": {
    "type": "local",
    "command": ["node", "C:\\path\\to\\product-research\\mcp\\yandex-analytics\\server.mjs"],
    "cwd": "C:\\path\\to\\product-research\\mcp\\yandex-analytics",
    "environment": {
      "WORDSTAT_API_KEY": "{env:WORDSTAT_API_KEY}",
      "WORDSTAT_FOLDER_ID": "{env:WORDSTAT_FOLDER_ID}",
      "SEARCH_API_KEY": "{env:SEARCH_API_KEY}",
      "SEARCH_FOLDER_ID": "{env:SEARCH_FOLDER_ID}"
    },
    "enabled": true,
    "timeout": 60000
  }
}
```

Перед запуском задайте ключи и ID каталога в окружении пользователя. Для Windows это можно сделать через «Переменные среды» либо временно перед запуском в PowerShell; не сохраняйте значения в `.env`, если он может попасть в резервную копию или общий каталог.

## Примеры запросов

- «Какая частотность у фразы „купить ноутбук" в Москве?» → `top_requests("купить ноутбук", regions: ["213"])`
- «Покажи динамику по месяцам за 2025 год» → `dynamics("купить ноутбук", period: "PERIOD_MONTHLY", from_date: "2025-01-01", to_date: "2025-12-31")`
- «Где запрос популярнее всего?» → `regions_distribution("купить ноутбук")`
- «Найди объявления на Авито по фразе» → `yandex_search_sync("торты на заказ", site: "avito.ru", region: "973")` (973 — Сургут, список ID — в `regions_tree`)
- «Массовый обход: отправь в отложенный режим все фразы из списка, скажешь когда готово» → `yandex_search_deferred_submit` → подождать ≥5 минут → `yandex_search_deferred_get`

## Отложенный (deferred) режим

- Минимальное время обработки запроса — **5 минут**, хранение результата — **12 часов**.
- Актуальные тарифы и квоты смотрите в документации Yandex Cloud: они меняются независимо от версии MCP.
- Агент обязан явно сообщить пользователю, что результаты будут собраны после ожидания ≥5 минут.

## Ограничения

- Операторы `! + []` не поддерживаются Wordstat API (только широкое соответствие).
- Одна фраза за вызов Wordstat.
- `toDate` в `dynamics` должен быть концом периода: последний день месяца /
  воскресенье для недельного периода.
- Search API: текст запроса ≤400 символов, до 250 результатов на запрос,
  `region` применяется только к `SEARCH_TYPE_RU`.
- Квота: ~10 запросов/сек; синхронных 10 000/час, отложенных 35 000/час.

Подробности внутреннего устройства — в [ARCHITECTURE.md](ARCHITECTURE.md).
