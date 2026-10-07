import path from "node:path";
import { fail } from "./errors.js";

export function safeName(name: string) {
  if (
    !name ||
    name !== name.normalize("NFC") ||
    name.includes("\\") ||
    name.startsWith("/") ||
    /^[a-z]:/i.test(name) ||
    // eslint-disable-next-line no-control-regex -- ZIP member names cannot contain controls.
    /[\u0000-\u001f\u007f]/.test(name) ||
    name.split("/").some((p) => p === ".." || p === "." || !p)
  )
    fail("UNSAFE_PATH", `Unsafe path: ${JSON.stringify(name)}`);
  return name;
}
export function localTarget(from: string, href: string) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//"))
    fail("REMOTE_RESOURCE", `Unexpected resource URI: ${href}`);
  const [raw, fragment] = href.split("#");
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    fail("INVALID_URI", href);
  }
  if (
    decoded.includes("\\") ||
    decoded.startsWith("/") ||
    decoded.includes("?")
  )
    fail("UNSAFE_PATH", href);
  const target = raw
    ? path.posix.normalize(path.posix.join(path.posix.dirname(from), decoded))
    : from;
  safeName(target);
  return {
    path: target,
    fragment: fragment ? decodeURIComponent(fragment) : undefined,
  };
}
