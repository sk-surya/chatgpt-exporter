#!/usr/bin/env node
// Sync src VERSION from package.json. Runs automatically via `npm version patch|minor|major`.
import { readFileSync, writeFileSync } from "fs";

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const path = "src/export-chatgpt.js";
const src = readFileSync(path, "utf8");
const out = src.replace(/const VERSION = "[^"]*"/, `const VERSION = "v${version}"`);
if (out === src && !src.includes(`"v${version}"`)) {
  console.error("VERSION line not found in src");
  process.exit(1);
}
writeFileSync(path, out);
console.log(`src/export-chatgpt.js VERSION -> v${version}`);
