import { mathjax } from "@mathjax/src/js/mathjax.js";
import { HandlerType } from "@mathjax/src/js/input/tex/HandlerTypes.js";
import { NewcommandConfig } from "@mathjax/src/js/input/tex/newcommand/NewcommandConfiguration.js";
import { TeX } from "@mathjax/src/js/input/tex.js";
import { liteAdaptor } from "@mathjax/src/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "@mathjax/src/js/handlers/html.js";
import { SerializedMmlVisitor } from "@mathjax/src/js/core/MmlTree/SerializedMmlVisitor.js";
import { STATE } from "@mathjax/src/js/core/MathItem.js";
import "@mathjax/src/js/input/tex/base/BaseConfiguration.js";
import "@mathjax/src/js/input/tex/ams/AmsConfiguration.js";
import { fail } from "./errors.js";
import { escapeXml as e } from "./xml.js";
import { xml } from "./xml.js";
import type { MathExpression } from "./model.js";

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
/** Reset the base/AMS dynamic command tables as well as equation tags.
 * TeX.reset() alone leaves DeclareMathOperator definitions in later expressions.
 */
class ExpressionTeX extends TeX<unknown, unknown, unknown> {
  resetExpression() {
    this.reset();
    for (const [handler, tables] of [
      [HandlerType.DELIMITER, ["new-Delimiter"]],
      [HandlerType.MACRO, ["new-Delimiter", "new-Command"]],
      [HandlerType.ENVIRONMENT, ["new-Environment"]],
    ] as const)
      this.parseOptions.handlers.get(handler).remove([...tables]);
    this.parseOptions.packageData.delete("newcommand");
    NewcommandConfig(this.configuration, this);
  }
}

function createConverter() {
  const input = new ExpressionTeX({
    packages: ["base", "ams"],
    maxBuffer: Infinity,
    formatError: (_jax: unknown, error: Error) => {
      throw error;
    },
  });
  const document = mathjax.document("", { InputJax: input });
  const visitor = new SerializedMmlVisitor();
  return (tex: string, display: boolean): string => {
    if (/\\(?:require|href|url|html|includegraphics|class|style)\b/.test(tex))
      fail("MATH_UNSAFE", "Math expression requests unsafe extensions");
    try {
      input.resetExpression();
      const node = document.convert(tex, { display, end: STATE.COMPILED });
      let value = visitor.visitTree(node as never);
      if (value.includes("<merror"))
        fail("MATH_CONVERSION", "MathJax produced an error");
      value = value.replace("<math ", '<math alttext="' + e(tex) + '" ');
      xml(value, "MathML");
      return value;
    } catch (error) {
      fail("MATH_CONVERSION", `MathML conversion failed: ${String(error)}`);
    }
  };
}

export function mathml(tex: string, display: boolean): string {
  return createConverter()(tex, display);
}

/** Engine and cache belong to one import; repeated builds convert from source again. */
export function createMathCompiler() {
  const expressions = new Map<string, MathExpression>();
  let convert: ReturnType<typeof createConverter> | undefined;
  return (tex: string, display: boolean): MathExpression => {
    const key = JSON.stringify([tex, display]);
    let expression = expressions.get(key);
    if (!expression) {
      convert ??= createConverter();
      expression = { tex, mathml: convert(tex, display), display };
      expressions.set(key, expression);
    }
    return { ...expression };
  };
}
