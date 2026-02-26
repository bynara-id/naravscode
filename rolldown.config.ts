import { defineConfig } from "rolldown";

export default defineConfig({
  input: "src/extension.ts",
  external: ["vscode"],
  platform: "node",
  output: {
    clean: true,
    file: "dist/extension.cjs",
    format: "cjs",
    sourcemap: true,
  },
});
