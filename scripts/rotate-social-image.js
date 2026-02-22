#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const opts = {
    dir: 'src/ui/public/social-variants-upgraded',
    target: 'src/ui/public/social.png',
    state: 'src/ui/public/social-rotation-state.json',
    mode: 'next', // next | current | random | index
    index: null,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dir' && argv[i + 1]) {
      opts.dir = argv[++i];
    } else if (arg === '--target' && argv[i + 1]) {
      opts.target = argv[++i];
    } else if (arg === '--state' && argv[i + 1]) {
      opts.state = argv[++i];
    } else if (arg === '--mode' && argv[i + 1]) {
      opts.mode = argv[++i];
    } else if (arg === '--index' && argv[i + 1]) {
      opts.index = Number(argv[++i]);
      opts.mode = 'index';
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    }
  }

  return opts;
}

function usage() {
  console.log([
    'Usage: node scripts/rotate-social-image.js [options]',
    '',
    'Options:',
    '  --dir <path>      Variant folder (default: src/ui/public/social-variants-upgraded)',
    '  --target <path>   Target social image path (default: src/ui/public/social.png)',
    '  --state <path>    Rotation state JSON path (default: src/ui/public/social-rotation-state.json)',
    '  --mode <mode>     next | current | random | index (default: next)',
    '  --index <n>       Select specific variant index (0-based); same as --mode index',
    '  --dry-run         Print chosen file but do not copy',
  ].join('\n'));
}

function readState(statePath) {
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function pickIndex(mode, files, previous, explicitIndex) {
  const total = files.length;
  if (total === 0) return -1;

  if (mode === 'index') {
    const idx = Number(explicitIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= total) {
      throw new Error(`--index must be an integer between 0 and ${total - 1}`);
    }
    return idx;
  }

  if (mode === 'current') {
    if (previous && Number.isInteger(previous.index) && previous.index >= 0 && previous.index < total) {
      return previous.index;
    }
    return 0;
  }

  if (mode === 'random') {
    return Math.floor(Math.random() * total);
  }

  if (previous && Number.isInteger(previous.index)) {
    return (previous.index + 1) % total;
  }
  return 0;
}

function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function safeCopy(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return;
  }

  const root = process.cwd();
  const dirPath = path.resolve(root, opts.dir);
  const targetPath = path.resolve(root, opts.target);
  const statePath = path.resolve(root, opts.state);

  if (!fs.existsSync(dirPath)) {
    throw new Error(`Variant directory not found: ${dirPath}`);
  }

  const files = fs.readdirSync(dirPath)
    .filter((name) => name.toLowerCase().endsWith('.png'))
    .sort(naturalSort);

  if (!files.length) {
    throw new Error(`No PNG variants found in: ${dirPath}`);
  }

  const previous = readState(statePath);
  const index = pickIndex(opts.mode, files, previous, opts.index);
  const pickedFile = files[index];
  const sourcePath = path.join(dirPath, pickedFile);

  if (!opts.dryRun) {
    safeCopy(sourcePath, targetPath);

    const outTarget = path.resolve(root, 'out/ui/social.png');
    if (outTarget !== targetPath && fs.existsSync(path.dirname(outTarget))) {
      safeCopy(sourcePath, outTarget);
    }

    const state = {
      index,
      file: pickedFile,
      sourceDir: path.relative(root, dirPath),
      target: path.relative(root, targetPath),
      total: files.length,
      rotatedAt: new Date().toISOString(),
      mode: opts.mode,
    };

    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
  }

  console.log(`Selected variant [${index + 1}/${files.length}]: ${pickedFile}`);
  console.log(`Source: ${sourcePath}`);
  console.log(`Target: ${targetPath}`);
  if (opts.dryRun) console.log('Dry run: no files written.');
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
