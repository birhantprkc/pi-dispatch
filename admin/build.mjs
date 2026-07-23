/**
 * Bundle the operator extension into a single self-contained `dist/index.mjs` for publishing as a pi-package.
 *
 * The admin extension imports ~10 `@pi-dispatch/worker` subpaths (a private workspace); esbuild INLINES those
 * local `.mjs` files so the published package has no `@pi-dispatch/*` dependency. The pi runtime is
 * host-provided (a peerDependency) and `bullmq`/`ioredis` are heavy real deps kept EXTERNAL and declared in
 * package.json; everything else — the admin's own files, the inlined worker internals, and `typebox` — is
 * bundled in. `import.meta.url` is preserved (esm), so the extension's `../skills` resolution still points at
 * the shipped `skills/` dir (dist/ and skills/ sit side by side in the published tarball).
 */
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

await build({
	entryPoints: [join(here, "src/index.ts")],
	outfile: join(here, "dist/index.mjs"),
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node22",
	// Host-provided peer + heavy runtime deps stay external (declared in package.json). typebox is bundled.
	external: ["@earendil-works/pi-coding-agent", "bullmq", "ioredis"],
	banner: { js: "// pi-dispatch operator extension (bundled). Source: https://github.com/edgehero/pi-dispatch" },
	logLevel: "info",
});

console.log("[built admin/dist/index.mjs]");
