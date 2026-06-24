import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

/**
 * Open Design — ESLint Configuration
 *
 * Includes custom rules for Windows path safety:
 *  - no-path-concat: disallows string concatenation for path building
 *  - no-raw-path-join: requires path.join results to be normalized via PathUtils
 *
 * Also integrates unicorn/prefer-node-protocol for Node.js consistency.
 */

/** @type {import("eslint").Linter.FlatConfig[]} */
export default [
  // Base configs
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Global file ignores
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/out/**",
      "**/.next/**",
      "**/coverage/**",
      "**/*.min.js",
    ],
  },

  // Shared settings for all TypeScript/JavaScript source
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mjs", "**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.browser,
        ...globals.es2024,
      },
    },
    rules: {
      // ============================================================
      // Custom Rules: Windows Path Safety
      // ============================================================

      /**
       * no-path-concat
       *
       * Disallows string concatenation when building file paths.
       * Paths should always be constructed via path.join() or
       * PathUtils.normalize(), never via string manipulation.
       *
       * BAD:  const file = baseDir + "/" + fileName;
       * BAD:  const file = `${baseDir}\\${fileName}`;
       * GOOD: const file = path.join(baseDir, fileName);
       * GOOD: const file = PathUtils.normalize(path.join(baseDir, fileName));
       */
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "BinaryExpression[operator='+']:has([type='Literal'][value=/[\\\\\\/]/])",
          message:
            "[no-path-concat] Do not concatenate path segments with string operators. " +
            "Use path.join() and wrap with PathUtils.normalize() instead.",
        },
        {
          selector:
            "TemplateLiteral:has(TemplateElement[value.raw=/[\\\\\\/]/]) > ExpressionStatement",
          message:
            "[no-path-concat] Template literals containing path separators may " +
            "indicate unsafe path construction. Use path.join() + PathUtils.normalize() instead.",
        },
      ],

      /**
       * no-raw-path-join
       *
       * Discourages bare path.join()/path.resolve() without normalization.
       * This is a warning-level rule since not all path operations need
       * normalization (but most on Windows benefit from it).
       */
      "no-restricted-properties": [
        "warn",
        {
          object: "path",
          property: "join",
          message:
            "[no-raw-path-join] Consider wrapping path.join() results with " +
            "PathUtils.normalize() for cross-platform path consistency.",
        },
        {
          object: "path",
          property: "resolve",
          message:
            "[no-raw-path-join] Consider wrapping path.resolve() results with " +
            "PathUtils.normalize() for cross-platform path consistency.",
        },
      ],

      // ============================================================
      // General Code Quality
      // ============================================================
      "no-console": ["warn", { allow: ["warn", "error", "info"] }],
      "no-debugger": "error",
      "no-unused-vars": "off", // handled by TypeScript
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports" },
      ],

      // Prefer node: protocol for built-in modules
      "unicorn/prefer-node-protocol": "error",
    },
  },

  // Test files: relaxed rules
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/__tests__/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
    },
  },

  // Script files: relaxed rules
  {
    files: ["scripts/**/*.ts", "scripts/**/*.js"],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
];
