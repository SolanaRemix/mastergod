const path = require("node:path");
const { validateArtifactPath } = require("./artifacts");

function isLocalReference(reference) {
  return typeof reference === "string"
    && reference.length <= 180
    && !reference.startsWith("/")
    && !reference.startsWith("#")
    && !reference.includes("\\")
    && !/^[a-z][a-z0-9+.-]*:/i.test(reference)
    && !reference.split(/[?#]/, 1)[0].split("/").includes("..");
}

async function inlineProjectAssets(entryPath, html, readArtifact) {
  entryPath = validateArtifactPath(entryPath);
  if (!entryPath.toLowerCase().endsWith(".html")) throw new Error("Preview entry must be an HTML file.");
  const directory = path.posix.dirname(entryPath);
  const references = [];
  const patterns = [
    { type: "style", expression: /<link\b([^>]*?)\bhref=(["'])([^"']+)\2([^>]*)>/gi },
    { type: "script", expression: /<script\b([^>]*?)\bsrc=(["'])([^"']+)\2([^>]*)>\s*<\/script\s*>/gi }
  ];
  for (const { type, expression } of patterns) {
    const matches = [...html.matchAll(expression)];
    for (const match of matches) {
      if (type === "style" && !/\brel\s*=\s*(["'])stylesheet\1/i.test(`${match[1]} ${match[4]}`)) continue;
      const reference = match[3];
      if (!isLocalReference(reference)) continue;
      const cleanReference = reference.split(/[?#]/, 1)[0];
      let artifactPath;
      try {
        artifactPath = validateArtifactPath(path.posix.join(directory, cleanReference));
      } catch {
        continue;
      }
      const artifact = await readArtifact(artifactPath);
      if (!artifact || Buffer.byteLength(artifact.contents, "utf8") > 256 * 1024) continue;
      const closingTagPattern = type === "style" ? /<\/style/gi : /<\/script/gi;
      const contents = artifact.contents.replace(closingTagPattern, (closingTag) => closingTag.replace("/", "\\/"));
      references.push({ match: match[0], replacement: type === "style"
        ? `<style>${contents}</style>`
        : `<script>${contents}</script>` });
    }
  }
  let output = html;
  for (const reference of references) output = output.replace(reference.match, reference.replacement);
  return {
    html: output,
    loadedArtifacts: references.length
  };
}

module.exports = { inlineProjectAssets, isLocalReference };
