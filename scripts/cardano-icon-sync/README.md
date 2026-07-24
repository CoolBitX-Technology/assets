# cardano-icon-sync

Import Cardano token icons from the [Cardano Foundation token registry](https://github.com/cardano-foundation/cardano-token-registry)
into `blockchains/cardano/assets/<fingerprint>/logo.png`.

## Why

The asset repo only holds a handful of Cardano token icons, so most Cardano native
tokens fall back to a generic default icon in the app. The Cardano Foundation registry
carries a base64 PNG `logo` for thousands of tokens; this script materializes those into
the asset repo so `WalletIcon` can serve them by URL like any other chain.

## Scope: logo only

This script writes **`logo.png` only** — no sibling `info.json`. The app fetches only
`<fingerprint>/logo.png` (see `WalletIconUtils.getWalletIconUrl`) and never reads an
`info.json`, and this repo does not run the trustwallet `make check` CI, so a lone
`logo.png` is all that is needed to render an icon. If that CI is ever enabled (it would
then require an `info.json` per asset dir), add the metadata generation in a follow-up.

## The one correctness rule

The asset repo keys Cardano icons by **CIP-14 asset fingerprint** (`asset1…`), but the
registry keys entries by **`subject`** (= `policyId` + `assetNameHex`, hex). This script
converts `subject → fingerprint` with `@emurgo/cip14-js` — the **same library the app uses**
(`WalletIconUtils.toCardanoFingerprint`). If that conversion ever diverges from the app,
every imported icon points to the wrong path and silently fails to load. Do not swap the
fingerprint logic without matching the app. A malformed `subject` is rejected up front
rather than coerced into a wrong-but-valid-looking fingerprint.

## Usage

```bash
npm install

# one token from a single mapping file (used for the initial validation PR)
node sync-cardano-token-icons.js --file <subject>.json --out <asset-repo-root>

# all tokens from a local registry clone
git clone https://github.com/cardano-foundation/cardano-token-registry.git /tmp/ctr
node sync-cardano-token-icons.js --registry /tmp/ctr --out <asset-repo-root>

# size estimate only, write nothing
node sync-cardano-token-icons.js --registry /tmp/ctr --dry-run
```

Flags: `--subject <hex>` (one entry), `--limit <N>` (cap), `--dry-run` (report only),
`--overwrite` (replace icons that already exist; default keeps them).

By default the script **skips fingerprints that already have a `logo.png`**, so a full run
never clobbers hand-curated icons. Pass `--overwrite` to intentionally replace them. The
existing-icon check also runs under `--dry-run` (when `--out` is given), so the size estimate
matches what a real run would actually write.

## Dimension / size rules

There is no `make check` CI in this repo, so these bounds are icon **hygiene**, not a hard
gate — but they keep the imported set sane and future-proof against that CI being enabled
(`60 ≤ edge ≤ 512`, `≤ 100 KB`). Each logo is handled as:

- no `logo` field, not PNG, or a truncated / non-IHDR header → **skip**;
- edge `< 60px` → **skip** (no upscaling);
- edge `> 512px` → **downscale to 512px** with macOS `sips`, preserving aspect ratio
  (reported as `resized`). Without `sips` on PATH (e.g. on Linux) these are **skipped**
  instead and the run prints a warning;
- still `> 100 KB` after any downscale → **skip** (`sips -Z` shrinks dimensions, not the
  compressed byte size, so a dense 512px PNG can still exceed the cap).

## Tests

```bash
npm test   # subject → fingerprint golden vectors (HOSKY, WMT), subject validation, PNG gating
```
