/** Navigational links are preserved as data and are never fetched by validation. */
export function externalHyperlink(href: string): boolean {
  // eslint-disable-next-line no-control-regex -- Controls and whitespace invalidate external link targets.
  if (/[\u0000-\u0020\u007f\\]/.test(href)) return false;
  if (!/^(?:https?:\/\/|mailto:|tel:)/i.test(href)) return false;
  try {
    const target = new URL(href);
    return ["http:", "https:"].includes(target.protocol)
      ? Boolean(target.hostname)
      : Boolean(target.pathname);
  } catch {
    return false;
  }
}
