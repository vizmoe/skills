import postcss from "postcss";

function parsesAsCss(source: string): boolean {
  try {
    postcss.parse(source);
    return true;
  } catch {
    return false;
  }
}

interface CssScanState {
  quote: string;
  comment: boolean;
  parentheses: number;
  output: string;
}

function stepCommentOrQuote(
  source: string,
  index: number,
  state: CssScanState,
): number | undefined {
  const char = source[index];
  if (state.comment) {
    if (char === "*" && source[index + 1] === "/") {
      state.output += "*/";
      state.comment = false;
      return index + 1;
    }
    state.output += char;
    return index;
  }
  if (!state.quote) return undefined;
  state.output += char;
  if (char === "\\") {
    state.output += source[index + 1] ?? "";
    return index + 1;
  }
  if (char === state.quote) state.quote = "";
  return index;
}

function stepCssScan(
  source: string,
  index: number,
  state: CssScanState,
): number {
  const handled = stepCommentOrQuote(source, index, state);
  if (handled !== undefined) return handled;
  const char = source[index];
  if (char === "/" && source[index + 1] === "*") {
    state.comment = true;
    state.output += "/*";
    return index + 1;
  }
  if (char === '"' || char === "'") state.quote = char;
  if (char === "(") state.parentheses++;
  if (char === ")") state.parentheses--;
  const isTerminator =
    char === "；" &&
    state.parentheses === 0 &&
    /^\s*(?:[\w-]+\s*:|})/.test(source.slice(index + 1));
  state.output += isTerminator ? ";" : char;
  return index;
}

/** Repair a full-width declaration terminator only when it makes invalid CSS parseable. */
export function repairableCss(source: string): {
  source: string;
  changed: boolean;
} {
  if (parsesAsCss(source)) return { source, changed: false };
  const state: CssScanState = {
    quote: "",
    comment: false,
    parentheses: 0,
    output: "",
  };
  for (let i = 0; i < source.length; i++) i = stepCssScan(source, i, state);
  if (state.output !== source && parsesAsCss(state.output))
    return { source: state.output, changed: true };
  return { source, changed: false };
}
