# Preflight MCP

Прочитай перед вызовом источников. Цель — выяснить реальную доступность инструментов и не тратить бюджет на заведомо невозможный маршрут.

## Yandex Analytics

1. Проверь, что доступны `top_requests`, `dynamics`, `regions_distribution`, `regions_tree`, `yandex_search_sync`, `yandex_search_deferred_submit` и `yandex_search_deferred_get`.
2. При необходимости поиска проверь доступ Search API отдельным малым запросом. Успешный Wordstat не доказывает доступность Search API: ему могут требоваться отдельные ключ, роль и биллинг.
3. В паспорт запуска запиши, доступны ли Wordstat и Search API отдельно. При недоступном Search API используй матрицу деградации и не заменяй его Google.

## Avito Analytics

1. Вызови `avito_session_open`, затем `avito_session_status`.
2. Продолжай только при `authorized: true`, отсутствии активного `blocked_until` и достаточном остатке `max_requests_per_session - requests_in_session`.
3. Для каждого города вызови `avito_location_search`; используй только строку с `exact: true`. ID Авито отличаются от ID регионов Яндекса.
4. После каждого `avito_market` и `avito_wordstat` сохрани `archived` как `evidence_ref`. Путь может быть локальным и не должен попасть в публичный отчёт, если раскрывает персональные данные.
5. При 403, 429, капче или `blocked_until` прекрати вызовы аналитики. Не перезапускай сервер и не обходи защиту.

## SQLite

Если SQLite MCP доступен и пользователь не запретил историю: до источников проверь `PRAGMA integrity_check`. При результате, отличном от `ok`, сохрани резервную копию только после явного согласования пользователя, пометь историю `unavailable` и не используй старые показатели.
