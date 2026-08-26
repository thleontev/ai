import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const skill = join(root, ".opencode", "skills", "product-research");
const legacy = join(root, "research", "legacy");
const requiredReferences = [
  "extended-quality-gate.md",
  "chart-policy.md",
  "charts-spec-template.json",
  "chart-rendering-qc.md",
  "geography-coverage.md",
  "marketplace-category-analysis.md",
  "pdf-delivery.md",
  "mcp-preflight.md",
  "paid-demand-test.md",
  "report-template.md",
  "run-manifest-template.json",
  "social-channel-validation.md",
  "source-degradation.md",
  "sqlite-schema.md",
];
const requiredSkillText = [
  "name: product-research",
  "description:",
  "## Паспорт запуска и preflight источников",
  "### Geography gate",
  "national_with_city_sample",
  "### Stage 4.5 — Evidence charts",
  "chart-rendering-qc.md",
  "marketplace-category-analysis.md",
  "market_category_snapshots",
  "market_profile",
  "## PDF deliverable",
  "md2pdf",
  "avito_session_open",
  "avito_location_search",
  "evidence_ref",
  "## Блокирующий quality gate",
  "каждый вложенный уровень отступай ровно на 4 пробела",
];
const requiredReportHeadings = [
  "## 1. Цель и условия исследования",
  "## 2. Допущения и ограничения",
  "### Географическое покрытие",
  "## 3. Язык рынка и семантика",
  "## 8. Сопоставление сигналов",
  "## 9.1 Графики",
  "## 10. Гипотезы",
  "## 11. Следующий тест",
  "## 12. Статус",
  "## Исходные данные",
  "## История исследования",
  "## Паспорт запуска",
  "## PDF-версия",
];

const errors = [];
const warnings = [];
const check = (condition, message) => (condition ? null : errors.push(message));
const read = (path) => readFileSync(path, "utf8");

const skillFile = join(skill, "SKILL.md");
check(existsSync(skillFile), "Не найден SKILL.md.");
if (existsSync(skillFile)) {
  const content = read(skillFile);
  check(content.startsWith("---\n"), "SKILL.md должен начинаться YAML-frontmatter.");
  check(content.indexOf("\n---\n", 4) > 4, "SKILL.md не закрывает YAML-frontmatter.");
  for (const item of requiredSkillText) check(content.includes(item), `SKILL.md: отсутствует ${item}`);
}

for (const name of requiredReferences) {
  check(existsSync(join(skill, "references", name)), `Не найден reference: ${name}`);
}
for (const name of ["README.md", "PROJECT_STRUCTURE.md", ".gitignore", "scripts/package-skill.ps1"]) {
  check(existsSync(join(root, name)), `Не найден файл проекта: ${name}`);
}

function walk(folder) {
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const reports = walk(join(root, "research"))
  .filter((path) => path.endsWith(".md") && !path.startsWith(legacy));
for (const report of reports) {
  const content = read(report);
  for (const heading of requiredReportHeadings) {
    check(content.includes(heading), `Отчёт ${report}: отсутствует ${heading}`);
  }
}
if (!reports.length) warnings.push("Нет активных отчётов v2: добавьте первый отчёт после preflight.");

if (errors.length) {
  console.error("Проверка не пройдена:");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log("Проверка product-research пройдена.");
}
for (const warning of warnings) console.warn(`Предупреждение: ${warning}`);
