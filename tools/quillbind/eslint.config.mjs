import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default [
  {
    ignores: [
      "**/node_modules/**",
      ".cache/**",
      "dist/**",
      "examples/**",
      "test-results/**",
      "playwright-report/**",
      "coverage/**",
    ],
  },
  {
    files: ["**/*.{ts,mjs}"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: js.configs.recommended.rules,
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        onUnsupportedTypeScriptVersion: "error",
      },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "no-undef": "off", // tsc understands types and browser evaluation contexts.
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/only-throw-error": "error",
      "@typescript-eslint/prefer-promise-reject-errors": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  },
  {
    files: ["tests/visual/**/*.ts"],
    // Playwright parses destructured fixture parameters, including empty fixtures.
    rules: {
      "no-empty-pattern": ["error", { allowObjectPatternsAsParameters: true }],
    },
  },
];
