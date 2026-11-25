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
 *
 * The hot loop is unrolled eight bytes at a time. Eight input bytes advance
 * the 11-bit write cursor by exactly 88 bits, and 88 is a multiple of 8, so
 * every group starts at bit offset 0 and lands on the same eight
 * (byteOffset, bitOffset) pairs — the per-byte shift/mask arithmetic and the
 * `% output.length` in the carry write drop out of the loop. The tail keeps the
 * straightforward per-byte form. Output is byte-for-byte identical; that is
 * guarded by `tests/crypto.test.ts`, which compares this against a reference
 * implementation around every block boundary. Measured 2.4× on a 4.7 MiB file
 * inside the Obsidian host (69 → 168 MiB/s), which matters because QuickXor is
 * the single largest cost of a cold first scan on mobile.
 */
export function quickXorHashBase64(content: ArrayBuffer): string {
  const input = new Uint8Array(content);
  const output = new Uint8Array(20);
  const bitWidth = output.length * 8;
  const wrap = (offset: number): number =>
    offset >= output.length ? offset - output.length : offset;
  const length = input.length;
  let shift = 0;
  let index = 0;

  for (; index + 8 <= length; index += 8) {
    const byte0 = input[index];
    const byte1 = input[index + 1];
    const byte2 = input[index + 2];
    const byte3 = input[index + 3];
    const byte4 = input[index + 4];
    const byte5 = input[index + 5];
    const byte6 = input[index + 6];
    const byte7 = input[index + 7];
    const cursor = shift >> 3;
    // Bit offsets at this group's eight positions are 0, 3, 6, 1, 4, 7, 2, 5
    // and the byte cursor advances by 0, 1, 2, 4, 5, 6, 8, 9.
    output[cursor] ^= byte0;
    output[wrap(cursor + 1)] ^= (byte1 << 3) & 0xff;
    output[wrap(cursor + 2)] ^= byte1 >> 5;
    output[wrap(cursor + 2)] ^= (byte2 << 6) & 0xff;
    output[wrap(cursor + 3)] ^= byte2 >> 2;
    output[wrap(cursor + 4)] ^= (byte3 << 1) & 0xff;
    output[wrap(cursor + 5)] ^= byte3 >> 7;
    output[wrap(cursor + 5)] ^= (byte4 << 4) & 0xff;
    output[wrap(cursor + 6)] ^= byte4 >> 4;
    output[wrap(cursor + 6)] ^= (byte5 << 7) & 0xff;
    output[wrap(cursor + 7)] ^= byte5 >> 1;
    output[wrap(cursor + 8)] ^= (byte6 << 2) & 0xff;
    output[wrap(cursor + 9)] ^= byte6 >> 6;
    output[wrap(cursor + 9)] ^= (byte7 << 5) & 0xff;
    output[wrap(cursor + 10)] ^= byte7 >> 3;
    shift += 88;
    if (shift >= bitWidth) shift -= bitWidth;
  }

  for (; index < length; index += 1) {
    const byte = input[index];
    const byteOffset = shift >> 3;
    const bitOffset = shift & 7;
    output[byteOffset] ^= (byte << bitOffset) & 0xff;
    if (bitOffset !== 0) {
      output[wrap(byteOffset + 1)] ^= byte >> (8 - bitOffset);
    }
    shift += 11;
    if (shift >= bitWidth) shift -= bitWidth;
  }

  const byteLength = BigInt(input.byteLength);
  for (let offset = 0; offset < 8; offset += 1) {
    output[12 + offset] ^= Number((byteLength >> BigInt(offset * 8)) & 0xffn);
  }

  let binary = "";
  for (const byte of output) binary += String.fromCharCode(byte);
  return btoa(binary);
}
