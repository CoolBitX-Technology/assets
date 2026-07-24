/*
 * Sync Cardano Foundation token-registry icons into the CoolBitX asset repo.
 *
 * WHY: the asset repo only holds a handful of Cardano token icons, so most Cardano
 * native tokens fall back to the generic default icon. The Cardano Foundation token
 * registry (github.com/cardano-foundation/cardano-token-registry) carries a base64 PNG
 * logo for thousands of tokens — this imports those logos so WalletIcon can serve them
 * by URL like any other chain.
 *
 * SCOPE: logo.png only. The app fetches only <fingerprint>/logo.png and never reads a
 * sibling info.json, and this repo does not run the trustwallet `make check` CI, so a
 * lone logo.png is all that is needed. (If that CI is ever enabled, generate the
 * required info.json in a follow-up — it is intentionally out of scope here.)
 *
 * KEY CORRECTNESS POINT: the asset repo keys Cardano icons by CIP-14 asset fingerprint
 * (asset1…), but the registry keys entries by `subject` (= policyId + assetNameHex, hex).
 * We MUST convert subject → fingerprint with the SAME logic the app uses
 * (WalletIconUtils.toCardanoFingerprint), or the app's generated URL won't match the file.
 *
 * Only entries that actually carry a `logo` are imported; the rest keep the default icon.
 * Oversized logos (> 512 px edge) are downscaled with macOS `sips` rather than skipped, so
 * the long-tail set that ships large official art is not lost. Without `sips` (e.g. on
 * Linux) the script falls back to skipping them.
 *
 * Usage:
 *   # one token from a single mapping file (test / draft PR):
 *   node sync-cardano-token-icons.js --file <mapping.json> --out <assetRepoRoot>
 *
 *   # all tokens from a local registry clone:
 *   node sync-cardano-token-icons.js --registry <cardano-token-registry> --out <assetRepoRoot>
 *
 *   # size estimate only, write nothing:
 *   node sync-cardano-token-icons.js --registry <...> --dry-run
 *
 * Flags: --subject <hex> (filter to one), --limit <N> (cap count), --dry-run,
 *        --overwrite (replace icons that already exist; default is to keep them).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const cip14 = require('@emurgo/cip14-js');
const AssetFingerprint = cip14.default || cip14;

const POLICY_ID_HEX_LENGTH = 56;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// IHDR chunk type, immediately after the 8-byte signature + 4-byte chunk length (offset 12).
const IHDR_TYPE = Buffer.from('IHDR', 'latin1');

// This repo does not run the trustwallet `make check` CI, so these bounds are our own icon
// hygiene rather than a hard gate: keep every committed logo between 60 and 512 px per edge
// and under 100 KB. A logo below MIN_EDGE is skipped (we don't upscale); one above MAX_EDGE is
// downscaled to MAX_EDGE with `sips` (see downscaleToMaxEdge), which also brings its byte size
// down, so the 100 KB check runs on the final (post-resize) bytes.
const MIN_EDGE = 60;
const MAX_EDGE = 512;
const MAX_BYTES = 100 * 1024;

// Read width/height straight from the PNG IHDR (bytes 16..24) — no image lib needed. Returns
// null for a buffer that is too short or whose first chunk is not IHDR (truncated / malformed
// PNG), so callers skip it instead of trusting width/height read off arbitrary bytes.
function readPngDimensions(buf) {
  if (buf.length < 24) return null;
  if (!buf.subarray(12, 16).equals(IHDR_TYPE)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// True if macOS `sips` is on PATH. Detected once so the per-entry path never pays for a probe.
function hasSips() {
  try {
    execFileSync('sips', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Downscale a PNG so its longest edge is <= MAX_EDGE, preserving aspect ratio, via macOS `sips`
// (no npm image dependency). `sips` only works on files, so we round-trip through tmpDir.
// `-Z` caps the longest edge and keeps the ratio (unlike `-z`, which forces exact WxH). It only
// shrinks, never upscales, so it's safe to call on anything already at/under the cap too.
function downscaleToMaxEdge(buf, tmpDir) {
  const inPath = path.join(tmpDir, 'in.png');
  const outPath = path.join(tmpDir, 'out.png');
  fs.writeFileSync(inPath, buf);
  execFileSync('sips', ['-Z', String(MAX_EDGE), inPath, '--out', outPath], { stdio: 'ignore' });
  return fs.readFileSync(outPath);
}

// Returns PNG bytes, or a skip reason.
function decodeLogo(mapping) {
  const b64 = mapping && mapping.logo && mapping.logo.value;
  if (!b64) return { skip: 'no-logo' };
  const buf = Buffer.from(b64, 'base64');
  // Registry logos are declared PNG; guard against malformed entries anyway.
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_MAGIC)) return { skip: 'not-png' };
  return { png: buf };
}

// Mirror of WalletIconUtils.toCardanoFingerprint — keep in lockstep with the app.
// A malformed subject would otherwise be silently coerced by Buffer.from(_, 'hex') into a
// valid-looking-but-wrong fingerprint, writing the logo to a path the app never requests
// (silent default-icon fallback). Reject anything that is not >= a full policyId of hex.
function subjectToFingerprint(subject) {
  if (
    typeof subject !== 'string' ||
    subject.length < POLICY_ID_HEX_LENGTH ||
    subject.length % 2 !== 0 ||
    !/^[0-9a-fA-F]+$/.test(subject)
  ) {
    throw new Error(`invalid subject (expected >= ${POLICY_ID_HEX_LENGTH} hex chars): ${subject}`);
  }
  const policyId = subject.slice(0, POLICY_ID_HEX_LENGTH);
  const assetNameHex = subject.slice(POLICY_ID_HEX_LENGTH);
  return AssetFingerprint.fromParts(
    new Uint8Array(Buffer.from(policyId, 'hex')),
    new Uint8Array(Buffer.from(assetNameHex, 'hex')),
  ).fingerprint();
}

// Read the value following a value-taking flag; reject a missing value or another flag,
// so `--file` (no value) fails with a clear message instead of a cryptic downstream error.
function requireValue(value, flag) {
  if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
  return value;
}

function parseArgs(argv) {
  const args = { limit: Infinity, dryRun: false, overwrite: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--overwrite') args.overwrite = true;
    else if (a === '--file') args.file = requireValue(argv[++i], a);
    else if (a === '--registry') args.registry = requireValue(argv[++i], a);
    else if (a === '--out') args.out = requireValue(argv[++i], a);
    else if (a === '--subject') args.subject = requireValue(argv[++i], a);
    else if (a === '--limit') {
      const raw = requireValue(argv[++i], a);
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`--limit must be a positive integer, got: ${raw}`);
      args.limit = n;
    } else throw new Error(`Unknown arg: ${a}`);
  }
  return args;
}

// Yields parsed mapping objects from either a single file or a registry clone.
function* readMappings(args) {
  if (args.file) {
    yield JSON.parse(fs.readFileSync(args.file, 'utf8'));
    return;
  }
  if (!args.registry) throw new Error('Provide --file or --registry');
  const dir = path.join(args.registry, 'mappings');
  // The registry names every mapping file after its `subject`, so --subject reads exactly one
  // file instead of scanning the whole directory — this is the sole subject filter (the main
  // loop no longer re-filters, since an exact filename match is already exact).
  const files = args.subject ? [`${args.subject}.json`] : fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    const full = path.join(dir, f);
    if (!fs.existsSync(full)) continue;
    try {
      yield JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (e) {
      console.warn(`skip ${f}: parse error ${e.message}`);
    }
  }
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.dryRun && !args.out) throw new Error('Provide --out <assetRepoRoot> (or --dry-run)');

  const canResize = hasSips();
  if (!canResize) {
    console.warn(`sips not found — logos > ${MAX_EDGE}px will be skipped instead of downscaled (run on macOS to include them).`);
  }
  // One temp dir for the whole run; downscaleToMaxEdge reuses in.png/out.png inside it.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cardano-icon-'));

  const stats = { processed: 0, written: 0, resized: 0, noLogo: 0, notPng: 0, tooSmall: 0, tooLarge: 0, tooHeavy: 0, skippedExisting: 0, errors: 0, bytes: 0 };
  const samples = [];

  try {
    for (const mapping of readMappings(args)) {
      if (stats.written >= args.limit) break;
      stats.processed++;

      // Isolate per-entry failures: one malformed entry (bad hex subject, sips error, write
      // error, …) is counted and skipped, never allowed to abort a multi-thousand-token run.
      try {
        const decoded = decodeLogo(mapping);
        if (decoded.skip === 'no-logo') { stats.noLogo++; continue; }
        if (decoded.skip === 'not-png') { stats.notPng++; continue; }

        const dims = readPngDimensions(decoded.png);
        if (!dims) { stats.notPng++; continue; } // truncated / non-IHDR: no readable dimensions
        const { width, height } = dims;
        if (width < MIN_EDGE || height < MIN_EDGE) { stats.tooSmall++; continue; } // no upscaling

        const fingerprint = subjectToFingerprint(mapping.subject);
        const relDir = path.join('blockchains', 'cardano', 'assets', fingerprint);
        const relPath = path.join(relDir, 'logo.png');

        // Keep already-curated icons unless explicitly told to replace them. Checked before any
        // downscale so we don't spend sips on an entry we're going to skip. Runs in --dry-run too
        // (when --out is known) so the estimate matches what a real run would actually write.
        const outDir = args.out ? path.join(args.out, relDir) : undefined;
        if (outDir && !args.overwrite && fs.existsSync(path.join(outDir, 'logo.png'))) {
          stats.skippedExisting++;
          continue;
        }

        let png = decoded.png;
        if (width > MAX_EDGE || height > MAX_EDGE) {
          if (!canResize) { stats.tooLarge++; continue; } // no sips: fall back to skipping
          png = downscaleToMaxEdge(png, tmpDir);
          stats.resized++;
        }
        if (png.length > MAX_BYTES) { stats.tooHeavy++; continue; }

        if (!args.dryRun) {
          fs.mkdirSync(outDir, { recursive: true });
          fs.writeFileSync(path.join(outDir, 'logo.png'), png);
        }
        stats.written++;
        stats.bytes += png.length;
        if (samples.length < 5) {
          const final = readPngDimensions(png) || { width, height };
          const note = png === decoded.png ? '' : ` resized from ${width}x${height}`;
          samples.push(`${relPath} (${final.width}x${final.height}, ${png.length}B${note})`);
        }
      } catch (e) {
        stats.errors++;
        console.warn(`skip ${mapping.subject || '?'}: ${e.message}`);
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const mb = (stats.bytes / (1024 * 1024)).toFixed(2);
  console.log(`\n${args.dryRun ? '[dry-run] ' : ''}processed=${stats.processed} written=${stats.written} resized(>${MAX_EDGE}px→${MAX_EDGE})=${stats.resized} skipped(no-logo)=${stats.noLogo} skipped(not-png)=${stats.notPng} skipped(<${MIN_EDGE}px)=${stats.tooSmall} skipped(>${MAX_EDGE}px,no-sips)=${stats.tooLarge} skipped(>100KB)=${stats.tooHeavy} skipped(existing)=${stats.skippedExisting} errors=${stats.errors}`);
  console.log(`total logo bytes: ${stats.bytes} (${mb} MiB)`);
  if (samples.length) console.log('samples:\n  ' + samples.join('\n  '));
}

// Only run the CLI when invoked directly; when require()'d by the test file, just export the
// helpers so importing the module doesn't parse the test runner's argv and exit.
if (require.main === module) {
  try {
    main();
  } catch (e) {
    // CLI errors (bad/missing args, unreadable --file/--registry): print one clean line, no stack.
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { subjectToFingerprint, readPngDimensions, decodeLogo };
