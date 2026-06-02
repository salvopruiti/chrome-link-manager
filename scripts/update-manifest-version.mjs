import fs from "node:fs";
import path from "node:path";

const version = process.argv[2];

if (!version) {
  console.error("Missing version argument.");
  process.exit(1);
}

const manifestPath = path.resolve(process.cwd(), "manifest.json");
const manifestRaw = fs.readFileSync(manifestPath, "utf8");
const manifest = JSON.parse(manifestRaw);

manifest.version = version;

fs.writeFileSync(
  manifestPath,
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);
console.log(`manifest.json updated to version ${version}`);
