/**
 * Pure SHA-256 over a JS string, returning the lowercase hex digest.
 *
 * A document rewrite request must carry the SHA-256 of the exact selected
 * text (UTF-8 encoded) from the saved base revision, and the hash has to be
 * byte-identical to the server's `node:crypto` digest. A pure implementation
 * keeps the browser and the jsdom test environment deterministic without a
 * SubtleCrypto availability fork. Inputs are bounded selection/section text,
 * so the straightforward implementation is plenty fast.
 */

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
];

/** UTF-8 encode a JS string without TextEncoder (identical bytes, jsdom-safe). */
function utf8Bytes(text: string): number[] {
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    let code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
        index += 1;
      }
    }
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else
      bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return bytes;
}

const HEX = "0123456789abcdef";

function hex32(value: number): string {
  let out = "";
  for (let shift = 28; shift >= 0; shift -= 4) out += HEX[(value >>> shift) & 0xf];
  return out;
}

export function sha256Hex(text: string): string {
  const bytes = utf8Bytes(text);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  // 64-bit big-endian length; inputs are far below 2^32 bits.
  bytes.push(0, 0, 0, Math.floor(bitLength / 0x100000000) & 0xff);
  bytes.push((bitLength >>> 24) & 0xff, (bitLength >>> 16) & 0xff, (bitLength >>> 8) & 0xff, bitLength & 0xff);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Int32Array(64);

  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      const j = offset + i * 4;
      w[i] = (bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3] | 0;
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = w[i - 15];
      const s1 = w[i - 2];
      const rotate = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));
      const sigma0 = (rotate(s0, 7) ^ rotate(s0, 18) ^ (s0 >>> 3)) | 0;
      const sigma1 = (rotate(s1, 17) ^ rotate(s1, 19) ^ (s1 >>> 10)) | 0;
      w[i] = (w[i - 16] + sigma0 + w[i - 7] + sigma1) | 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i += 1) {
      const rotate = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));
      const sum1 = (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) | 0;
      const ch = ((e & f) ^ (~e & g)) | 0;
      const temp1 = (h + sum1 + ch + K[i] + w[i]) | 0;
      const sum0 = (rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) | 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) | 0;
      const temp2 = (sum0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map(hex32).join("");
}

/** True when `boundary` sits strictly inside a surrogate pair of `text`. */
export function splitsSurrogatePair(text: string, boundary: number): boolean {
  if (boundary <= 0 || boundary >= text.length) return false;
  const before = text.charCodeAt(boundary - 1);
  const after = text.charCodeAt(boundary);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}
