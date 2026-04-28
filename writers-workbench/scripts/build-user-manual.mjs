/**
 * Build a self-contained user manual:
 *   1. PRODUCTION_WEB_UI_USER_MANUAL.html — single file, all images base64-embedded
 *   2. PRODUCTION_WEB_UI_USER_MANUAL.pdf  — print-ready
 *
 * Usage:  node scripts/build-user-manual.mjs
 */

import { marked } from 'marked';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const SHOTS = path.join(DOCS, 'screenshots');
const SRC = path.join(DOCS, 'PRODUCTION_WEB_UI_USER_MANUAL.md');
const OUT_HTML = path.join(DOCS, 'PRODUCTION_WEB_UI_USER_MANUAL.html');
const OUT_PDF = path.join(DOCS, 'PRODUCTION_WEB_UI_USER_MANUAL.pdf');

console.log('Reading markdown...');
let md = fs.readFileSync(SRC, 'utf-8');

// Inline every image reference as base64 data URI
console.log('Inlining screenshots as base64...');
const imgRegex = /!\[([^\]]*)\]\(\.\/screenshots\/([^)]+)\)/g;
let inlined = 0;
md = md.replace(imgRegex, (_, alt, file) => {
  const fullPath = path.join(SHOTS, file);
  if (!fs.existsSync(fullPath)) {
    console.warn(`  ⚠️  missing: ${file}`);
    return `*[image not found: ${file}]*`;
  }
  const b64 = fs.readFileSync(fullPath).toString('base64');
  inlined++;
  return `![${alt}](data:image/png;base64,${b64})`;
});
console.log(`  inlined ${inlined} screenshots`);

// Configure marked
marked.use({
  gfm: true,
  breaks: false,
});

const body = marked.parse(md);

// Wrap with a clean print-friendly stylesheet
const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>The Writers Workbench — Production User Manual</title>
<style>
  :root {
    --fg: #1a202c;
    --fg-muted: #4a5568;
    --bg: #ffffff;
    --bg-muted: #f7fafc;
    --border: #e2e8f0;
    --brand: #2563eb;
    --brand-muted: #dbeafe;
    --code-bg: #f1f5f9;
    --code-fg: #0f172a;
    --warn-bg: #fef3c7;
    --warn-border: #fbbf24;
  }
  * { box-sizing: border-box; }
  html, body {
    font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
    color: var(--fg);
    background: var(--bg);
    line-height: 1.65;
    margin: 0;
    padding: 0;
  }
  body {
    max-width: 880px;
    margin: 0 auto;
    padding: 48px 56px;
    font-size: 15px;
  }
  h1, h2, h3, h4, h5 {
    font-weight: 600;
    color: var(--fg);
    line-height: 1.3;
    margin-top: 1.8em;
    margin-bottom: 0.6em;
    page-break-after: avoid;
  }
  h1 {
    font-size: 2.4em;
    border-bottom: 2px solid var(--border);
    padding-bottom: 0.4em;
    margin-top: 0;
    page-break-before: auto;
  }
  h2 {
    font-size: 1.7em;
    border-bottom: 1px solid var(--border);
    padding-bottom: 0.3em;
    margin-top: 2.4em;
    page-break-before: auto;
  }
  h3 { font-size: 1.25em; color: var(--brand); }
  h4 { font-size: 1.05em; }
  p, ul, ol { margin: 0.6em 0; }
  ul, ol { padding-left: 1.6em; }
  li { margin: 0.2em 0; }
  a {
    color: var(--brand);
    text-decoration: none;
    border-bottom: 1px solid transparent;
  }
  a:hover { border-bottom-color: var(--brand); }
  code {
    background: var(--code-bg);
    color: var(--code-fg);
    padding: 0.15em 0.4em;
    border-radius: 4px;
    font-size: 0.9em;
    font-family: "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
  }
  pre {
    background: var(--code-bg);
    color: var(--code-fg);
    padding: 1em 1.2em;
    border-radius: 8px;
    overflow-x: auto;
    font-size: 0.85em;
    line-height: 1.5;
    page-break-inside: avoid;
  }
  pre code {
    background: none;
    padding: 0;
    color: inherit;
  }
  blockquote {
    border-left: 4px solid var(--brand);
    background: var(--brand-muted);
    margin: 1.2em 0;
    padding: 0.8em 1.2em;
    color: var(--fg);
    border-radius: 4px;
  }
  blockquote p { margin: 0.4em 0; }
  table {
    border-collapse: collapse;
    width: 100%;
    margin: 1em 0;
    font-size: 0.93em;
    page-break-inside: avoid;
  }
  th, td {
    border: 1px solid var(--border);
    padding: 0.5em 0.8em;
    text-align: left;
    vertical-align: top;
  }
  th {
    background: var(--bg-muted);
    font-weight: 600;
  }
  tr:nth-child(even) td { background: var(--bg-muted); }
  img {
    max-width: 100%;
    height: auto;
    border: 1px solid var(--border);
    border-radius: 6px;
    margin: 1em 0;
    box-shadow: 0 2px 8px rgba(0,0,0,0.08);
    page-break-inside: avoid;
  }
  hr {
    border: none;
    border-top: 1px solid var(--border);
    margin: 2.4em 0;
  }
  strong { color: var(--fg); font-weight: 600; }

  /* Print styles */
  @media print {
    body {
      max-width: none;
      padding: 0;
      font-size: 11pt;
    }
    h1 { page-break-before: always; }
    h1:first-of-type { page-break-before: auto; }
    h2, h3 { page-break-after: avoid; }
    img { max-width: 100%; }
    a { color: inherit; border-bottom: none; }
    pre, blockquote, table, img { page-break-inside: avoid; }
  }
  @page {
    margin: 0.75in 0.6in;
    size: letter;
  }
</style>
</head>
<body>
${body}
</body>
</html>
`;

console.log('Writing HTML...');
fs.writeFileSync(OUT_HTML, html);
const htmlSizeMB = (fs.statSync(OUT_HTML).size / 1024 / 1024).toFixed(2);
console.log(`  ✓ ${path.relative(ROOT, OUT_HTML)} (${htmlSizeMB} MB)`);

console.log('Generating PDF via headless Chromium...');
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.emulateMedia({ media: 'print' });
  await page.pdf({
    path: OUT_PDF,
    format: 'Letter',
    margin: { top: '0.75in', right: '0.6in', bottom: '0.75in', left: '0.6in' },
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: `<div style="font-size: 8pt; color: #6b7280; width: 100%; padding: 0 0.6in; text-align: right;">The Writers Workbench — User Manual</div>`,
    footerTemplate: `<div style="font-size: 8pt; color: #6b7280; width: 100%; padding: 0 0.6in; display: flex; justify-content: space-between;"><span>Course Worx Media</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
  });
  const pdfSizeMB = (fs.statSync(OUT_PDF).size / 1024 / 1024).toFixed(2);
  console.log(`  ✓ ${path.relative(ROOT, OUT_PDF)} (${pdfSizeMB} MB)`);
} finally {
  await browser.close();
}

console.log('\nDone.');
