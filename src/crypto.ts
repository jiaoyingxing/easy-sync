/** Platform-neutral SHA-256 primitive for exact in-memory bytes. */
export async function sha256Hex(content: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", content);
  const bytes = new Uint8Array(hashBuffer);
  let hex = "";
  for (let index = 0; index < bytes.length; index++) {
    hex += bytes[index].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * OneDrive-compatible QuickXorHash for exact in-memory bytes.
 *
 * This is a fast, non-cryptographic content fingerprint. Callers may use a
 * mismatch to prove bytes differ, but must not treat a match as SHA-256-grade
 * equality without an independently version-bound content anchor.
 */
export function quickXorHashBase64(content: ArrayBuffer): string {
  const input = new Uint8Array(content);
  const output = new Uint8Array(20);
  const bitWidth = output.length * 8;
  let shift = 0;

  for (let index = 0; index < input.length; index++) {
    const byte = input[index];
    const byteOffset = shift >> 3;
    const bitOffset = shift & 7;
    output[byteOffset] ^= (byte << bitOffset) & 0xff;
    if (bitOffset !== 0) {
      output[(byteOffset + 1) % output.length] ^= byte >> (8 - bitOffset);
    }
    shift += 11;
    if (shift >= bitWidth) shift -= bitWidth;
  }

  const length = BigInt(input.byteLength);
  for (let index = 0; index < 8; index++) {
    output[12 + index] ^= Number((length >> BigInt(index * 8)) & 0xffn);
  }

  let binary = "";
  for (const byte of output) binary += String.fromCharCode(byte);
  return btoa(binary);
}
