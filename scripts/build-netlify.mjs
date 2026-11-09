// Netlify build: render the static pages into netlify-dist/.
// Mirrors what server.ts does at request time: substitute {{TARGET_SELECTOR}}.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src", "public");
const outDir = join(root, "netlify-dist");
const selector = (process.env.TARGET_SELECTOR || "#submit-pin").trim();

await mkdir(outDir, { recursive: true });
for (const file of ["index.html", "fraud-test.html"]) {
  const html = (await readFile(join(srcDir, file), "utf8")).replace("{{TARGET_SELECTOR}}", selector);
  await writeFile(join(outDir, file), html);
}
console.log(`rendered index.html + fraud-test.html -> netlify-dist (selector ${selector})`);
