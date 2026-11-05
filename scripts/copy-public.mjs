// Copies the static frontend (src/public) into dist/public after `tsc`,
// because the TypeScript compiler only emits .ts output. Runs cross-platform.
import { mkdir, copyFile, readdir } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src", "public");
const destDir = join(root, "dist", "public");

await mkdir(destDir, { recursive: true });
for (const entry of await readdir(srcDir)) {
  await copyFile(join(srcDir, entry), join(destDir, entry));
}
console.log("copied src/public -> dist/public");
