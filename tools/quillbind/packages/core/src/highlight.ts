import {
  codeToTokens,
  type BundledLanguage,
  type SpecialLanguage,
} from "shiki";
import { fail } from "./errors.js";
import { escapeXml as e, xml } from "./xml.js";

function tokenClass(fontStyle: number | undefined): string {
  if (fontStyle === 1) return "token-comment";
  if (fontStyle === 2) return "token-emphasis";
  return "token";
}

/** Shiki's shorthand already shares its highlighter, themes and grammars. */
export async function highlightCode(text: string, language: string) {
  let tokens;
  try {
    tokens = await codeToTokens(text, {
      lang: language as BundledLanguage | SpecialLanguage,
      theme: "github-light",
    });
  } catch {
    fail("CODE_LANGUAGE", `Unsupported syntax language: ${language}`);
  }
  const content = tokens.tokens
    .map((line) =>
      line
        .map(
          (t) =>
            `<span class="${tokenClass(t.fontStyle)}">${e(t.content)}</span>`,
        )
        .join(""),
    )
    .join("\n");
  const source = xml(`<code>${content}</code>`).documentElement?.textContent;
  if (source !== text)
    fail("CODE_INTEGRITY", "Syntax highlighting changed source text");
  return content;
}
