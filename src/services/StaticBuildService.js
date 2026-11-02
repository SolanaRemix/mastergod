const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { validateArtifactPath } = require("../artifacts");

const MAX_FILE_BYTES = 256 * 1024;
const MAX_BUILD_BYTES = 4 * 1024 * 1024;

function checkJavaScript(filePath, contents) {
  const moduleSyntax = /\.(?:mjs|mts)$/i.test(filePath) || /^\s*(?:import\s|export\s)/m.test(contents);
  const args = ["--check", "--input-type=" + (moduleSyntax ? "module" : "commonjs")];
  const result = spawnSync(process.execPath, args, {
    input: contents,
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 128 * 1024,
    env: { PATH: process.env.PATH || "" }
  });
  if (result.error) return { status: "FAILED", message: result.error.message };
  return {
    status: result.status === 0 ? "VERIFIED" : "FAILED",
    message: (result.stderr || result.stdout || "").trim().slice(0, 4000)
  };
}

function checkCss(contents) {
  const normalized = contents
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
  let depth = 0;
  for (const character of normalized) {
    if (character === "{") depth += 1;
    if (character === "}") depth -= 1;
    if (depth < 0) return { status: "FAILED", message: "Unexpected closing brace." };
  }
  return depth === 0
    ? { status: "VERIFIED", message: "CSS brace structure is balanced." }
    : { status: "FAILED", message: "CSS has unclosed rule braces." };
}

function resolveReference(entryPath, reference) {
  if (!reference || reference.startsWith("#") || reference.startsWith("data:")) return null;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(reference)) return { external: true };
  const relativePath = reference.split(/[?#]/, 1)[0];
  try {
    return { path: validateArtifactPath(path.posix.join(path.posix.dirname(entryPath), relativePath)) };
  } catch {
    return { invalid: true };
  }
}

function verifyProjectArtifacts(artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    return { status: "FAILED", checks: [], logs: ["The project contains no files."] };
  }
  if (artifacts.length > 500) {
    return { status: "BLOCKED", checks: [], logs: ["Safe static checks are limited to 500 files."] };
  }
  const files = new Map();
  let totalBytes = 0;
  const checks = [];
  const logs = [];
  for (const artifact of artifacts) {
    const artifactPath = validateArtifactPath(artifact.path);
    if (typeof artifact.contents !== "string") {
      checks.push({ path: artifactPath, check: "read-text", status: "BLOCKED", message: "Binary artifacts are not supported." });
      continue;
    }
    const size = Buffer.byteLength(artifact.contents, "utf8");
    totalBytes += size;
    if (size > MAX_FILE_BYTES || totalBytes > MAX_BUILD_BYTES) {
      return { status: "BLOCKED", checks, logs: ["Static analysis size limits were exceeded."] };
    }
    files.set(artifactPath, artifact.contents);
  }

  for (const [filePath, contents] of files) {
    const extension = path.posix.extname(filePath).toLowerCase();
    if ([".js", ".mjs", ".cjs"].includes(extension)) {
      const result = checkJavaScript(filePath, contents);
      checks.push({ path: filePath, check: "javascript-syntax", ...result });
      if (result.message) logs.push(`${filePath}: ${result.message}`);
    } else if (extension === ".json") {
      try {
        JSON.parse(contents);
        checks.push({ path: filePath, check: "json-parse", status: "VERIFIED", message: "JSON parsed successfully." });
      } catch (error) {
        checks.push({ path: filePath, check: "json-parse", status: "FAILED", message: error.message });
      }
    } else if (extension === ".css") {
      const result = checkCss(contents);
      checks.push({ path: filePath, check: "css-structure", ...result });
      if (result.status === "FAILED") logs.push(`${filePath}: ${result.message}`);
    } else if (extension === ".html") {
      const validDocument = /<!doctype\s+html/i.test(contents) && /<html\b/i.test(contents) && /<\/html\s*>/i.test(contents);
      checks.push({
        path: filePath,
        check: "html-document",
        status: validDocument ? "VERIFIED" : "FAILED",
        message: validDocument ? "HTML document markers are present." : "Expected a doctype and matching html document element."
      });
      for (const match of contents.matchAll(/(?:src|href)=(["'])([^"']+)\1/gi)) {
        const reference = resolveReference(filePath, match[2]);
        if (!reference) continue;
        if (reference.external) {
          checks.push({ path: filePath, check: "local-reference", status: "BLOCKED", message: `External resource is not resolved in the isolated preview: ${match[2]}` });
        } else if (reference.invalid || !files.has(reference.path)) {
          checks.push({ path: filePath, check: "local-reference", status: "FAILED", message: `Project-local reference is missing or unsafe: ${match[2]}` });
        } else {
          checks.push({ path: filePath, check: "local-reference", status: "VERIFIED", message: `Resolved ${reference.path}.` });
        }
      }
    } else if ([".md", ".yaml", ".yml", ".txt", ".sql"].includes(extension)) {
      checks.push({ path: filePath, check: "text-file", status: "IMPLEMENTED_UNVERIFIED", message: "Stored text file; no compiler or domain validator is configured." });
    } else {
      checks.push({ path: filePath, check: "toolchain", status: "BLOCKED", message: `No isolated build toolchain is configured for ${extension || "this file type"}.` });
    }
  }
  const statuses = checks.map((check) => check.status);
  const status = statuses.includes("FAILED") ? "FAILED"
    : statuses.includes("BLOCKED") ? "BLOCKED"
      : "IMPLEMENTED_UNVERIFIED";
  logs.unshift(`Checked ${files.size} text artifacts without executing project code or installing dependencies.`);
  return {
    status,
    checks,
    logs,
    execution: "Static syntax/structure analysis only. No dependency installation, compilation, server start, or application runtime was executed."
  };
}

module.exports = { verifyProjectArtifacts };
