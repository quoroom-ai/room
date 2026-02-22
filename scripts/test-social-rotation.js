#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

function parseArgs(argv) {
  const opts = {
    dir: 'src/ui/public/social-variants-upgraded',
    target: 'src/ui/public/social.png',
    state: 'src/ui/public/social-rotation-state.json',
    html: 'src/ui/index.html',
    url: process.env.SOCIAL_TEST_URL || 'http://127.0.0.1:3700/social.png',
    strictHeaders: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dir' && argv[i + 1]) opts.dir = argv[++i];
    else if (arg === '--target' && argv[i + 1]) opts.target = argv[++i];
    else if (arg === '--state' && argv[i + 1]) opts.state = argv[++i];
    else if (arg === '--url' && argv[i + 1]) opts.url = argv[++i];
    else if (arg === '--strict-headers') opts.strictHeaders = true;
  }

  return opts;
}

function run(cmd) {
  return execSync(cmd, { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function fileHash(filePath) {
  const abs = path.resolve(process.cwd(), filePath);
  const data = fs.readFileSync(abs);
  return crypto.createHash('md5').update(data).digest('hex');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), filePath), 'utf8'));
}

async function checkCacheHeader(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return {
      ok: true,
      status: res.status,
      cacheControl: res.headers.get('cache-control') || '',
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const issues = [];
  const notes = [];

  const variantDir = path.resolve(process.cwd(), opts.dir);
  if (!fs.existsSync(variantDir)) {
    throw new Error(`Variant directory not found: ${variantDir}`);
  }

  const variants = fs.readdirSync(variantDir).filter((n) => n.toLowerCase().endsWith('.png')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  if (!variants.length) throw new Error(`No PNG variants in ${opts.dir}`);

  const beforeHash = fileHash(opts.target);

  const dryOut = run(`node scripts/rotate-social-image.js --dir ${opts.dir} --dry-run`);
  if (!/Dry run: no files written\./.test(dryOut)) {
    issues.push('Dry-run output did not confirm no writes.');
  }

  run(`node scripts/rotate-social-image.js --dir ${opts.dir}`);
  const state1 = readJson(opts.state);
  const hash1 = fileHash(opts.target);

  run(`node scripts/rotate-social-image.js --dir ${opts.dir}`);
  const state2 = readJson(opts.state);
  const hash2 = fileHash(opts.target);

  if (!Number.isInteger(state2.index) || !state2.file || !state2.rotatedAt) {
    issues.push('Rotation state JSON is missing expected fields (index/file/rotatedAt).');
  }

  if (variants.length > 1) {
    if (state2.index === state1.index) {
      issues.push('Rotation index did not advance between two runs.');
    }
    if (hash2 === hash1) {
      issues.push('social.png hash did not change after second rotation.');
    }
  } else {
    notes.push('Only one variant exists; index/hash change checks are skipped.');
  }

  if (beforeHash === hash2 && variants.length > 1) {
    notes.push('Hash wrapped back to original after two rotations (possible with small variant count).');
  }

  const html = fs.readFileSync(path.resolve(process.cwd(), opts.html), 'utf8');
  if (!/<meta\s+property="og:image"\s+content="\/social\.png"\s*\/>/i.test(html)) {
    issues.push('src/ui/index.html og:image is not set to /social.png');
  }

  const headerCheck = await checkCacheHeader(opts.url);
  if (headerCheck.ok) {
    const cc = headerCheck.cacheControl.toLowerCase();
    const isExpected = cc.includes('no-cache') || cc.includes('must-revalidate') || cc.includes('max-age=0');
    if (!isExpected) {
      const msg = `Unexpected cache-control for ${opts.url}: "${headerCheck.cacheControl}" (restart server after cache-policy change).`;
      if (opts.strictHeaders) issues.push(msg);
      else notes.push(msg);
    }
  } else {
    notes.push(`Skipped HTTP cache-header check (${opts.url} unreachable: ${headerCheck.error}).`);
  }

  if (issues.length) {
    console.error('social:test FAILED');
    for (const issue of issues) console.error(`- ${issue}`);
    for (const note of notes) console.error(`- Note: ${note}`);
    process.exit(1);
  }

  console.log('social:test PASSED');
  console.log(`- Variants: ${variants.length}`);
  console.log(`- Current selection: ${state2.file} (index ${state2.index})`);
  console.log(`- social.png hash: ${hash2}`);
  for (const note of notes) console.log(`- Note: ${note}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
