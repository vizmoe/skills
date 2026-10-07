import { vi } from "vitest";

export const traditionalText = (text: string) =>
  text.replace(
    /[简体书网软录间来这测试]/gu,
    (character) =>
      ({
        简: "簡",
        体: "體",
        书: "書",
        网: "網",
        软: "軟",
        录: "錄",
        间: "間",
        来: "來",
        这: "這",
        测: "測",
        试: "試",
      })[character]!,
  );

export function recordedZhconvert(
  options: {
    limit?: number;
    convert?: (text: string) => string;
    revision?: () => string;
  } = {},
) {
  return vi.fn<typeof fetch>(async (input, init) => {
    if (String(input).endsWith("/service-info"))
      return Response.json({
        code: 0,
        data: {
          converters: Object.fromEntries(
            ["Simplified", "Traditional", "China", "Taiwan", "Hongkong"].map(
              (name) => [name, {}],
            ),
          ),
          maxPostBodyBytes: options.limit ?? 11000000,
          allowEmptyApiKey: true,
        },
      });
    const body = new URLSearchParams(String(init?.body));
    return Response.json({
      code: 0,
      data: {
        converter: body.get("converter"),
        text: (options.convert ?? traditionalText)(body.get("text")!),
      },
      revisions: { build: options.revision?.() ?? "recorded-dictionary-v1" },
    });
  });
}
