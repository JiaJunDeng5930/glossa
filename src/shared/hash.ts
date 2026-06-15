// @constraint glossa.cache_identity.text_hash Text digest generation returns the same SHA-256 value in browser and Node runtimes.
export async function hashText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const subtle = globalThis.crypto?.subtle;
  // @constraint glossa.cache_identity.text_hash.webcrypto_required Text hashing requires WebCrypto SHA-256 in the current runtime.
  if (!subtle) {
    throw new Error("WebCrypto SHA-256 is unavailable");
  }
  const digest = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
