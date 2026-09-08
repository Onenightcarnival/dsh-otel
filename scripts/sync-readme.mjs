/**
 * Rewrite every versioned install reference in README.md to one version:
 * the `dsh-otel-<version>.tgz` filename and the `releases/download/v<version>/`
 * URL segment. Defaults to package.json's version; pass an explicit version as
 * the first argument (the release workflow passes the tag). Runs as the
 * `version` npm lifecycle script so `npm version <bump>` keeps the README in
 * step with the bumped package.json.
 */
import { readFile, writeFile } from "node:fs/promises";

const version = process.argv[2] ?? JSON.parse(await readFile("package.json", "utf8")).version;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`sync-readme: "${version}" is not a semver version`);
  process.exit(1);
}

const VERSION_RE = "\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?";
const before = await readFile("README.md", "utf8");
const after = before
  .replace(new RegExp(`dsh-otel-${VERSION_RE}\\.tgz`, "g"), `dsh-otel-${version}.tgz`)
  .replace(new RegExp(`/releases/download/v${VERSION_RE}/`, "g"), `/releases/download/v${version}/`);

if (after === before) {
  console.log(`sync-readme: README.md already references ${version}`);
} else {
  await writeFile("README.md", after);
  console.log(`sync-readme: README.md now references ${version}`);
}
