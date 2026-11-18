import { cp } from "node:fs/promises";
import { build } from "esbuild";
await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  outfile: "dist/main.mjs",
});

await build({
  entryPoints: ["native/worker.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "dist/native/worker.mjs",
});
await cp("native/zotero/helpers", "dist/native/helpers", { recursive: true });
await cp("native/zotero/LICENSE", "dist/native/LICENSE");
await cp("native/zotero/NOTICE.md", "dist/native/NOTICE.md");
