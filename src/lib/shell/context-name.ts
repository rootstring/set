import { sanitizeContextName } from "$lib/storage/paths";

export interface ContextNameVerdict {
  ok: boolean;
  name: string;
  error: string | null;
  note: string | null;
}

export function checkContextName(
  raw: string,
  existing: readonly string[],
  self?: string,
): ContextNameVerdict {
  const typed = raw.trim();
  if (!typed) return { ok: false, name: "", error: null, note: null };

  const name = sanitizeContextName(typed);
  if (!name) {
    return {
      ok: false,
      name: "",
      error: "Use letters or numbers in the name.",
      note: null,
    };
  }

  const lower = name.toLowerCase();
  if (lower !== self?.toLowerCase() && existing.some((n) => n.toLowerCase() === lower)) {
    return { ok: false, name, error: `“${name}” already exists.`, note: null };
  }

  return {
    ok: true,
    name,
    error: null,
    note: name === typed ? null : `Saved as “${name}”.`,
  };
}
