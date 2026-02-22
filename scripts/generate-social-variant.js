#!/usr/bin/env node
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const text = process.argv[2];
const outputArg = process.argv[3] || 'src/ui/public/social-test.png';
const eyebrowArg = process.argv[4] || '';
const sublineArg = process.argv[5] || '';
const themeArg = (process.argv[6] || 'default').toLowerCase();

if (!text) {
  console.error('Usage: node scripts/generate-social-variant.js "Headline" [output-path] [eyebrow] [subline] [theme]');
  process.exit(1);
}

const projectRoot = process.cwd();
const basePath = path.resolve(projectRoot, 'src/ui/public/social-template.png');
const outputPath = path.resolve(projectRoot, outputArg);
const themes = {
  default: { main: '#ffb35a', highlight: '#ffd27a', eyebrow: '#cfd8ff', subline: '#b8c5f2' },
  research: { main: '#ffbe66', highlight: '#ffe08f', eyebrow: '#d8e2ff', subline: '#bcc9f5' },
  money: { main: '#ffb35a', highlight: '#9ff3c8', eyebrow: '#d5ddff', subline: '#b6c4f2' },
  persist: { main: '#ffad55', highlight: '#ffe08f', eyebrow: '#d6deff', subline: '#bac7f4' },
};
const theme = themes[themeArg] || themes.default;

if (!fs.existsSync(basePath)) {
  console.error(`Template image not found: ${basePath}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });

const stripTrailingDots = (input) => input.trim().replace(/\.+$/g, '').trim();
const toTwoLines = (input) => {
  const normalized = input.replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.includes('\n')) return normalized;

  const words = normalized.split(' ');
  if (words.length < 3) return normalized;

  let bestSplit = 1;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let i = 1; i < words.length; i += 1) {
    const left = words.slice(0, i).join(' ');
    const right = words.slice(i).join(' ');
    const diff = Math.abs(left.length - right.length);
    const shortPenalty = Math.max(0, 16 - Math.min(left.length, right.length)) * 4;
    const score = diff + shortPenalty;
    if (score < bestScore) {
      bestScore = score;
      bestSplit = i;
    }
  }

  return `${words.slice(0, bestSplit).join(' ')}\n${words.slice(bestSplit).join(' ')}`;
};

const escapeHtml = (input) => input
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const formatRichText = (input) => input
  .split(/(\*[^*]+\*)/g)
  .map((part) => {
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      return `<span class="hl">${escapeHtml(part.slice(1, -1))}</span>`;
    }
    return escapeHtml(part);
  })
  .join('')
  .replace(/\n/g, '<br />');

const cleanedText = toTwoLines(stripTrailingDots(text));
const cleanedEyebrow = stripTrailingDots(eyebrowArg);
const cleanedSubline = stripTrailingDots(sublineArg);
const plainHeadline = cleanedText.replace(/\*([^*]+)\*/g, '$1').replace(/\n/g, ' ').trim();
const headlineLength = plainHeadline.length;
const headlineFontSize = headlineLength > 100 ? 78
  : headlineLength > 88 ? 86
    : headlineLength > 76 ? 94
      : headlineLength > 64 ? 102
        : 118;
const headlineTop = headlineLength > 90 ? 400 : 395;
const headlineWidth = headlineLength > 90 ? 1960 : 1920;

const escapedText = formatRichText(cleanedText);
const secondaryLine = cleanedEyebrow || cleanedSubline;
const escapedSecondaryLine = escapeHtml(secondaryLine);
const secondaryLineHtml = escapedSecondaryLine ? `<div class="secondary-line">${escapedSecondaryLine}</div>` : '';

const basePngBase64 = fs.readFileSync(basePath, 'base64');
const baseUrl = `data:image/png;base64,${basePngBase64}`;

const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body {
        margin: 0;
        width: 2120px;
        height: 896px;
        overflow: hidden;
        background: #04081f;
      }
      .frame {
        position: relative;
        width: 2120px;
        height: 896px;
      }
      .bg {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
        object-position: center;
      }
      .headline {
        position: absolute;
        left: 50%;
        top: ${headlineTop}px;
        transform: translateX(-50%);
        width: ${headlineWidth}px;
        color: ${theme.main};
        text-align: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
        font-size: ${headlineFontSize}px;
        line-height: 1.05;
        font-weight: 800;
        letter-spacing: -0.03em;
        text-shadow: 0 6px 24px rgba(0, 0, 0, 0.55), 0 0 28px rgba(255, 179, 90, 0.22);
      }
      .headline .hl {
        color: ${theme.highlight};
      }
      .secondary-line {
        position: absolute;
        left: 50%;
        top: 320px;
        transform: translateX(-50%);
        color: #8e95ad;
        text-transform: uppercase;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
        font-size: 22px;
        font-weight: 600;
        letter-spacing: 0.16em;
        opacity: 0.9;
      }
    </style>
  </head>
  <body>
    <div class="frame">
      <img class="bg" src="${baseUrl}" alt="social frame" />
      ${secondaryLineHtml}
      <div class="headline">${escapedText}</div>
    </div>
  </body>
</html>`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 2120, height: 896 } });
  await page.setContent(html, { waitUntil: 'load' });
  await page.screenshot({ path: outputPath, type: 'png' });
  await browser.close();
  console.log(`Wrote ${outputPath}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
