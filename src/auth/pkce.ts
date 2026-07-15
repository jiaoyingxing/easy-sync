/**
 * PKCE (Proof Key for Code Exchange) utilities
 *
 * Generates a cryptographically random code_verifier and its
 * S256 code_challenge for the OAuth 2.0 Authorization Code + PKCE flow.
 *
 * Two challenge generators are provided:
 *  - generateCodeChallenge()     — async, uses Web Crypto (crypto.subtle)
 *  - generateCodeChallengeSync() — synchronous SHA-256; required on iOS
 *    where any await between the user click and window.open() causes
 *    WKWebView to block the browser popup
 */

/**
 * Generate a PKCE code verifier: 128 bytes of random data,
 * base64url-encoded without padding.
 */
export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(128);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/**
 * Generate the S256 code challenge from a code verifier.
 * SHA-256 hash → base64url without padding.
 */
export async function generateCodeChallenge(
  verifier: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(hash));
}

/**
 * Synchronous S256 code challenge — functionally identical to
 * generateCodeChallenge() but uses an inline SHA-256 so the
 * entire PKCE flow stays on the synchronous click-handler chain.
 *
 * Required on iOS WKWebView: any await between the user tap and
 * window.open() causes the system to treat the window opening as
 * a non-user-initiated popup and block it.
 */
export function generateCodeChallengeSync(verifier: string): string {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = sha256Sync(data);
  return base64UrlEncode(hash);
}

/**
 * Generate a random state string for CSRF protection.
 */
export function generateState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/**
 * Base64url encode (URL-safe, no padding) from a Uint8Array.
 */
function base64UrlEncode(buffer: Uint8Array): string {
  // Convert buffer to binary string
  let binary = "";
  for (let i = 0; i < buffer.length; i++) {
    binary += String.fromCharCode(buffer[i]);
  }
  // Standard base64 → base64url
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---- Synchronous SHA-256 (RFC 6234) ----
// Used by generateCodeChallengeSync() so PKCE stays on the
// synchronous click-handler chain for iOS WKWebView compat.

function sha256Sync(message: Uint8Array): Uint8Array {
  // SHA-256 round constants (first 32 bits of fractional parts of cube roots of the first 64 primes)
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
    0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  // Initial hash values (first 32 bits of fractional parts of square roots of primes 2..19)
  let H0 = 0x6a09e667, H1 = 0xbb67ae85, H2 = 0x3c6ef372, H3 = 0xa54ff53a,
      H4 = 0x510e527f, H5 = 0x9b05688c, H6 = 0x1f83d9ab, H7 = 0x5be0cd19;

  // Pre-processing: padding
  const msgLen = message.length;
  const msgBitLen = msgLen * 8;
  // Pad: append 1 bit (0x80), then 0-63 zero bytes so (len + 1 + zeros + 8) % 64 == 0
  const zeros = (64 - (msgLen + 1 + 8) % 64) % 64;
  const totalLen = msgLen + 1 + zeros + 8;
  const padded = new Uint8Array(totalLen);
  padded.set(message);
  padded[msgLen] = 0x80;
  // Append 64-bit big-endian message length.
  // IMPORTANT: JavaScript >>> only uses the low 5 bits of the shift amount,
  // so shifts >= 32 wrap (24 >>> 32 === 24). We write each 32-bit half
  // separately to stay within the 0-31 shift range.
  // High 32 bits are always 0 for messages < ~500 MB.
  // Low 32 bits in big-endian:
  const lo = msgBitLen >>> 0;
  padded[totalLen - 4] = (lo >>> 24) & 0xff;
  padded[totalLen - 3] = (lo >>> 16) & 0xff;
  padded[totalLen - 2] = (lo >>> 8) & 0xff;
  padded[totalLen - 1] = lo & 0xff;
  // High 32 bits are already 0 from Uint8Array initialization.

  // Process each 512-bit (64-byte) block
  for (let offset = 0; offset < totalLen; offset += 64) {
    // Message schedule
    const W = new Uint32Array(64);
    for (let t = 0; t < 16; t++) {
      const i = offset + t * 4;
      W[t] = (padded[i] << 24) | (padded[i + 1] << 16) |
             (padded[i + 2] << 8) | padded[i + 3];
    }
    for (let t = 16; t < 64; t++) {
      const s0 = (rotr32(W[t - 15], 7) ^ rotr32(W[t - 15], 18) ^ (W[t - 15] >>> 3));
      const s1 = (rotr32(W[t - 2], 17) ^ rotr32(W[t - 2], 19) ^ (W[t - 2] >>> 10));
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
    }

    let a = H0, b = H1, c = H2, d = H3, e = H4, f = H5, g = H6, h = H7;

    for (let t = 0; t < 64; t++) {
      const S1 = (rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25));
      const ch = ((e & f) ^ (~e & g));
      const temp1 = (h + S1 + ch + K[t] + W[t]) | 0;
      const S0 = (rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22));
      const maj = ((a & b) ^ (a & c) ^ (b & c));
      const temp2 = (S0 + maj) | 0;

      h = g; g = f; f = e; e = (d + temp1) | 0;
      d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }

    H0 = (H0 + a) | 0; H1 = (H1 + b) | 0; H2 = (H2 + c) | 0; H3 = (H3 + d) | 0;
    H4 = (H4 + e) | 0; H5 = (H5 + f) | 0; H6 = (H6 + g) | 0; H7 = (H7 + h) | 0;
  }

  const result = new Uint8Array(32);
  const words = [H0, H1, H2, H3, H4, H5, H6, H7];
  for (let i = 0; i < 8; i++) {
    result[i * 4]     = (words[i] >>> 24) & 0xff;
    result[i * 4 + 1] = (words[i] >>> 16) & 0xff;
    result[i * 4 + 2] = (words[i] >>> 8) & 0xff;
    result[i * 4 + 3] = words[i] & 0xff;
  }
  return result;
}

/** 32-bit right rotate */
function rotr32(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}
