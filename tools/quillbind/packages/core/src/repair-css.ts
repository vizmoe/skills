import postcss from "postcss";

/** Repair a full-width declaration terminator only when it makes invalid CSS parseable. */
export function repairableCss(source: string): {
  source: string;
  changed: boolean;
} {
  try {
    postcss.parse(source);
    return { source, changed: false };
  } catch {
    /* inspect lexical separators */
  }
  let quote = "";
  let comment = false;
  let parentheses = 0;
  let output = "";
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (comment) {
      if (char === "*" && source[i + 1] === "/") {
        output += "*/";
        i++;
        comment = false;
      } else output += char;
      continue;
    }
    if (quote) {
      output += char;
      if (char === "\\") output += source[++i] ?? "";
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "/" && source[i + 1] === "*") {
      comment = true;
      output += "/*";
      i++;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    if (char === "(") parentheses++;
    if (char === ")") parentheses--;
    output +=
      char === "；" &&
      parentheses === 0 &&
      /^\s*(?:[\w-]+\s*:|})/.test(source.slice(i + 1))
        ? ";"
        : char;
  }
  if (output !== source) {
    try {
      postcss.parse(output);
      return { source: output, changed: true };
    } catch {
      /* other syntax needs review */
    }
  }
  return { source, changed: false };
}
