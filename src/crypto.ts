/** Platform-neutral SHA-256 primitive for exact in-memory bytes. */
export async function sha256Hex(content: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", content);
  const bytes = new Uint8Array(hashBuffer);
  let hex = "";
  for (let index = 0; index < bytes.length; index++) {
    hex += bytes[index]!.toString(16).padStart(2, "0");
  }
  return hex;
}
