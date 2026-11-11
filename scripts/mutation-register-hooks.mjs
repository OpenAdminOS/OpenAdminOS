// Applies one mutation register entry to its source file as Node loads it.
// scripts/mutation-register.mjs passes this file to `node --import` ahead of
// tsx, so tsx asks these hooks for the raw TypeScript and compiles the
// mutated text. The file on disk is only read, never written, so a crashed,
// timed out or interrupted run cannot leave the tree changed.
//
// The mark file tells "the tests caught the mutation" apart from "the tests
// never loaded the file": it is written only when the rewrite happened.

import { writeFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";

import { mutate, REGISTER, REPO_ROOT } from "./mutation-register.mjs";

if (isMainThread) register(import.meta.url);

const entry = REGISTER.find((candidate) => candidate.id === process.env.MUTATION_REGISTER_ENTRY);
const mark = process.env.MUTATION_REGISTER_MARK;
if (!entry || !mark) {
  throw new Error(
    `mutation-register-hooks: no register entry named ${JSON.stringify(process.env.MUTATION_REGISTER_ENTRY)}, or no mark path. Run it through scripts/mutation-register.mjs.`,
  );
}
const target = join(REPO_ROOT, entry.path);

// Workspace packages resolve to their built dist. When the target is a
// package's TypeScript source, its bare name is pointed at that source so
// the mutation reaches the tests that import the package by name.
const packageSource = /^packages\/([^/]+)\/src\//.exec(entry.path);
const redirect = packageSource
  ? { specifier: `@openadminos/${packageSource[1]}`, url: pathToFileURL(join(REPO_ROOT, "packages", packageSource[1], "src", "index.ts")).href }
  : undefined;

export async function resolve(specifier, context, nextResolve) {
  if (redirect && specifier === redirect.specifier) return { url: redirect.url, shortCircuit: true };
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!url.startsWith("file:") || fileURLToPath(url.split("?")[0]) !== target || loaded.source == null) return loaded;
  const source = mutate(Buffer.from(loaded.source).toString("utf8"), entry);
  writeFileSync(mark, entry.id);
  return { ...loaded, source };
}
