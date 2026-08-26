# Market Research SQLite MCP

Локальный stdio MCP для необязательной истории исследований Product Research. Он использует `better-sqlite3` 12.8.0 и предоставляет запросы, запись и запуск DDL-сценария схемы из `../../.opencode/skills/product-research/references/sqlite-schema.md`.

Это не перенос сервера `sqlite-memory` из проекта электронных компонентов: тот содержит BOM и закупочные таблицы и поэтому несовместим с исследованиями рынка.

## Установка

```powershell
npm ci
npm run check
```

В конфигурации OpenCode укажите `MARKET_RESEARCH_DB` абсолютным путём к `sqlite.db` рабочего проекта. База, её WAL/SHM-файлы и любые результаты исследований не публикуются.

Перед первой записью вызовите `sqlite_integrity_check`, затем примените DDL одной транзакцией через `sqlite_batch`. Работайте только с базой, подключённой этим MCP.
