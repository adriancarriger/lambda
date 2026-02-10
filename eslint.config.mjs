import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "ForInStatement",
          message: "Use Object.keys/entries instead.",
        },
        {
          selector: "ForOfStatement",
          message: "Use .map(), .filter(), .reduce(), or .forEach() instead.",
        },
        {
          selector: "VariableDeclaration[kind='let']",
          message:
            "Use const. If mutation is needed, add an eslint-disable comment.",
        },
        {
          selector: "CallExpression[callee.property.name='push']",
          message:
            "Use spread or functional patterns. If imperative is needed, add an eslint-disable comment.",
        },
      ],
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "never" },
      ],
    },
  },
  {
    ignores: ["dist/**", "sample/**", "**/*.cjs"],
  },
);
