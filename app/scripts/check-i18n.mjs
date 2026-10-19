#!/usr/bin/env node
// Fails (exit 1) when locale files disagree or the UI uses a key that doesn't exist.
//  - zh / en / ja must have exactly the same keys
//  - every {placeholder} (or {n|one|other} plural) in zh must appear in en / ja (and no extra ones)
//  - every t("key") used in src/ must exist; dynamic t(`prefix.${x}`) needs at least one key with that prefix
//  - no hard-coded CJK text left in src/*.ts outside locales/ and comments (language names are allowed)
// Unused keys are reported as warnings only.
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const LANGS = ["zh", "en", "ja"];
const parse = (l) => {
  const m = new Map();
  for (const [, k, v] of readFileSync(join(src, "locales", `${l}.ts`), "utf8").matchAll(/^\s*"((?:[^"\\]|\\.)+)":\s*("(?:[^"\\]|\\.)*"),?\s*$/gm)) {
    if (m.has(k)) err(`${l}: duplicate key ${k}`);
    m.set(k, JSON.parse(v));
  }
  return m;
};
let errors = 0;
const EMPTY_OK = ["rp.unitTimes"];   // English shows "12" under "Drives" with no unit
function err(s) { console.error("✗ " + s); errors++; }
const dicts = Object.fromEntries(LANGS.map(l => [l, parse(l)]));
const zh = dicts.zh;
if (zh.size < 10) err("zh.ts parsed fewer than 10 keys — parser out of date?");
const ph = (s) => [...new Set([...s.matchAll(/\{(\w+)(?:\|[^}]*)?\}/g)].map(m => m[1]))].sort().join(",");
for (const l of ["en", "ja"]) {
  for (const k of zh.keys()) {
    if (!dicts[l].has(k)) err(`${l}: missing key ${k}`);
    else {
      if (ph(zh.get(k)) !== ph(dicts[l].get(k))) err(`${l}: placeholders differ for ${k}: {${ph(zh.get(k))}} vs {${ph(dicts[l].get(k))}}`);
      if (!dicts[l].get(k).trim() && zh.get(k).trim() && !EMPTY_OK.includes(k)) console.warn(`! ${l}: empty translation for ${k}`);
    }
  }
  for (const k of dicts[l].keys()) if (!zh.has(k)) err(`${l}: extra key ${k} (not in zh)`);
}

const files = readdirSync(src).filter(f => f.endsWith(".ts") && f !== "vite-env.d.ts");
const used = new Set(), prefixes = new Set();
const ALLOWED_CJK = ["中文", "日本語", "（往返）"];
for (const f of files) {
  const raw = readFileSync(join(src, f), "utf8");
  // comments stripped (doc examples like t("key") must not count)
  const text = raw.split("\n").map(l => /^\s*(\*|\/\*\*|\/\/)/.test(l) ? "" : l.replace(/\s\/\/ .*$/, "")).join("\n");
  for (const [, k] of text.matchAll(/\bt\(\s*"([\w.]+)"/g)) { used.add(k); if (!zh.has(k)) err(`${f}: unknown key "${k}"`); }
  for (const [, p] of text.matchAll(/\bt\(\s*`([\w.]+)\$\{/g)) { prefixes.add(p); if (![...zh.keys()].some(k => k.startsWith(p))) err(`${f}: no keys for dynamic prefix "${p}"`); }
  text.split("\n").forEach((line, i) => {
    let code = line.replace(/\/\/.*$/, "");
    if (/^\s*(\*|\/\*\*)/.test(code)) return;
    for (const a of ALLOWED_CJK) code = code.split(a).join("");
    if (/[\u3000-\u30ff\u4e00-\u9fff\uff01-\uff5e]/.test(code)) err(`${f}:${i + 1}: hard-coded CJK text: ${line.trim().slice(0, 100)}`);
  });
}
const unused = [...zh.keys()].filter(k => !used.has(k) && ![...prefixes].some(p => k.startsWith(p)));
if (unused.length) console.warn(`! ${unused.length} unused key(s): ${unused.join(", ")}`);
if (errors) { console.error(`\ni18n check failed: ${errors} error(s)`); process.exit(1); }
console.log(`✓ i18n: ${zh.size} keys × ${LANGS.length} languages, ${used.size} used directly`);
