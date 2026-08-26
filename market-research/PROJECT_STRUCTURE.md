# Пример структуры проекта

```text
market-research/
├── .opencode/
│   └── skills/
│       └── product-research/
│           └── SKILL.md
│       └── md2pdf/
│           └── SKILL.md
├── research/
│   └── carpenter-scriber/
│       ├── run-2026-08-20-<run-id>.json
│       ├── charts-spec.json
│       ├── charts/
│       │   └── wordstat-dynamics.svg
│       ├── report-2026-08-20.md
│       ├── report-2026-08-20.html
│       ├── report-2026-08-20.pdf
│       └── pdf-check/
│           ├── _check.txt
│           └── page-1.png
├── data/                         # опционально
│   └── market-research.db         # SQLite, если нужен
├── scripts/
│   ├── validate-product-research.mjs
│   └── package-skill.ps1
├── .gitignore
└── README.md
```

## Рекомендации

- Сохраняйте каждый отчёт в отдельной папке.
- Создавайте паспорт запуска до первого вызова источников и сохраняйте его рядом с отчётом.
- Фиксируйте дату, регион, период и исходные MCP-данные.
- Для Авито сохраняйте `archived` из ответа как ссылку на raw evidence, но не публикуйте профиль браузера, cookies и архивы ответов.
- Не добавляйте токены, cookies, файлы `.env` и базы с секретами в Git.
- На старте достаточно `report.md`; финальная поставка также включает одноимённый проверенный PDF. SQLite добавляйте, когда появится потребность сравнивать наблюдения во времени.

## Пример `.gitignore`

```gitignore
.env
*.sqlite
*.sqlite3
*.db
data/raw/
```

Если база нужна в репозитории как пример структуры, добавьте вместо неё пустой файл `data/.gitkeep`, а не реальные данные или учётные данные.
