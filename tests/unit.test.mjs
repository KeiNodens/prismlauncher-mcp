// Unit tests for the pure helpers, run against the built dist/ output.
//   npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseIni, stringifyIni, iniGet, iniSet } from "../dist/ini.js";
import { resolveLoaderVersion, resolveLwjgl } from "../dist/meta.js";

test("ini round-trip preserves sections and values", () => {
  const src = "[General]\nname=My Instance\niconKey=default\n\n[UI]\ntheme=dark\n";
  const ini = parseIni(src);
  assert.equal(iniGet(ini, "General", "name"), "My Instance");
  iniSet(ini, "General", "name", "Renamed");
  const out = stringifyIni(ini);
  assert.match(out, /name=Renamed/);
  assert.match(out, /\[UI\]\ntheme=dark/);
});

test("ini parser ignores comments and blank lines", () => {
  const ini = parseIni("; comment\n# also a comment\n\n[General]\na=1\n");
  assert.equal(iniGet(ini, "General", "a"), "1");
});

const FORGE_LIKE = [
  { version: "47.4.28", recommended: true, releaseTime: "2026-01-01", requires: [{ uid: "net.minecraft", equals: "1.20.1" }] },
  { version: "47.4.0", recommended: false, releaseTime: "2023-06-01", requires: [{ uid: "net.minecraft", equals: "1.20.1" }] },
  { version: "43.2.14", recommended: true, releaseTime: "2023-01-01", requires: [{ uid: "net.minecraft", equals: "1.19.2" }] },
];

test("resolveLoaderVersion prefers the recommended build for the MC version", () => {
  assert.equal(resolveLoaderVersion(FORGE_LIKE, "1.20.1").version, "47.4.28");
  assert.equal(resolveLoaderVersion(FORGE_LIKE, "1.19.2").version, "43.2.14");
});

test("resolveLoaderVersion honors an explicit version and rejects unknown ones", () => {
  assert.equal(resolveLoaderVersion(FORGE_LIKE, "1.20.1", "47.4.0").version, "47.4.0");
  assert.throws(() => resolveLoaderVersion(FORGE_LIKE, "1.20.1", "99.0.0"));
});

test("resolveLwjgl reads suggests/equals from the minecraft entry", () => {
  assert.equal(resolveLwjgl({ version: "1.20.1", requires: [{ uid: "org.lwjgl3", suggests: "3.3.1" }] }), "3.3.1");
  assert.equal(resolveLwjgl({ version: "1.7.10", requires: [] }), undefined);
});

import { compareLang, placeholdersOf, parseLangProps } from "../dist/lang.js";

test("placeholdersOf extracts printf args, section codes and braces", () => {
  assert.deepEqual(placeholdersOf("Hello %s, you have %2$d \u00a7a{0}"), ["%2$d", "%s", "\u00a7a", "{0}"].sort());
});

test("compareLang reports missing, extra, mismatch and identical", () => {
  const src = { a: "Hi %s", b: "Bye", c: "\u00a7cRed", d: "Same" };
  const tr = { a: "やあ", b: "バイ", c: "\u00a7c赤", d: "Same", e: "extra" };
  const diff = compareLang(src, tr);
  assert.deepEqual(diff.missing, []);
  assert.deepEqual(diff.extra, ["e"]);
  assert.equal(diff.placeholderMismatch.length, 1);
  assert.equal(diff.placeholderMismatch[0].key, "a");
  assert.deepEqual(diff.identicalValues, ["d"]);
});

test("parseLangProps reads legacy .lang files", () => {
  const out = parseLangProps("# comment\nitem.demo.name=Demo\n\nfoo=bar=baz\n");
  assert.equal(out["item.demo.name"], "Demo");
  assert.equal(out["foo"], "bar=baz");
});
