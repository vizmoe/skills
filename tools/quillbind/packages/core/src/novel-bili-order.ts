import type { CheerioAPI } from "cheerio";
import { fail } from "./errors.js";

/** Numeric expressions only. Site JavaScript is data and is never evaluated. */
function integer(source: string): number {
  const tokens = source.match(/0x[\da-f]+|\d+|[()+*-]/gi) ?? [];
  if (tokens.join("") !== source.replace(/\s/g, "") || tokens.length > 100)
    fail("NOVEL_ORDER", "Unrecognized paragraph-order arithmetic");
  let offset = 0;
  const primary = (): number => {
    const token = tokens[offset++];
    if (token === "+") return primary();
    if (token === "-") return -primary();
    if (token === "(") {
      const value = sum();
      if (tokens[offset++] !== ")")
        fail("NOVEL_ORDER", "Unbalanced paragraph-order arithmetic");
      return value;
    }
    if (!token || !/^(?:0x[\da-f]+|\d+)$/i.test(token))
      fail("NOVEL_ORDER", "Invalid paragraph-order number");
    return Number(token);
  };
  const product = (): number => {
    let value = primary();
    while (tokens[offset] === "*") {
      offset++;
      value *= primary();
    }
    return value;
  };
  const sum = (): number => {
    let value = product();
    while (tokens[offset] === "+" || tokens[offset] === "-") {
      const op = tokens[offset++];
      value += (op === "+" ? 1 : -1) * product();
    }
    return value;
  };
  const value = sum();
  if (offset !== tokens.length || !Number.isSafeInteger(value))
    fail("NOVEL_ORDER", "Invalid paragraph-order expression");
  return value;
}

export function restoreBiliParagraphs(
  $: CheerioAPI,
  body: ReturnType<CheerioAPI>,
  script: string,
  chapterId: number,
) {
  // The observed chapterlog template fixes the first 20 paragraphs and shuffles
  // remaining paragraph slots with an LCG. See docs/novel-sources.md for evidence.
  const fixed =
    /if\s*\(\s*![_$\w]+\s*\)\s*return\s*;\s*var\s+[_$\w]+\s*=\s*([^;]+);\s*function/.exec(
      script,
    );
  const seed =
    /var\s+[_$\w]+\s*=\s*[^;]*?Number\s*\(\s*[_$\w]+\s*\)\s*,\s*([^,)]+?)\s*\)\s*,\s*([^,)]+?)\s*\)\s*,/.exec(
      script,
    );
  const lcg =
    /([_$\w]+)\s*=\s*[^;]*?\(\s*\1\s*,\s*([^,)]+?)\s*\)\s*,\s*([^,)]+?)\s*\)\s*,\s*([^;)]+?)\s*\)\s*;/.exec(
      script,
    );
  if (!fixed || !seed || !lcg)
    fail(
      "NOVEL_ORDER",
      "Source paragraph-order script has changed; refusing to publish scrambled text",
    );
  const multiplier = integer(seed[1]),
    offset = integer(seed[2]);
  const a = integer(lcg[2]),
    c = integer(lcg[3]),
    modulus = integer(lcg[4]);
  if (
    integer(fixed[1]) !== 20 ||
    multiplier !== 126 ||
    offset !== 232 ||
    a !== 9302 ||
    c !== 49397 ||
    modulus !== 233280
  )
    fail(
      "NOVEL_ORDER",
      "Source paragraph-order recipe differs from the checked template",
    );
  const nodes = body.contents().toArray();
  const slots = nodes.flatMap((node, index) =>
    node.type === "tag" &&
    node.name === "p" &&
    ($(node).html() ?? "").replace(/\s/g, "")
      ? [index]
      : [],
  );
  const tail = slots.map((_, index) => index).slice(20);
  let state = chapterId * multiplier + offset;
  for (let i = tail.length - 1; i > 0; i--) {
    state = (state * a + c) % modulus;
    const j = Math.floor((state / modulus) * (i + 1));
    [tail[i], tail[j]] = [tail[j], tail[i]];
  }
  const order = [...slots.map((_, index) => index).slice(0, 20), ...tail];
  const restored = [...nodes];
  slots.forEach((slot, index) => {
    restored[slots[order[index]]] = nodes[slot];
  });
  body.empty().append(restored);
}
