# Схема SQLite v3

Прочитай этот файл до первой записи в SQLite в каждом запуске. База — только `sqlite.db` в корне рабочего проекта, подключённая SQLite MCP. Не меняй исторические строки и не помещай в базу токены, cookies или полные ответы MCP.

## Безопасная инициализация

1. Выполни `PRAGMA integrity_check;`. Продолжай только при результате `ok`.
2. Для новой базы выполни DDL ниже **одной транзакцией**: сначала `BEGIN IMMEDIATE;`, затем все команды, в конце `COMMIT;`. При ошибке выполни `ROLLBACK;`.
3. Для базы v1 или v2 сначала прочитай `PRAGMA table_info(observations);`, `PRAGMA table_info(competitor_samples);` и `PRAGMA table_info(market_category_snapshots);`. Добавляй отсутствующие поля и таблицы из раздела «Миграция v1/v2 → v3». Не выполняй `ALTER TABLE`, если столбец уже существует.
4. Запиши версию 3 в `schema_meta`. Если integrity check не прошёл, не восстанавливай и не удаляй базу без отдельного разрешения пользователя; укажи точную ошибку в разделе «История исследования» и продолжи без истории.

```sql
BEGIN IMMEDIATE;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS research_runs (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  product TEXT NOT NULL,
  decision_brief TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress',
  manifest_path TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS queries (
  id INTEGER PRIMARY KEY,
  research_run_id INTEGER NOT NULL REFERENCES research_runs(id),
  source TEXT NOT NULL,
  query TEXT NOT NULL,
  normalized_query TEXT NOT NULL,
  cluster TEXT,
  intent TEXT CHECK (intent IN ('commercial','informational','professional','adjacent','irrelevant')),
  observed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY,
  research_run_id INTEGER NOT NULL REFERENCES research_runs(id),
  query_id INTEGER REFERENCES queries(id),
  product TEXT NOT NULL,
  query TEXT,
  cluster TEXT,
  source TEXT NOT NULL,
  source_tool TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  data_level TEXT NOT NULL CHECK (data_level IN ('query','cluster','category','listing','region')),
  region TEXT,
  metric TEXT NOT NULL,
  value_num REAL,
  value_text TEXT,
  unit TEXT,
  period_from TEXT,
  period_to TEXT,
  observed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS competitor_samples (
  id INTEGER PRIMARY KEY,
  research_run_id INTEGER NOT NULL REFERENCES research_runs(id),
  segment TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_type TEXT NOT NULL,
  evidence_ref TEXT,
  data_level TEXT NOT NULL DEFAULT 'listing' CHECK (data_level IN ('listing','category','region')),
  seller TEXT,
  object_name TEXT NOT NULL,
  price_num REAL,
  price_text TEXT,
  configuration TEXT,
  conditions TEXT,
  differentiation TEXT,
  accessed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS market_category_snapshots (
  id INTEGER PRIMARY KEY,
  research_run_id INTEGER NOT NULL REFERENCES research_runs(id),
  source TEXT NOT NULL,
  source_tool TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  location_name TEXT,
  location_id TEXT,
  category_name TEXT NOT NULL,
  category_node_id TEXT NOT NULL,
  parent_node_id TEXT,
  tree_depth INTEGER CHECK (tree_depth >= 0),
  sellers_num REAL,
  listings_num REAL,
  views_num REAL,
  contacts_num REAL,
  period_from TEXT,
  period_to TEXT,
  observed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conclusions (
  id INTEGER PRIMARY KEY,
  research_run_id INTEGER NOT NULL REFERENCES research_runs(id),
  hypothesis TEXT NOT NULL,
  confidence TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('GO','TEST','HOLD','NO-GO')),
  evidence_summary TEXT NOT NULL,
  limitation TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_queries_lookup
  ON queries(normalized_query, source, intent);
CREATE INDEX IF NOT EXISTS idx_observations_lookup
  ON observations(query, source, region, metric, period_from, period_to);
CREATE INDEX IF NOT EXISTS idx_competitors_run
  ON competitor_samples(research_run_id, segment);
CREATE INDEX IF NOT EXISTS idx_market_category_lookup
  ON market_category_snapshots(source, category_node_id, location_id, period_from, period_to);

INSERT INTO schema_meta (key, value, updated_at)
VALUES ('schema_version', '3', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

COMMIT;
```

## Миграция v1/v2 → v3

Выполняй только для подтверждённой целой базы v1 и только для отсутствующих столбцов:

```sql
ALTER TABLE research_runs ADD COLUMN manifest_path TEXT;
ALTER TABLE observations ADD COLUMN source_tool TEXT;
ALTER TABLE observations ADD COLUMN evidence_ref TEXT;
ALTER TABLE observations ADD COLUMN data_level TEXT;
ALTER TABLE competitor_samples ADD COLUMN evidence_ref TEXT;
ALTER TABLE competitor_samples ADD COLUMN data_level TEXT;
```

Затем создай `market_category_snapshots` и `idx_market_category_lookup` теми же выражениями `CREATE ... IF NOT EXISTS` из DDL выше. Заполни `source_tool`, `evidence_ref` и `data_level` только для строк, чьё происхождение известно. Не выдумывай эти значения для старых наблюдений: оставь их `NULL`, пометь историческую строку как несопоставимую и не используй для тренда. После миграции создай или обнови `schema_meta` и запиши версию 3.

Одна строка `observations` хранит одно измеренное значение. Для каждого значения обязательны дата, период, регион (или явное отсутствие), уровень данных, инструмент и ссылка на сырой ответ. Недоступное числовое значение — `NULL`, а не ноль.

Одна строка `market_category_snapshots` хранит один узел категории для одного города и периода. Не складывай строки разных уровней дерева и не записывай отсутствующий родительский ID как фиктивное значение.
