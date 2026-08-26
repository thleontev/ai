# Product Research for OpenCode

Инструментарий для доказательного исследования товарных ниш в России: он помогает сопоставлять поисковый интерес Яндекса, спрос и предложение на Авито, публичные веб-источники и накопленные наблюдения. Репозиторий даёт готовый OpenCode Skill и два локальных MCP-сервера для простой установки в одном месте.

> Результат исследования — проверяемые сигналы и ограниченные данными гипотезы, а не «размер рынка» из несопоставимых метрик.

## Что входит

| Компонент | Назначение | Доступ и данные |
| --- | --- | --- |
| `product-research` Skill | Ведёт исследование: preflight, география, источники, evidence levels, отчёт и quality gate. | Работает с подключёнными MCP; пользовательские отчёты остаются локальными. |
| `mcp/yandex-analytics` | Wordstat и Yandex Cloud Search API v2. | Нужны Yandex Cloud API key, Folder ID, роли и активный биллинг для Search API. |
| `mcp/avito-analytics` | Аналитика спроса Авито через авторизованную сессию системного браузера. | Нужен аккаунт с доступом к разделу аналитики; cookies и ответы хранятся только локально. |
| `mcp/market-research-sqlite` | Необязательная история запусков по схеме Product Research v3. | Хранит только локальный `sqlite.db`; используется `better-sqlite3` 12.8.0. |
| `md2pdf` Skill | Собирает Markdown-отчёт в проверяемый PDF A4. | Нужны локальные Python/Node-зависимости и Chrome или Edge. |

## Быстрый старт

Требования: Node.js 20+ и Git. Для Авито также установите Chrome или Edge.

```powershell
git clone https://github.com/<ваш-профиль>/product-research.git
cd product-research
npm run setup
npm test
```

`npm run setup` выполняет чистую установку зависимостей каждого MCP по его lockfile. Конфигурацию OpenCode возьмите из [config/opencode.mcp.example.jsonc](config/opencode.mcp.example.jsonc): замените `C:\\path\\to\\product-research` на абсолютный путь к клону и задайте ключи в переменных окружения пользователя, а не в конфиге и не в файлах репозитория.

После подключения перезапустите OpenCode. Скопируйте `.opencode/skills/product-research/` и `.opencode/skills/md2pdf/` в рабочий проект либо используйте их из клона согласно конфигурации вашего OpenCode.

## Границы и корректная интерпретация

- Wordstat измеряет поисковый интерес, а не продажи.
- Метрики Авито относятся к выбранной площадке и городу; городскую выборку нельзя складывать в показатель по России.
- Поисковые сниппеты — навигационные данные: факты подтверждаются открытием первичного публичного источника.
- SQLite — хранилище наблюдений, а не источник рыночных данных.
- При 403, 429 или капче обход защиты не применяется: фиксируйте ограничение и используйте статус, разрешённый Skill.

Подробный процесс и обязательные статусы (`GO`, `TEST`, `HOLD`, `NO-GO`) описаны в [SKILL.md](.opencode/skills/product-research/SKILL.md). Установка Авито — в [SETUP.md](mcp/avito-analytics/SETUP.md); требования Яндекс — в [README.md](mcp/yandex-analytics/README.md).

## Локальные данные и безопасность

Не добавляйте в Git API-ключи, `.env`, cookies, профиль браузера, сырые ответы, SQLite-базы, каталоги `data/`, `research/`, `node_modules/`, временные файлы и результаты PDF-проверки. По умолчанию профиль и архив Авито хранятся в `%LOCALAPPDATA%\OpenCode\avito-analytics`, вне синхронизируемого каталога и репозитория.

Сообщить об уязвимости можно по правилам [SECURITY.md](SECURITY.md). Лицензия исходного кода — [Apache-2.0](LICENSE).

## Разработка и CI

```powershell
npm run check
node scripts/validate-product-research.mjs
```

GitHub Actions повторяет эти проверки с чистой установкой зависимостей обоих MCP. У каждого сервера свой `package-lock.json`; не объединяйте их в общий npm workspace.

## Структура

```text
product-research/
├── .opencode/skills/          # product-research и md2pdf
├── config/                    # безопасный пример подключения MCP
├── mcp/
│   ├── avito-analytics/       # локальный MCP, авторизованный браузер
│   ├── yandex-analytics/      # локальный MCP, Yandex Cloud APIs
│   └── market-research-sqlite/# локальная история исследований
├── scripts/                   # проверка и упаковка Skill
└── .github/workflows/ci.yml
```
