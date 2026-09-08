/**
 * Write one version into package.json and package-lock.json without touching
 * git. The release workflow runs it with the pushed tag's version so the tag,
 * not a hand-edited package.json, decides what gets packed and what the
 * default branch is bumped to afterwards. Refuses to move backwards: a
 * package.json already newer than the tag stays put with a warning.
 */
import { readFile, writeFile } from "node:fs/promises";

const version = process.argv[2];
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
if (version === undefined || !SEMVER.test(version)) {
  console.error(`set-version: "${version}" is not a semver version`);
  process.exit(1);
}

/** Compare two semver strings; a prerelease sorts before its release. */
function compare(a, b) {
  const [, ...pa] = SEMVER.exec(a);
  const [, ...pb] = SEMVER.exec(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return diff;
  }
  if (pa[3] === pb[3]) return 0;
  if (pa[3] === undefined) return 1;
  if (pb[3] === undefined) return -1;
  return pa[3] < pb[3] ? -1 : 1;
}

async function stamp(file, mutate) {
  const text = await readFile(file, "utf8");
  const json = JSON.parse(text);
  const before = json.version;
  if (before === version) {
    console.log(`set-version: ${file} already at ${version}`);
    return;
  }
  if (compare(before, version) > 0) {
    console.log(`::warning::set-version: ${file} is at ${before}, newer than ${version}; left unchanged`);
    return;
  }
  mutate(json);
  const indent = /^(\s+)"/m.exec(text)?.[1] ?? "  ";
  await writeFile(file, `${JSON.stringify(json, null, indent)}\n`);
  console.log(`set-version: ${file} ${before} -> ${version}`);
}

await stamp("package.json", (json) => {
  json.version = version;
});
await stamp("package-lock.json", (json) => {
  json.version = version;
  if (json.packages?.[""] !== undefined) json.packages[""].version = version;
});
