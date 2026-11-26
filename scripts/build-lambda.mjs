import { build } from "esbuild";

await build({
  entryPoints: ["src/lambda.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  outfile: "dist-lambda/handler.mjs",
  format: "esm",
  external: ["@aws-sdk/*", "@napi-rs/keyring"],
  banner: {
    js: 'import { createRequire } from "module"; const require = createRequire(import.meta.url);',
  },
  logLevel: "info",
});
