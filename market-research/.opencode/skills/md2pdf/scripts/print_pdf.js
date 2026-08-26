// HTML/URL -> PDF via Playwright + headless Edge/Chrome.
// Usage: node print_pdf.js <source.html|url> <output.pdf> [footer-text]
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');

const EDGE_CANDIDATES = [
  process.env.CHROME_EXE,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

function toUrl(src) {
  if (/^https?:\/\//i.test(src)) return src;
  return pathToFileURL(path.resolve(src)).href;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

(async () => {
  const [,, src, out, footer] = process.argv;
  if (!src || !out) {
    console.error('usage: node print_pdf.js <source.html|url> <output.pdf> [footer-text]');
    process.exit(1);
  }
  const exe = EDGE_CANDIDATES.find(p => p && require('fs').existsSync(p));
  if (!exe) {
    console.error('no Edge/Chrome found; set CHROME_EXE');
    process.exit(1);
  }
  const footerText = footer ? esc(footer) + ' \u00b7 ' : '';
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const page = await browser.newPage();
  await page.goto(toUrl(src), { waitUntil: 'networkidle' });
  await page.pdf({
    path: out,
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: true,
    margin: { top: '16mm', bottom: '18mm', left: '15mm', right: '15mm' },
    headerTemplate: '<div></div>',
    footerTemplate:
      `<div style="width:100%;text-align:center;font-size:8px;color:#666;">${footerText}` +
      '<span class="pageNumber"></span>/<span class="totalPages"></span></div>',
  });
  await browser.close();
  console.log('OK pdf:', path.resolve(out));
})().catch(e => { console.error(e); process.exit(1); });