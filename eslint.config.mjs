import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Node CommonJS scripts (Playwright end-to-end checks) run outside the app bundle.
    files: ["scripts/**/*.cjs"],
    languageOptions: { sourceType: "commonjs" },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "public/**", "backend/**", "node_modules/**"]),
]);

export default eslintConfig;
