import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const inputPath = option("--input");
const outputDir = option("--output-dir");
if (!inputPath || !outputDir) {
  throw new Error("Использование: node generate-charts.mjs --input charts-spec.json --output-dir charts");
}

const spec = JSON.parse(readFileSync(inputPath, "utf8"));
if (!Array.isArray(spec.charts) || !spec.charts.length) {
  throw new Error("В charts-spec.json нужен непустой массив charts.");
}

const width = 960;
const height = 540;
const plot = { left: 100, right: 48, top: 88, bottom: 95 };
const colors = ["#2563eb", "#dc2626", "#059669", "#9333ea", "#d97706"];
const escapeXml = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;");
const number = (value, label) => {
  if (!Number.isFinite(value)) throw new Error(`${label}: требуется конечное число.`);
  return value;
};
const safeFilename = (name) => {
  if (!name || basename(name) !== name || !name.endsWith(".svg")) {
    throw new Error("filename должен быть именем SVG-файла без пути.");
  }
  return name;
};
const tickValues = (min, max, count = 5) => Array.from({ length: count }, (_, index) => min + ((max - min) * index) / (count - 1));
const formatNumber = (value) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(value);
const estimatedTextWidth = (value, fontSize = 11) => Array.from(String(value)).length * fontSize * 0.62;
const wrapLabel = (value, maxChars = 30) => {
  const words = String(value).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (let word of words) {
    while (word.length > maxChars) {
      if (line) {
        lines.push(line);
        line = "";
      }
      lines.push(word.slice(0, maxChars));
      word = word.slice(maxChars);
    }
    if (!line || line.length + word.length + 1 <= maxChars) {
      line = line ? `${line} ${word}` : word;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [String(value)];
};

function frame(title, subtitle, body, footer) {
  const footerLines = wrapLabel(footer ?? "Источник и период указаны в отчёте и разделе «Исходные данные».", 104).slice(0, 2);
  const footerY = height - 26 - ((footerLines.length - 1) * 14);
  const footerText = footerLines.map((line, index) => `<tspan x="${plot.left}" dy="${index ? 14 : 0}">${escapeXml(line)}</tspan>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">
<style>
  text { font-family: Arial, sans-serif; fill: #1f2937; }
  .title { font-size: 22px; font-weight: 700; }
  .subtitle, .axis, .note { font-size: 12px; fill: #4b5563; }
  .label { font-size: 11px; fill: #374151; }
  .grid { stroke: #e5e7eb; stroke-width: 1; }
  .axis-line { stroke: #9ca3af; stroke-width: 1; }
</style>
<rect width="100%" height="100%" fill="white"/>
<text class="title" x="${plot.left}" y="34">${escapeXml(title)}</text>
<text class="subtitle" x="${plot.left}" y="56">${escapeXml(subtitle ?? "")}</text>
${body}
<text class="note" x="${plot.left}" y="${footerY}">${footerText}</text>
</svg>`;
}

function lineChart(chart) {
  if (!Array.isArray(chart.series) || !chart.series.length) throw new Error("line: нужен непустой series.");
  const series = chart.series.map((item) => {
    if (!Array.isArray(item.points) || item.points.length < 2) throw new Error("line: в каждой серии минимум две точки.");
    return { ...item, points: item.points.map((point) => ({ x: String(point.x), y: number(point.y, "line.y") })) };
  });
  const labels = series[0].points.map((point) => point.x);
  if (series.some((item) => item.points.length !== labels.length || item.points.some((point, index) => point.x !== labels[index]))) {
    throw new Error("line: серии должны иметь одинаковую последовательность x.");
  }
  const values = series.flatMap((item) => item.points.map((point) => point.y));
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) { min = 0; max = max || 1; }
  const padding = (max - min) * 0.08;
  min = Math.max(0, min - padding);
  max += padding;
  const chartWidth = width - plot.left - plot.right;
  const chartHeight = height - plot.top - plot.bottom;
  const x = (index) => plot.left + (labels.length === 1 ? chartWidth / 2 : (chartWidth * index) / (labels.length - 1));
  const y = (value) => plot.top + chartHeight - ((value - min) / (max - min)) * chartHeight;
  const ticks = tickValues(min, max);
  const grid = ticks.map((value) => `<line class="grid" x1="${plot.left}" x2="${width - plot.right}" y1="${y(value)}" y2="${y(value)}"/><text class="label" text-anchor="end" x="${plot.left - 10}" y="${y(value) + 4}">${formatNumber(value)}</text>`).join("");
  const xLabelStep = Math.max(1, Math.ceil(labels.length / 8));
  const xLabels = labels.map((label, index) => {
    if (index % xLabelStep !== 0) return "";
    return `<text class="label" text-anchor="middle" x="${x(index)}" y="${height - plot.bottom + 23}">${escapeXml(label)}</text>`;
  }).join("");
  const paths = series.map((item, index) => {
    const color = colors[index % colors.length];
    const path = item.points.map((point, pointIndex) => `${pointIndex ? "L" : "M"}${x(pointIndex)},${y(point.y)}`).join(" ");
    const dots = item.points.map((point, pointIndex) => `<circle cx="${x(pointIndex)}" cy="${y(point.y)}" r="3.5" fill="${color}"/>`).join("");
    return `<path d="${path}" fill="none" stroke="${color}" stroke-width="3"/>${dots}`;
  }).join("");
  const legend = series.map((item, index) => `<rect x="${plot.left + index * 160}" y="${height - 58}" width="10" height="10" fill="${colors[index % colors.length]}"/><text class="label" x="${plot.left + 16 + index * 160}" y="${height - 49}">${escapeXml(item.name)}</text>`).join("");
  return frame(chart.title, chart.subtitle, `${grid}<line class="axis-line" x1="${plot.left}" x2="${width - plot.right}" y1="${height - plot.bottom}" y2="${height - plot.bottom}"/>${xLabels}${paths}${legend}`, chart.footer);
}

function priceRangeChart(chart) {
  if (!Array.isArray(chart.items) || !chart.items.length) throw new Error("price_range: нужен непустой items.");
  const items = chart.items.map((item) => {
    const min = number(item.min, "price_range.min");
    const median = number(item.median, "price_range.median");
    const max = number(item.max, "price_range.max");
    const n = number(item.n, "price_range.n");
    if (n < 5 || min > median || median > max) throw new Error("price_range: нужны n >= 5 и min <= median <= max.");
    return { ...item, min, median, max, n };
  });
  const minValue = Math.min(...items.map((item) => item.min));
  const maxValue = Math.max(...items.map((item) => item.max));
  const padding = Math.max(1, (maxValue - minValue) * 0.08);
  const low = Math.max(0, minValue - padding);
  const high = maxValue + padding;
  // Price-range labels are right-aligned. Wrap and reserve their actual width
  // so long Russian segment names cannot leave the SVG viewport at x < 0.
  const labels = items.map((item) => wrapLabel(`${item.name} (n=${item.n})`));
  const longestLine = Math.max(...labels.flatMap((lines) => lines.map((line) => estimatedTextWidth(line))));
  const priceLeft = Math.max(plot.left, Math.min(320, Math.ceil(longestLine + 36)));
  const chartWidth = width - priceLeft - plot.right;
  const row = (index) => plot.top + 42 + index * ((height - plot.top - plot.bottom - 50) / Math.max(1, items.length - 1));
  const x = (value) => priceLeft + ((value - low) / (high - low)) * chartWidth;
  const ticks = tickValues(low, high);
  const grid = ticks.map((value) => `<line class="grid" x1="${x(value)}" x2="${x(value)}" y1="${plot.top}" y2="${height - plot.bottom}"/><text class="label" text-anchor="middle" x="${x(value)}" y="${height - plot.bottom + 23}">${formatNumber(value)}</text>`).join("");
  const rows = items.map((item, index) => {
    const labelLines = labels[index];
    const labelY = row(index) + 4 - ((labelLines.length - 1) * 6);
    const label = labelLines.map((line, lineIndex) => `<tspan x="${priceLeft - 12}" dy="${lineIndex ? 12 : 0}">${escapeXml(line)}</tspan>`).join("");
    return `<text class="label" text-anchor="end" x="${priceLeft - 12}" y="${labelY}">${label}</text><line x1="${x(item.min)}" x2="${x(item.max)}" y1="${row(index)}" y2="${row(index)}" stroke="#2563eb" stroke-width="5" stroke-linecap="round"/><circle cx="${x(item.median)}" cy="${row(index)}" r="7" fill="#dc2626"/><text class="label" x="${x(item.max) + 8}" y="${row(index) + 4}">${formatNumber(item.min)}–${formatNumber(item.max)}</text>`;
  }).join("");
  return frame(chart.title, chart.subtitle, `${grid}<line class="axis-line" x1="${priceLeft}" x2="${width - plot.right}" y1="${height - plot.bottom}" y2="${height - plot.bottom}"/>${rows}<text class="label" x="${priceLeft}" y="${height - 58}">Синяя линия: минимум–максимум; красная точка: медиана.</text>`, chart.footer);
}

function marketProfileChart(chart) {
  if (!Array.isArray(chart.items) || chart.items.length < 2 || chart.items.length > 6) {
    throw new Error("market_profile: нужны 2–6 сопоставимых городов или категорий.");
  }
  const items = chart.items.map((item) => ({
    name: String(item.name),
    sellers: number(item.sellers, "market_profile.sellers"),
    listings: number(item.listings, "market_profile.listings"),
    views_per_listing: number(item.views_per_listing, "market_profile.views_per_listing"),
    contacts_per_listing: number(item.contacts_per_listing, "market_profile.contacts_per_listing"),
    conversion_pct: item.conversion_pct === undefined ? null : number(item.conversion_pct, "market_profile.conversion_pct"),
  }));
  if (items.some((item) => [item.sellers, item.listings, item.views_per_listing, item.contacts_per_listing].some((value) => value < 0))) {
    throw new Error("market_profile: показатели не могут быть отрицательными.");
  }
  const panels = [
    { title: "Предложение, шт.", fields: ["sellers", "listings"], labels: ["Продавцы", "Объявления"], colors: ["#2563eb", "#0f766e"] },
    { title: "Просмотры на объявление", fields: ["views_per_listing"], labels: ["Просмотры"], colors: ["#7c3aed"] },
    { title: "Контакты на объявление", fields: ["contacts_per_listing"], labels: ["Контакты"], colors: ["#dc2626"] },
  ];
  const panelWidth = 250;
  const panelGap = 38;
  const firstPanelX = 82;
  const panelTop = 128;
  const panelHeight = 250;
  const labelY = panelTop + panelHeight + 27;
  const panelSvg = panels.map((panel, panelIndex) => {
    const x0 = firstPanelX + panelIndex * (panelWidth + panelGap);
    const values = items.flatMap((item) => panel.fields.map((field) => item[field]));
    const max = Math.max(...values, 1) * 1.1;
    const ticks = tickValues(0, max, 4);
    const grid = ticks.map((value) => {
      const y = panelTop + panelHeight - (value / max) * panelHeight;
      return `<line class="grid" x1="${x0}" x2="${x0 + panelWidth}" y1="${y}" y2="${y}"/><text class="label" text-anchor="end" x="${x0 - 7}" y="${y + 4}">${formatNumber(value)}</text>`;
    }).join("");
    const groupWidth = panelWidth / items.length;
    const barGap = 4;
    const barWidth = Math.max(8, (groupWidth - 14 - barGap * (panel.fields.length - 1)) / panel.fields.length);
    const bars = items.map((item, itemIndex) => {
      const groupStart = x0 + itemIndex * groupWidth + (groupWidth - (barWidth * panel.fields.length + barGap * (panel.fields.length - 1))) / 2;
      const each = panel.fields.map((field, fieldIndex) => {
        const value = item[field];
        const barHeight = (value / max) * panelHeight;
        const x = groupStart + fieldIndex * (barWidth + barGap);
        const y = panelTop + panelHeight - barHeight;
        return `<rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" rx="2" fill="${panel.colors[fieldIndex]}"/><text class="label" text-anchor="middle" x="${x + barWidth / 2}" y="${Math.max(panelTop + 12, y - 5)}">${formatNumber(value)}</text>`;
      }).join("");
      const lines = wrapLabel(item.name, 14).slice(0, 2);
      const label = lines.map((line, lineIndex) => `<tspan x="${x0 + itemIndex * groupWidth + groupWidth / 2}" dy="${lineIndex ? 11 : 0}">${escapeXml(line)}</tspan>`).join("");
      return `${each}<text class="label" text-anchor="middle" x="${x0 + itemIndex * groupWidth + groupWidth / 2}" y="${labelY - ((lines.length - 1) * 5)}">${label}</text>`;
    }).join("");
    const legend = panel.fields.length > 1 ? panel.labels.map((label, index) => `<rect x="${x0 + index * 104}" y="${panelTop - 27}" width="10" height="10" fill="${panel.colors[index]}"/><text class="label" x="${x0 + 15 + index * 104}" y="${panelTop - 18}">${escapeXml(label)}</text>`).join("") : "";
    return `<text class="label" x="${x0}" y="${panelTop - 43}" style="font-weight:700">${escapeXml(panel.title)}</text>${legend}${grid}<line class="axis-line" x1="${x0}" x2="${x0 + panelWidth}" y1="${panelTop + panelHeight}" y2="${panelTop + panelHeight}"/>${bars}`;
  }).join("");
  const conversion = items.filter((item) => item.conversion_pct !== null)
    .map((item) => `${item.name}: ${formatNumber(item.conversion_pct)}%`)
    .join("; ");
  const conversionNote = conversion ? `<text class="note" x="${firstPanelX}" y="${height - 52}">Конверсия просмотр → контакт: ${escapeXml(conversion)}.</text>` : "";
  return frame(chart.title, chart.subtitle, `${panelSvg}${conversionNote}`, chart.footer);
}

mkdirSync(outputDir, { recursive: true });
for (const chart of spec.charts) {
  const filename = safeFilename(chart.filename);
  const svg = chart.type === "line" ? lineChart(chart) : chart.type === "price_range" ? priceRangeChart(chart) : chart.type === "market_profile" ? marketProfileChart(chart) : null;
  if (!svg) throw new Error(`Неподдерживаемый тип графика: ${chart.type}`);
  writeFileSync(resolve(outputDir, filename), svg, "utf8");
  console.log(`Создан: ${resolve(outputDir, filename)}`);
}
