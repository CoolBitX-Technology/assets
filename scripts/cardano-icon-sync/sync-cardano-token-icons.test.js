const { test } = require('node:test');
const assert = require('node:assert/strict');

const { subjectToFingerprint, readPngDimensions, decodeLogo } = require('./sync-cardano-token-icons');

const POLICY_ID_HEX_LENGTH = 56;

// Build a minimal PNG buffer: 8-byte signature + 4-byte chunk length + "IHDR" + width + height.
// Enough for readPngDimensions, which only reads the IHDR header, not the pixel data.
function fakePng(width, height) {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

// Golden vectors guard THE one correctness rule: subject → CIP-14 fingerprint must match
// WalletIconUtils.toCardanoFingerprint in the app. If this diverges, every imported icon lands
// at a path the app never requests and silently falls back to the default icon. Both pairs are
// externally anchored (public fingerprints), not computed by this script.
test('subjectToFingerprint matches known public fingerprints', () => {
  // HOSKY (policyId + "HOSKY")
  assert.equal(
    subjectToFingerprint('a0028f350aaabe0545fdcb56b039bfb08e4bb4d8c4d7c3c7d481c235484f534b59'),
    'asset17q7r59zlc3dgw0venc80pdv566q6yguw03f0d9',
  );
  // WMT — World Mobile Token, the token this PR imports
  assert.equal(
    subjectToFingerprint('1d7f33bd23d85e1a25d87d86fac4f199c3197a2f7afeb662a0f34e1e776f726c646d6f62696c65746f6b656e'),
    'asset1h7jsujzt4s8pup6nrzthr9nhajl0gmwhlzcqw7',
  );
});

test('subjectToFingerprint accepts a policyId with an empty asset name (56 hex chars)', () => {
  assert.match(subjectToFingerprint('a'.repeat(POLICY_ID_HEX_LENGTH)), /^asset1/);
});

test('subjectToFingerprint rejects a malformed subject instead of coercing it', () => {
  assert.throws(() => subjectToFingerprint('abc'), /invalid subject/); // too short
  assert.throws(() => subjectToFingerprint('a'.repeat(55)), /invalid subject/); // odd length / < 56
  assert.throws(() => subjectToFingerprint(`${'a'.repeat(POLICY_ID_HEX_LENGTH)}zz`), /invalid subject/); // non-hex
  assert.throws(() => subjectToFingerprint(undefined), /invalid subject/);
});

test('decodeLogo skips missing and non-PNG logos, keeps a real PNG', () => {
  assert.equal(decodeLogo({}).skip, 'no-logo');
  assert.equal(decodeLogo({ logo: { value: Buffer.from('not a png').toString('base64') } }).skip, 'not-png');
  const png = fakePng(167, 167);
  assert.deepEqual(decodeLogo({ logo: { value: png.toString('base64') } }).png, png);
});

test('readPngDimensions reads IHDR, and rejects short or non-IHDR buffers', () => {
  assert.deepEqual(readPngDimensions(fakePng(167, 200)), { width: 167, height: 200 });
  assert.equal(readPngDimensions(Buffer.alloc(10)), null); // too short for an IHDR
  const noIhdr = fakePng(64, 64);
  noIhdr.write('XXXX', 12, 'latin1'); // first chunk is not IHDR
  assert.equal(readPngDimensions(noIhdr), null);
});
