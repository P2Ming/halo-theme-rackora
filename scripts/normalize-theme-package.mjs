import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import archiver from "archiver";
import YAML from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const theme = YAML.parse(await readFile(path.join(root, "theme.yaml"), "utf8"));
const version = theme?.spec?.version;
const name = theme?.metadata?.name;

if (!name || !version) throw new Error("theme.yaml must define metadata.name and spec.version");

const outputPath = path.join(root, "dist", `${name}-${version}.zip`);
const distRoot = path.dirname(outputPath);
const maxReleaseBytes = 400 * 1024;
const requiredFiles = [
  "theme.yaml",
  "settings.yaml",
  "annotation-setting.yaml",
  "CHANGELOG.md",
  "README.md",
  "README.en.md",
  "LICENSE",
  "docs/plugin-compatibility.md",
];
const thirdPartyPackages = [
  ["IBM Plex Sans", "@fontsource/ibm-plex-sans"],
  ["Source Serif 4", "@fontsource/source-serif-4"],
  ["Highlight.js", "highlight.js"],
  ["Lucide", "lucide"],
];
const textExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".svg",
  ".txt",
  ".yaml",
  ".yml",
]);

async function readReleaseFile(relativePath) {
  const contents = await readFile(path.join(root, relativePath));
  const extension = path.extname(relativePath).toLowerCase();
  const isText = textExtensions.has(extension) || path.basename(relativePath) === "LICENSE";
  return isText
    ? Buffer.from(contents.toString("utf8").replaceAll("\r\n", "\n"), "utf8")
    : contents;
}

// 字体、图标和代码高亮随主题再分发，OFL / BSD / ISC 都要求附带版权声明与许可证原文。
async function readThirdPartyLicenses() {
  const sections = [];
  for (const [label, packageName] of thirdPartyPackages) {
    const packageRoot = path.join(root, "node_modules", packageName);
    const { version, license } = JSON.parse(
      await readFile(path.join(packageRoot, "package.json"), "utf8"),
    );
    const text = (await readFile(path.join(packageRoot, "LICENSE"), "utf8"))
      .replaceAll("\r\n", "\n")
      .trim();
    sections.push(
      `${label} (${packageName}@${version}, ${license})\n${"=".repeat(72)}\n\n${text}\n`,
    );
  }
  return Buffer.from(
    `Rackora bundles the following third-party assets in templates/assets.\nTheir copyright notices and license texts are reproduced below.\n\n${sections.join("\n")}`,
    "utf8",
  );
}

for (const relativePath of requiredFiles) {
  const info = await stat(path.join(root, relativePath));
  if (!info.isFile()) throw new Error(`Required release file is not a file: ${relativePath}`);
}
if (!(await stat(path.join(root, "templates"))).isDirectory()) {
  throw new Error("templates must be built before packaging");
}

await mkdir(distRoot, { recursive: true });
const stalePackages = (await readdir(distRoot, { withFileTypes: true })).filter(
  (entry) =>
    entry.isFile() &&
    entry.name.startsWith(`${name}-`) &&
    entry.name.endsWith(".zip") &&
    entry.name !== path.basename(outputPath),
);
for (const entry of stalePackages) {
  await unlink(path.join(distRoot, entry.name));
}
if (stalePackages.length > 0) {
  console.log(`Removed ${stalePackages.length} stale local release package(s).`);
}

const output = createWriteStream(outputPath);
const releaseTimestamp = new Date("2000-01-01T00:00:00.000Z");
const archive = archiver("zip", { zlib: { level: 9 } });
const completed = new Promise((resolve, reject) => {
  output.on("close", resolve);
  output.on("error", reject);
  archive.on("error", reject);
});

archive.pipe(output);
for (const relativePath of requiredFiles) {
  archive.append(await readReleaseFile(relativePath), {
    date: releaseTimestamp,
    mode: 0o644,
    name: relativePath,
  });
}
archive.append(await readThirdPartyLicenses(), {
  date: releaseTimestamp,
  mode: 0o644,
  name: "THIRD_PARTY_LICENSES.txt",
});
const templateEntries = await readdir(path.join(root, "templates"), {
  recursive: true,
  withFileTypes: true,
});
const templateFiles = templateEntries
  .filter((entry) => entry.isFile())
  .map((entry) =>
    path.relative(root, path.join(entry.parentPath, entry.name)).replaceAll("\\", "/"),
  )
  .sort();
for (const relativePath of templateFiles) {
  archive.append(await readReleaseFile(relativePath), {
    date: releaseTimestamp,
    mode: 0o644,
    name: relativePath,
  });
}
await archive.finalize();
await completed;

const releaseBytes = archive.pointer();
if (releaseBytes > maxReleaseBytes) {
  await unlink(outputPath);
  throw new Error(`Release package budget exceeded: ${releaseBytes} > ${maxReleaseBytes} bytes`);
}
console.log(`Normalized release package: ${outputPath} (${releaseBytes} bytes)`);
