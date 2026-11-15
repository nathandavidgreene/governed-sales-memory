#!/usr/bin/env node
/**
 * Generate the API reference pages for the docs site from the JSDoc
 * docstrings in the source.
 *
 * Reads every non-test TypeScript module in `src/` plus the scripts in
 * `scripts/`, and writes one Markdown page per module into the output
 * directory (default `docs/api/`), plus an index page listing every
 * module with the first sentence of its docstring. Nothing is invented:
 * each entry is a docstring as written, under the declaration it sits
 * on. Usage:
 *
 *   node scripts/gen-api-docs.mjs [outputDir]
 *
 * The output directory is generated and gitignored; rerun this script
 * (or `npm run docs:build`) after changing a docstring.
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root, resolved from this script's location. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Longest signature, in lines, copied from a declaration. */
const MAX_SIGNATURE_LINES = 8;

/**
 * Strip the comment markers from one JSDoc block and return its text,
 * keeping line breaks and the indentation inside code samples.
 */
export function cleanComment(block) {
  return block
    .replace(/^\/\*\*/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\* ?/, ""))
    .join("\n")
    .trim();
}

/**
 * Read the declaration that follows a docstring, starting at `lines[start]`,
 * and return its signature: the declaration lines up to the opening
 * brace, semicolon, or comma outside any parentheses, so a multi-line
 * parameter list is kept whole. A variable, or a type alias whose body
 * starts on the next line, is cut at its `=`. Returns
 * `undefined` when no code follows the comment.
 */
export function readSignature(lines, start) {
  let index = start;
  while (index < lines.length && lines[index].trim() === "") {
    index++;
  }
  if (index >= lines.length) {
    return undefined;
  }
  const first = lines[index];
  const indent = first.length - first.trimStart().length;
  if (/^\s*(export\s+)?(const|let|var)\s/.test(first)) {
    const eq = first.indexOf(" =");
    return { text: (eq === -1 ? first : first.slice(0, eq)).trim(), indent };
  }
  if (/^\s*(export\s+)?type\s/.test(first) && first.trimEnd().endsWith("=")) {
    return { text: `${first.trim()} …`, indent };
  }
  const collected = [];
  let parens = 0;
  for (let i = index; i < lines.length && collected.length < MAX_SIGNATURE_LINES; i++) {
    const line = lines[i];
    collected.push(line.slice(Math.min(indent, line.length - line.trimStart().length)));
    parens += (line.match(/\(/g) ?? []).length - (line.match(/\)/g) ?? []).length;
    const trimmed = line.trimEnd();
    if (parens <= 0 && (trimmed.endsWith("{") || trimmed.endsWith(";") || trimmed.endsWith(","))) {
      break;
    }
  }
  const text = collected
    .join("\n")
    .replace(/\s*\{$/, "")
    .replace(/[;,]$/, "")
    .trim();
  return { text, indent };
}

/**
 * Pull the declared name out of a signature: a function, class,
 * interface, type, variable, method, or property name. Falls back to
 * the signature's first word when none of the patterns match.
 */
export function declaredName(signature) {
  const match =
    /(?:function\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z0-9_$]+)/.exec(signature) ??
    /^(?:(?:public|private|protected|readonly|static|async|get|set)\s+)*([A-Za-z0-9_$]+)\s*[?(:<]/.exec(signature);
  return match ? match[1] : signature.split(/\s+/)[0];
}

/**
 * Parse one source file's text into its module docstring and its
 * documented declarations. The module docstring is the first JSDoc
 * block, when it comes before any code and is followed by a blank
 * line; every other block is paired with the declaration directly
 * under it. Indented declarations (class
 * members, interface fields) are marked as members of the top-level
 * declaration before them.
 */
export function parseSource(source) {
  const lines = source.split("\n");
  const entries = [];
  let moduleDoc = "";
  let seenCode = false;
  let parent;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed.startsWith("/**")) {
      if (trimmed !== "" && !trimmed.startsWith("#!") && !trimmed.startsWith("//")) {
        seenCode = true;
      }
      continue;
    }
    let end = i;
    while (end < lines.length && !lines[end].includes("*/")) {
      end++;
    }
    const doc = cleanComment(lines.slice(i, end + 1).map((l) => l.trim()).join("\n"));
    i = end;
    const directlyAfter = lines[end + 1] ?? "";
    if (!seenCode && moduleDoc === "" && directlyAfter.trim() === "") {
      moduleDoc = doc;
      seenCode = true;
      continue;
    }
    const signature = readSignature(lines, end + 1);
    if (signature === undefined) {
      continue;
    }
    seenCode = true;
    const name = declaredName(signature.text);
    const exported = /^export\s/.test(signature.text);
    if (signature.indent === 0) {
      parent = name;
      entries.push({ name, signature: signature.text, doc, exported, parent: undefined });
    } else {
      entries.push({ name, signature: signature.text, doc, exported, parent });
    }
  }
  return { moduleDoc, entries };
}

/** Return the first sentence of a docstring, on one line, for the index table. */
export function firstSentence(doc) {
  const flat = doc.replace(/\s+/g, " ").trim();
  const match = /^(.+?\.)(\s|$)/.exec(flat);
  return (match ? match[1] : flat).replace(/\|/g, "\\|");
}

/**
 * Render one module's parsed docstrings as a Markdown page: the module
 * docstring, then each top-level declaration with its signature and
 * docstring, its members nested under it.
 */
export function renderModule(relPath, parsed) {
  const out = [`# \`${relPath}\``, ""];
  if (parsed.moduleDoc !== "") {
    out.push(parsed.moduleDoc, "");
  }
  const lang = relPath.endsWith(".mjs") ? "js" : "ts";
  for (const entry of parsed.entries) {
    const heading = entry.parent === undefined ? "##" : "###";
    const label = entry.parent === undefined ? entry.name : `${entry.parent}.${entry.name}`;
    const badge = entry.parent === undefined && !entry.exported ? " *(internal)*" : "";
    out.push(`${heading} \`${label}\`${badge}`, "");
    out.push("```" + lang, entry.signature, "```", "");
    out.push(entry.doc, "");
  }
  return out.join("\n");
}

/**
 * List the modules to document: non-test `.ts` files in `src/` and
 * `.mjs` files in `scripts/`, sorted, as paths relative to the root.
 */
async function listModules() {
  const src = (await readdir(path.join(ROOT, "src")))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => `src/${f}`);
  const scripts = (await readdir(path.join(ROOT, "scripts")))
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => `scripts/${f}`);
  return [...src.sort(), ...scripts.sort()];
}

/**
 * Generate every API page and the index into `outDir`, replacing what
 * was there. Fails with a non-zero exit if a module has no docstring,
 * so an undocumented module is caught rather than published blank.
 */
async function main() {
  const outDir = path.resolve(process.argv[2] ?? path.join(ROOT, "docs", "api"));
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const rows = [];
  const undocumented = [];
  for (const rel of await listModules()) {
    const parsed = parseSource(await readFile(path.join(ROOT, rel), "utf8"));
    if (parsed.moduleDoc === "") {
      undocumented.push(rel);
    }
    const page = rel.replace(/[/.]/g, "-").replace(/-(ts|mjs)$/, "") + ".md";
    await writeFile(path.join(outDir, page), renderModule(rel, parsed));
    rows.push(`| [\`${rel}\`](${page}) | ${firstSentence(parsed.moduleDoc)} |`);
  }
  const index = [
    "# API reference",
    "",
    "Generated from the docstrings in the source by `scripts/gen-api-docs.mjs`.",
    "Each page shows a module's docstring, then every documented declaration",
    "with its signature. *(internal)* marks a declaration the module does not export.",
    "",
    "| Module | Summary |",
    "| --- | --- |",
    ...rows,
    "",
  ].join("\n");
  await writeFile(path.join(outDir, "index.md"), index);
  console.log(`Wrote ${rows.length} module pages to ${path.relative(ROOT, outDir) || outDir}.`);
  if (undocumented.length > 0) {
    console.error(`Modules with no docstring: ${undocumented.join(", ")}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
