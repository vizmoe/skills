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

function compactOrderScript(script: string): string {
  return script.replace(/\s+/g, " ").replace(/ ?([!(),;=]) ?/g, "$1");
}

function hasAssignment(prefix: string, name: string): boolean {
  const target = `${name}=`;
  let from = 0;
  while (from <= prefix.length - target.length) {
    const index = prefix.indexOf(target, from);
    if (index === -1) return false;
    if (index === 0 || !/[$\w]/.test(prefix[index - 1])) return true;
    from = index + 1;
  }
  return false;
}

function findSeedMatch(segments: string[]): [string, string] | undefined {
  for (const segment of segments) {
    const decl = /var [$\w]+=/.exec(segment);
    if (!decl) continue;
    const match = /Number\([$\w]+\),([^,)]+)\),([^,)]+)\),/.exec(
      segment.slice(decl.index + decl[0].length),
    );
    if (match) return [match[1], match[2]];
  }
  return undefined;
}

function findLcgMatch(
  segments: string[],
): [string, string, string] | undefined {
  for (const segment of segments) {
    const match = /\(([$\w]+),([^,)]+)\),([^,)]+)\),([^,)]+)\)$/.exec(segment);
    if (match && hasAssignment(segment.slice(0, match.index), match[1]))
      return [match[2], match[3], match[4]];
  }
  return undefined;
}

export function restoreBiliParagraphs(
  $: CheerioAPI,
  body: ReturnType<CheerioAPI>,
  script: string,
  chapterId: number,
) {
  // The observed chapterlog template fixes the first 20 paragraphs and shuffles
  // remaining paragraph slots with an LCG. See docs/novel-sources.md for evidence.
  const compact = compactOrderScript(script);
  const segments = compact.split(";");
  const fixed = /if\(![$\w]+\)return;var [$\w]+=([^;]+);function/.exec(compact);
  const seed = findSeedMatch(segments);
  const lcg = findLcgMatch(segments);
  if (!fixed || !seed || !lcg)
    fail(
      "NOVEL_ORDER",
      "Source paragraph-order script has changed; refusing to publish scrambled text",
    );
  const multiplier = integer(seed[0]),
    offset = integer(seed[1]);
  const a = integer(lcg[0]),
    c = integer(lcg[1]),
    modulus = integer(lcg[2]);
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
