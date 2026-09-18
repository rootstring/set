const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const LENGTH = 10;

export function createId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(LENGTH));
  let id = "";
  for (const byte of bytes) id += ALPHABET[byte & 31];
  return id;
}

/** Deterministic, so two devices repairing the same file write the same bytes. */
export async function deriveId(seed: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed));
  const bytes = new Uint8Array(digest).subarray(0, LENGTH);
  let id = "";
  for (const byte of bytes) id += ALPHABET[byte & 31];
  return id;
}
