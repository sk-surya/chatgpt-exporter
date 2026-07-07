#!/usr/bin/env node
// Build the bookmarklet: minify src/export-chatgpt.js, URL-encode, prefix javascript:.
// Usage: node scripts/make-bookmarklet.mjs [--no-minify]
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { minify } from "terser";

const src = readFileSync("src/export-chatgpt.js", "utf8");

let code = src;
if (!process.argv.includes("--no-minify")) {
  const result = await minify(src, { compress: true, mangle: true });
  code = result.code;
}

const bookmarklet = "javascript:" + encodeURIComponent(code);

// sanity check: must decode back to the encoded code
if (decodeURIComponent(bookmarklet.slice("javascript:".length)) !== code) {
  console.error("Round-trip check failed");
  process.exit(1);
}

mkdirSync("dist", { recursive: true });
writeFileSync("dist/bookmarklet.txt", bookmarklet);
console.log(`dist/bookmarklet.txt: ${bookmarklet.length} chars (source: ${src.length})`);
console.log("Paste its content into a bookmark's URL field, then click it on chatgpt.com.");
