# Архитектура MCP-сервера Yandex Analytics

## Обзор

Локальный MCP-сервер (транспорт **Stdio**), предоставляющий AI-клиентам доступ к
**Yandex Cloud Search API v2**: статистике поисковых запросов (Вордстат) и поисковой
выдаче (Web Search, синхронный и отложенный режимы) — всё через официальный API.

- Стек: Node.js, `@modelcontextprotocol/sdk`, `zod`
- Режим: read-only (у API нет изменяющих операций)
- Код: `server.mjs` (единый файл, стиль `MCP/server.mjs`)

## Бэкенд

Корень Wordstat API: `https://searchapi.api.cloud.yandex.net/v2/wordstat/*`

Методы (POST, JSON):

| Метод | Путь | Назначение |
|---|---|---|
| GetTop | `/topRequests` | частотность фразы + похожие запросы за 30 дней (results) + ассоциации |
| GetDynamics | `/dynamics` | динамика частотности по дням/неделям/месяцам |
| GetRegionsDistribution | `/regions` | география запросов по регионам/городам |
| GetRegionsTree | `/getRegionsTree` | справочник регионов с ID (не тратит суточную квоту) |

Корень Search API: `https://searchapi.api.cloud.yandex.net/v2/web/*`

| Операция | Путь | Назначение |
|---|---|---|
| Синхронный поиск | `POST /search` | мгновенная выдача; ответ `{"rawData": "<base64 XML>"}` |
| Отложенный поиск | `POST /searchAsync` | приём запроса в очередь, возвращает `operation id` |
| Получение результата | `GET https://operation.api.cloud.yandex.net/operations/{id}` | статус и результат отложенного запроса |

Отложенный режим: результат готов не раньше чем через **5 минут**, хранится **12 часов**;
тариф ~30,5 ₽/1000 днём и ~25,41 ₽/1000 ночью (синхронный — 488 ₽/1000).

## Авторизация

- Заголовок `Authorization: Api-Key <API_KEY>` — ключ из Yandex Cloud AI Studio.
  Для Search API ключ должен иметь скоуп `yc.search-api.execute`; сервисному аккаунту
  нужны роли `search-api.executor` (Wordstat) и `search-api.editor` (Search API).
- Поле `folderId` — идентификатор каталога Yandex Cloud — **обязательно** в теле каждого
  запроса; сервер подставляет его автоматически.
- Для Search API используются `SEARCH_API_KEY`/`SEARCH_FOLDER_ID` с фолбэком на
  `WORDSTAT_API_KEY`/`WORDSTAT_FOLDER_ID`, если отдельные не заданы.
- Почему не cookies/OAuth: старый API `api.wordstat.yandex.net` (OAuth) закрыт в августе
  2025 года; веб-версии ловят SmartCaptcha и нестабильны для автоматизации. Официальный
  API — единственный поддерживаемый путь.

## Компоненты сервера (`server.mjs`)

1. **Конфигурация из env** — `WORDSTAT_API_KEY`, `WORDSTAT_FOLDER_ID`, `SEARCH_API_KEY`,
   `SEARCH_FOLDER_ID`, `*_API_BASE`, `*_TIMEOUT_MS`, `*_MAX_RETRIES`.
   При отсутствии ключей инструменты возвращают понятную ошибку конфигурации.
2. **`callApi(path, body)`** — единая точка вызова Wordstat:
   - подстановка `folderId` в тело;
   - client-side rate limit **10 rps** (`MIN_REQUEST_INTERVAL_MS = 100`);
   - ретраи с экспоненциальным backoff (500 мс · 2ⁿ + jitter) на **429/5xx** и сетевые
     сбои (до `MAX_RETRIES`, по умолчанию 3);
   - таймаут `AbortSignal.timeout(TIMEOUT_MS)`;
   - парсинг ошибок Google-style (`body.error.message` + code/status) и plain `body.message`.
3. **`httpRequest(method, url, ...)`** — обобщённый HTTP-слой для Search API (те же
   rate limit, ретраи, таймаут), используется `searchPost` и `operationGet`.
4. **`buildSearchBody(input)`** — построение тела запроса Search API: `query`,
   `groupSpec` (группировка), `sortSpec` (релевантность/дата), `region` (только для
   `SEARCH_TYPE_RU`), `l10n`, `responseFormat: FORMAT_XML`. Ограничение `site:` домена
   добавляется к тексту запроса.
5. **`parseSearchXml(xml)`** — разбор XML-ответа (`rawData` base64) в JSON:
   `found` (число найденных) и массив `results[]` с `url`, `title`, `snippet`
   (`headline` или первый `passage`), `domain`, `language`. Ошибка 15 («ничего не
   найдено») не считается сбоем.
6. **`deferredRegistry`** — in-memory реестр отложенных запросов сессии
   (id → query, submittedAt, readyAfter) для последующего сбора результатов.
7. **Нормализация ответов Wordstat** — поля `count`, `share`, `affinityIndex`,
   `totalCount` в API приходят строками; приводятся к числам (`numericCount`).
8. **Кэш регионов** — `getRegionsTree` кэшируется на 24 часа (TTL).
9. **Усечение ответов** — списки > 300 элементов обрезаются с пометкой.
10. **Обработка ошибок** — каждый инструмент обёрнут `runTool` → `errorResult`
    (`isError: true` в MCP-ответе).

## Инструменты

### Wordstat

| Tool | Параметры | Endpoint | Нормализованный ответ |
|---|---|---|---|
| `top_requests` | phrase, num_phrases (1–2000, def 20), regions[], devices[] | `/topRequests` | totalCount, results[{phrase,count}], associations[] |
| `dynamics` | phrase, period (PERIOD_DAILY/WEEKLY/MONTHLY), from_date, to_date, regions[], devices[] | `/dynamics` | dynamics[{date,count,share}] |
| `regions_distribution` | phrase, region_type (REGION_ALL/CITIES/REGIONS), devices[] | `/regions` | regions[{region,count,share,affinityIndex}] |
| `regions_tree` | — | `/getRegionsTree` | дерево регионов (кэш 24 ч) |
| `raw_request` | path, body | произвольный | сырой ответ (для отладки) |

### Web Search

| Tool | Параметры | Endpoint | Ответ |
|---|---|---|---|
| `yandex_search_sync` | query, region?, site?, page?, limit?, search_type?, sort_by?, fix_typo?, family_mode?, l10n? | `POST /v2/web/search` | found, results[{url,title,snippet,domain,language}] |
| `yandex_search_deferred_submit` | queries[] (до 50) | `POST /v2/web/searchAsync` | submitted[{request_id, query, ready_after}] |
| `yandex_search_deferred_get` | request_ids[] (до 50) | `GET /operations/{id}` | results[{request_id, status: PENDING/DONE/ERROR, ...}] |
| `yandex_search_deferred_list` | — | — | pending[{request_id, query, submitted_at, ready_after}] |

## Данные и грабли

- `period` строго с префиксом `PERIOD_` (enum в proto), иначе `INVALID_ARGUMENT`.
- `toDate` должен быть концом периода: для `PERIOD_MONTHLY` — последний день месяца,
  для `PERIOD_WEEKLY` — воскресенье.
- `count` в ответах Wordstat — строка, приводится к числу.
- `regions` — массив строковых ID (например `"213"` — Москва), берутся из `regions_tree`.
- Операторы `! + []` и сравнение нескольких фраз за вызов **не поддерживаются** Wordstat API.
- Search API: текст запроса ≤400 символов, до 250 результатов на запрос, `region`
  применяется только к `SEARCH_TYPE_RU`. Синхронно 10 000 запросов/час, отложенно
  35 000/час.
- Отложенные результаты: минимум 5 минут на обработку, хранение 12 часов.
  Реестр `deferredRegistry` живёт в памяти процесса — после перезапуска сервера
  незабранные результаты нужно пересоздать.
- Квота: ~10 запросов/сек, суточная квота по биллингу Yandex Cloud — на один ключ, общая.

## Конфигурация и регистрация

```jsonc
// opencode.jsonc → mcp
"yandex-analytics": {
  "type": "local",
  "command": ["C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\thleo\\SynologyDrive\\Opencode\\MCP\\yandex-analytics\\server.mjs"],
  "cwd": "C:\\Users\\thleo\\SynologyDrive\\Opencode\\MCP\\yandex-analytics",
  "environment": {
    "WORDSTAT_API_KEY": "{env:WORDSTAT_API_KEY}",
    "WORDSTAT_FOLDER_ID": "{env:WORDSTAT_FOLDER_ID}",
    "SEARCH_API_KEY": "{env:SEARCH_API_KEY}",
    "SEARCH_FOLDER_ID": "{env:SEARCH_FOLDER_ID}"
  },
  "enabled": true,
  "timeout": 60000
}
```

Пути в `command`/`cwd` абсолютные — конфиг переносим между ПК с разным расположением
Synology Drive при условии одинакового расположения папки `MCP`. Значения ключей
подтягиваются из переменных окружения пользователя (интерполяция `{env:...}`),
секреты в конфиг не пишутся.

## Ограничения

- Нет операторов точной частотности (`!`, `+`, `[]`) — данные «широкого соответствия».
- Одна фраза за вызов Wordstat.
- Требуется аккаунт Yandex Cloud с активным биллингом; Search API тарифицируется
  за 1000 запросов и должен быть активирован для каталога.
- `regions_distribution` по умолчанию возвращает субъекты РФ (`REGION_REGIONS`).