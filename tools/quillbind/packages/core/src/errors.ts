import type { Diagnostic } from "./model.js";

export function fail(code: string, message: string, details?: unknown): never {
  throw Object.assign(new Error(message), { code, details });
}
export const diagnostic = (
  code: string,
  message: string,
  source?: string,
  standardUrl?: string,
  severity: Diagnostic["severity"] = "error",
): Diagnostic => ({
  code,
  severity,
  message,
  ...(source ? { source } : {}),
  ...(standardUrl
    ? { standardUrl }
    : { standard: "Quillbind policy", standardUrl: "docs/development.md" }),
});
export const result = (diagnostics: Diagnostic[]) => ({
  status: diagnostics.some((d) => d.severity === "error")
    ? ("fail" as const)
    : ("pass" as const),
  diagnostics,
});
export const checkAbort = (signal?: AbortSignal) => signal?.throwIfAborted();
