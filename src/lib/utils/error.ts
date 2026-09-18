/** The text of whatever was thrown: Tauri commands reject with a bare string, everything else with an `Error`. */
export function message(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}
