const vm = require("node:vm");

const JS_LANGUAGES = new Set(["javascript", "js", "jsx", "mjs", "cjs", "typescript", "ts", "tsx"]);
const PY_LANGUAGES = new Set(["python", "py"]);

function normalizeLanguage(value, filePath = "") {
  const input = String(value || "").toLowerCase();
  const extension = String(filePath).split(".").pop().toLowerCase();
  const key = input && input !== "text" ? input : extension;
  if (["js", "jsx", "mjs", "cjs", "javascript"].includes(key)) return "javascript";
  if (["ts", "tsx", "typescript"].includes(key)) return "typescript";
  if (["py", "python"].includes(key)) return "python";
  if (key === "json") return "json";
  if (["css"].includes(key)) return "css";
  if (["html", "htm"].includes(key)) return "html";
  if (["md", "markdown"].includes(key)) return "markdown";
  if (["yaml", "yml"].includes(key)) return "yaml";
  if (["sql"].includes(key)) return "sql";
  return key || "text";
}

const SECRET_PATTERN = /(api[_-]?key|secret|passw(?:or)?d|token|private[_-]?key)\s*[:=]\s*["'`][^"'`\s]{8,}["'`]/i;

// Each rule: languages (null = all), line matcher, optional line-level fix.
const RULES = [
  {
    id: "SEC-EVAL", category: "security", severity: "high", languages: ["javascript", "typescript"],
    test: (line) => /(^|[^.\w])eval\s*\(|new\s+Function\s*\(/.test(line),
    message: "Dynamic code evaluation (eval / new Function).",
    explanation: "Evaluating strings as code lets any attacker-controlled input run with the application's privileges.",
    suggestion: "Replace with a lookup table, JSON.parse for data, or an explicit parser."
  },
  {
    id: "SEC-INNERHTML", category: "security", severity: "high", languages: ["javascript", "typescript"],
    test: (line) => /\.(innerHTML|outerHTML)\s*=[^=]|document\.write\s*\(|dangerouslySetInnerHTML/.test(line),
    message: "Unescaped HTML injection sink.",
    explanation: "Assigning untrusted strings to HTML sinks creates cross-site scripting (XSS).",
    suggestion: "Use textContent or build nodes with createElement; sanitise with an allowlist if HTML is required."
  },
  {
    id: "SEC-SECRET", category: "security", severity: "critical", languages: null,
    test: (line) => SECRET_PATTERN.test(line) || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line),
    message: "Possible hard-coded secret.",
    explanation: "Secrets committed to source are exposed to everyone with repository or artifact access and are hard to rotate.",
    suggestion: "Load the value from an environment variable or secret manager and rotate the exposed credential."
  },
  {
    id: "SEC-SQL-CONCAT", category: "security", severity: "high", languages: null,
    test: (line) => /\b(select|insert|update|delete)\b[^;\n]*(["'`]\s*\+|\$\{|%s|\.format\()/i.test(line) && /\b(from|into|set|where)\b/i.test(line),
    message: "SQL built from string concatenation or interpolation.",
    explanation: "Concatenated SQL is vulnerable to injection.",
    suggestion: "Use parameterised queries / prepared statements."
  },
  {
    id: "SEC-SHELL", category: "security", severity: "high", languages: ["javascript", "typescript", "python"],
    test: (line) => /\b(child_process|exec|execSync)\s*\(\s*[`"'].*(\$\{|\+)/.test(line) || /shell\s*=\s*True|os\.system\s*\(/.test(line),
    message: "Shell command built from dynamic input.",
    explanation: "Command strings that include variables allow command injection.",
    suggestion: "Use execFile/spawn (or subprocess.run with a list) with fixed arguments and no shell."
  },
  {
    id: "SEC-TLS", category: "security", severity: "high", languages: null,
    test: (line) => /rejectUnauthorized\s*:\s*false|verify\s*=\s*False|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0/.test(line),
    message: "TLS certificate verification disabled.",
    explanation: "Disabling certificate checks allows man-in-the-middle attacks.",
    suggestion: "Remove the override and trust the proper CA instead."
  },
  {
    id: "SEC-WEAK-HASH", category: "security", severity: "medium", languages: null,
    test: (line) => /createHash\(\s*["'](md5|sha1)["']\s*\)|hashlib\.(md5|sha1)\s*\(/i.test(line),
    message: "Weak hash algorithm (MD5/SHA-1).",
    explanation: "MD5 and SHA-1 are collision-prone and unsuitable for security purposes; passwords need a slow KDF.",
    suggestion: "Use SHA-256 or stronger, and scrypt/argon2/bcrypt for passwords."
  },
  {
    id: "SEC-UNSAFE-DESERIALIZE", category: "security", severity: "high", languages: ["python"],
    test: (line) => /pickle\.loads?\s*\(|yaml\.load\s*\((?![^)]*Loader\s*=\s*yaml\.SafeLoader)(?![^)]*Safe)/.test(line) || /\b(eval|exec)\s*\(/.test(line),
    message: "Unsafe deserialisation or dynamic execution.",
    explanation: "pickle, yaml.load, eval, and exec can execute attacker-supplied code.",
    suggestion: "Use json.loads or yaml.safe_load; avoid eval/exec."
  },
  {
    id: "SEC-RANDOM", category: "security", severity: "low", languages: ["javascript", "typescript"],
    test: (line) => /Math\.random\(\)/.test(line) && /token|secret|password|session|nonce|key/i.test(line),
    message: "Math.random used for a security-sensitive value.",
    explanation: "Math.random is predictable and must not generate tokens or identifiers that gate access.",
    suggestion: "Use crypto.randomBytes / crypto.randomUUID."
  },
  {
    id: "REF-VAR", category: "refactor", severity: "low", languages: ["javascript", "typescript"],
    test: (line) => /^\s*var\s+[A-Za-z_$]/.test(line),
    message: "`var` declaration.",
    explanation: "var is function-scoped and hoisted, which causes subtle scoping bugs.",
    justification: "let has block scope; for declarations that are never reassigned, const is better still. This automatic fix uses `let`, which is safe unless the code relies on hoisting or redeclaration.",
    suggestion: "Use const (or let when reassigned).",
    fix: (line) => line.replace(/^(\s*)var\s+/, "$1let ")
  },
  {
    id: "REF-LOOSE-EQ", category: "refactor", severity: "low", languages: ["javascript", "typescript"],
    test: (line) => /[^=!<>]==[^=]|!=[^=]/.test(stripStrings(line)) && !/[=!]=\s*null\b/.test(line) && !/^\s*(\/\/|\*)/.test(line),
    message: "Loose equality (== / !=).",
    explanation: "Loose equality applies type coercion (e.g. 0 == '' is true).",
    justification: "Strict equality compares type and value, removing coercion surprises. Comparisons with null are left alone because `== null` intentionally matches undefined too.",
    suggestion: "Use === and !==.",
    fix: (line) => line.replace(/([^=!<>])==([^=])/g, "$1===$2").replace(/!=([^=])/g, "!==$1")
  },
  {
    id: "REF-EMPTY-CATCH", category: "refactor", severity: "medium", languages: ["javascript", "typescript"],
    test: (line) => /catch\s*(\([^)]*\))?\s*\{\s*\}/.test(line),
    message: "Empty catch block swallows errors.",
    explanation: "Silently ignoring failures hides bugs and security-relevant events.",
    suggestion: "Handle, log, or rethrow the error; add a comment when ignoring is intentional."
  },
  {
    id: "REF-BARE-EXCEPT", category: "refactor", severity: "medium", languages: ["python"],
    test: (line) => /^\s*except\s*:/.test(line),
    message: "Bare `except:` also catches KeyboardInterrupt and SystemExit.",
    explanation: "A bare except hides unrelated failures and makes the program hard to interrupt.",
    justification: "`except Exception:` keeps the handler but lets system-exiting exceptions propagate.",
    suggestion: "Catch specific exceptions.",
    fix: (line) => line.replace(/except\s*:/, "except Exception:")
  },
  {
    id: "REF-NONE-EQ", category: "refactor", severity: "low", languages: ["python"],
    test: (line) => /[=!]=\s*None\b/.test(line),
    message: "Comparison to None with == / !=.",
    explanation: "None is a singleton; PEP 8 recommends identity checks.",
    justification: "`is None` cannot be fooled by objects that override __eq__.",
    suggestion: "Use `is None` / `is not None`.",
    fix: (line) => line.replace(/!=\s*None\b/g, "is not None").replace(/==\s*None\b/g, "is None")
  },
  {
    id: "REF-MUTABLE-DEFAULT", category: "refactor", severity: "medium", languages: ["python"],
    test: (line) => /def\s+\w+\s*\([^)]*=\s*(\[\]|\{\}|set\(\))/.test(line),
    message: "Mutable default argument.",
    explanation: "Default values are evaluated once, so the same list/dict is shared across calls.",
    suggestion: "Default to None and create the container inside the function."
  },
  {
    id: "STYLE-CONSOLE", category: "style", severity: "info", languages: ["javascript", "typescript"],
    test: (line) => /^\s*console\.log\(/.test(line),
    message: "Debug console.log statement.",
    explanation: "Stray logging can leak data and clutters production output.",
    suggestion: "Remove it or use a structured logger."
  },
  {
    id: "STYLE-PRINT", category: "style", severity: "info", languages: ["python"],
    test: (line) => /^\s*print\(/.test(line) && /debug|here|\bxxx\b/i.test(line),
    message: "Debug print statement.",
    explanation: "Debug output should use the logging module.",
    suggestion: "Use logging.debug."
  },
  {
    id: "STYLE-TODO", category: "style", severity: "info", languages: null,
    test: (line) => /\b(TODO|FIXME|HACK)\b/.test(line),
    message: "Unresolved TODO/FIXME marker.",
    explanation: "Open markers indicate unfinished work.",
    suggestion: "Resolve it or track it in an issue."
  },
  {
    id: "STYLE-TRAILING-WS", category: "style", severity: "info", languages: null,
    test: (line) => /[ \t]+$/.test(line),
    message: "Trailing whitespace.",
    explanation: "Trailing whitespace creates noisy diffs.",
    justification: "Removing trailing whitespace never changes program behaviour (outside multi-line string literals).",
    suggestion: "Trim it.",
    fix: (line) => line.replace(/[ \t]+$/, "")
  },
  {
    id: "STYLE-LONG-LINE", category: "style", severity: "info", languages: null,
    test: (line) => line.length > 160,
    message: "Line longer than 160 characters.",
    explanation: "Very long lines are hard to review.",
    suggestion: "Break the line."
  }
];

function stripStrings(line) {
  return line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
}

function analyze(source, { language, path = "" } = {}) {
  const lang = normalizeLanguage(language, path);
  const family = lang === "typescript" ? "typescript" : lang;
  const findings = [];
  const lines = String(source).split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.languages && !rule.languages.includes(family)) continue;
      if (rule.test(line)) {
        findings.push({
          ruleId: rule.id,
          category: rule.category,
          severity: rule.severity,
          line: index + 1,
          message: rule.message,
          explanation: rule.explanation,
          justification: rule.justification || null,
          suggestion: rule.suggestion,
          fixable: typeof rule.fix === "function",
          snippet: line.trim().slice(0, 160)
        });
      }
    }
  });
  return findings;
}

function applyFixes(source, { language, path = "", ruleIds = null } = {}) {
  const lang = normalizeLanguage(language, path);
  const lines = String(source).split("\n");
  const applied = [];
  const allowed = ruleIds ? new Set(ruleIds) : null;
  const rules = RULES.filter((rule) => rule.fix && (!rule.languages || rule.languages.includes(lang))
    && (!allowed || allowed.has(rule.id)));
  for (let index = 0; index < lines.length; index += 1) {
    for (const rule of rules) {
      const original = lines[index];
      const carriage = original.endsWith("\r") ? "\r" : "";
      const body = carriage ? original.slice(0, -1) : original;
      if (!rule.test(body)) continue;
      const next = rule.fix(body);
      if (next !== body) {
        lines[index] = next + carriage;
        applied.push({
          ruleId: rule.id,
          line: index + 1,
          before: body.trim().slice(0, 160),
          after: next.trim().slice(0, 160),
          justification: rule.justification || rule.explanation
        });
      }
    }
  }
  return { code: lines.join("\n"), applied };
}

function summarize(findings) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return {
    counts,
    total: findings.length,
    fixable: findings.filter((finding) => finding.fixable).length,
    security: findings.filter((finding) => finding.category === "security").length
  };
}

function syntaxDiagnostics(source, language) {
  const diagnostics = [];
  const code = String(source);
  const push = (line, message, severity = "error", column = 1) => diagnostics.push({ line, column, severity, message, source: "syntax" });

  if (language === "json") {
    try {
      JSON.parse(code);
    } catch (error) {
      const position = /position (\d+)/.exec(error.message);
      const line = position ? code.slice(0, Number(position[1])).split("\n").length : 1;
      push(line, error.message);
    }
  } else if (language === "javascript" || language === "typescript") {
    let plain = code;
    if (language === "typescript") {
      try {
        plain = require("node:module").stripTypeScriptTypes(code, { mode: "strip" });
      } catch (error) {
        push(1, String(error.message).split("\n")[0]);
        return diagnostics;
      }
    }
    const isModule = /^\s*(import|export)\s/m.test(plain);
    const probe = isModule
      ? plain.replace(/^\s*import\s[^;]*;?\s*$/gm, "").replace(/^(\s*)export\s+default\s+/gm, "$1").replace(/^(\s*)export\s+/gm, "$1")
      : plain;
    try {
      new vm.Script(probe, { filename: "snippet.js" });
    } catch (error) {
      const match = /snippet\.js:(\d+)/.exec(error.stack || "");
      push(match ? Number(match[1]) : 1, `${error.name}: ${error.message}`);
    }
  } else if (language === "python") {
    const pairs = { ")": "(", "]": "[", "}": "{" };
    const stack = [];
    const lines = code.split("\n");
    let inTriple = null;
    lines.forEach((raw, index) => {
      const lineNo = index + 1;
      const tripleCount = (raw.match(/"""|'''/g) || []).length;
      if (inTriple === null && tripleCount % 2 === 1) inTriple = lineNo;
      else if (inTriple !== null && tripleCount % 2 === 1) inTriple = null;
      if (inTriple !== null) return;
      const text = raw.replace(/#.*$/, "").replace(/(["'])(?:\\.|(?!\1).)*\1/g, '""');
      for (const char of text) {
        if ("([{".includes(char)) stack.push({ char, lineNo });
        if (")]}".includes(char)) {
          if (!stack.length || stack.pop().char !== pairs[char]) push(lineNo, `Unmatched '${char}'.`);
        }
      }
      if (/^\s*(def|class|if|elif|else|for|while|try|except|finally|with)\b/.test(text) && !stack.length
        && !/:\s*(#.*)?$/.test(raw) && !/:\s*\S/.test(text) && text.trim() && !/\\\s*$/.test(text)) {
        push(lineNo, "Expected ':' at the end of this statement.");
      }
      if (/^\t+ +|^ +\t/.test(raw)) push(lineNo, "Mixed tabs and spaces in indentation.");
    });
    for (const open of stack) push(open.lineNo, `'${open.char}' was never closed.`);
    if (inTriple !== null) push(inTriple, "Unterminated triple-quoted string.");
  }
  return diagnostics;
}

function lint(source, { language, path = "" } = {}) {
  const lang = normalizeLanguage(language, path);
  const diagnostics = syntaxDiagnostics(source, lang);
  for (const finding of analyze(source, { language: lang })) {
    if (finding.category === "style" && finding.ruleId === "STYLE-TODO") continue;
    diagnostics.push({
      line: finding.line,
      column: 1,
      severity: finding.severity === "critical" || finding.severity === "high" ? "error"
        : finding.severity === "info" ? "info" : "warning",
      message: finding.message,
      ruleId: finding.ruleId,
      source: finding.category,
      fixable: finding.fixable
    });
  }
  diagnostics.sort((a, b) => a.line - b.line);
  return { language: lang, diagnostics: diagnostics.slice(0, 500) };
}

function format(source, { language, path = "" } = {}) {
  const lang = normalizeLanguage(language, path);
  let code = String(source).replace(/\r\n/g, "\n");
  if (lang === "json") {
    try {
      return { language: lang, code: `${JSON.stringify(JSON.parse(code), null, 2)}\n`, changed: true };
    } catch (error) {
      const failure = new Error(`Cannot format invalid JSON: ${error.message}`);
      failure.status = 422;
      throw failure;
    }
  }
  const unit = lang === "python" ? 4 : 2;
  const tabs = (line) => line.replace(/^(\t+)/, (match) => " ".repeat(match.length * unit));
  let lines = code.split("\n").map((line) => tabs(line).replace(/[ \t]+$/, ""));
  if (JS_LANGUAGES.has(lang) || lang === "css") {
    // Re-indent by brace depth only when no multi-line literals could be corrupted.
    if (!/\/\*/.test(code) && (lang === "css" || !code.includes("`"))) {
      let depth = 0;
      lines = lines.map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return "";
        const text = stripStrings(trimmed).replace(/\/\/.*$/, "");
        const leadingClose = /^[}\])]/.test(text) ? 1 : 0;
        const indent = Math.max(0, depth - leadingClose);
        const opens = (text.match(/[{[(]/g) || []).length;
        const closes = (text.match(/[}\])]/g) || []).length;
        depth = Math.max(0, depth + opens - closes);
        return " ".repeat(indent * unit) + trimmed;
      });
    }
  }
  code = lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n*$/, "\n");
  return { language: lang, code, changed: code !== String(source) };
}

module.exports = { RULES, analyze, applyFixes, format, lint, normalizeLanguage, summarize };
