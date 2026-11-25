"use strict";

// Dependency-free syntax highlighter. Output is always HTML-escaped.
(function exposeHighlighter(root) {
  const KEYWORDS = {
    js: "async await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield true false null undefined interface type enum implements public private protected readonly as",
    python: "and as assert async await break class continue def del elif else except finally for from global if import in is lambda None nonlocal not or pass raise return try while with yield True False self",
    java: "abstract boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public return short static super switch this throw throws try void volatile while true false null var record",
    cpp: "alignas auto bool break case catch char class const constexpr continue default delete do double else enum explicit extern false float for friend goto if inline int long namespace new nullptr operator private protected public return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile while include define std",
    sql: "select from where insert into values update set delete create table alter drop index join left right inner outer on group by order having limit offset and or not null primary key foreign references default unique as distinct union case when then else end",
    bash: "if then else elif fi for while do done case esac function in echo export local return exit cd npm node git sudo",
    css: "",
    json: "true false null",
    html: ""
  };
  const ALIASES = {
    javascript: "js", jsx: "js", mjs: "js", cjs: "js", typescript: "js", ts: "js", tsx: "js",
    py: "python", python3: "python", "c++": "cpp", cc: "cpp", c: "cpp", h: "cpp", hpp: "cpp",
    sh: "bash", shell: "bash", zsh: "bash", yml: "bash", yaml: "bash", htm: "html", xml: "html", svg: "html", scss: "css"
  };

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function normalize(language) {
    const key = String(language || "").toLowerCase().trim();
    const name = ALIASES[key] || key;
    return name in KEYWORDS ? name : "";
  }

  function languageForPath(path) {
    const ext = String(path || "").split(".").pop();
    return normalize(ext);
  }

  function rulesFor(language) {
    const words = KEYWORDS[language].split(" ").filter(Boolean);
    const keyword = words.length ? new RegExp(`^(?:${words.join("|")})\\b`, language === "sql" ? "i" : "") : null;
    const rules = [];
    if (language === "html") {
      rules.push(["comment", /^<!--[\s\S]*?(?:-->|$)/], ["tag", /^<\/?[A-Za-z][\w:-]*/], ["tag", /^\/?>/], ["attr", /^[A-Za-z_:-]+(?==)/], ["string", /^"[^"]*"?|^'[^']*'?/]);
      return rules;
    }
    if (language === "css") {
      rules.push(["comment", /^\/\*[\s\S]*?(?:\*\/|$)/], ["string", /^"(?:\\.|[^"\\\n])*"?|^'(?:\\.|[^'\\\n])*'?/], ["number", /^#[0-9a-fA-F]{3,8}\b|^-?\d*\.?\d+(?:px|em|rem|%|vh|vw|s|ms)?/], ["attr", /^[\w-]+(?=\s*:)/], ["keyword", /^@[\w-]+/]);
      return rules;
    }
    if (language === "python" || language === "bash") rules.push(["comment", /^#.*/]);
    else if (language === "sql") rules.push(["comment", /^--.*/], ["comment", /^\/\*[\s\S]*?(?:\*\/|$)/]);
    else if (language !== "json") rules.push(["comment", /^\/\/.*/], ["comment", /^\/\*[\s\S]*?(?:\*\/|$)/]);
    if (language === "python") rules.push(["string", /^(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$))/]);
    rules.push(["string", /^"(?:\\.|[^"\\\n])*"?|^'(?:\\.|[^'\\\n])*'?/]);
    if (language === "js") rules.push(["string", /^`(?:\\[\s\S]|[^`\\])*`?/]);
    if (language === "python") rules.push(["keyword", /^@\w+/]);
    rules.push(["number", /^0[xX][0-9a-fA-F]+\b|^\d+\.?\d*(?:[eE][+-]?\d+)?\b/]);
    if (keyword) rules.push(["keyword", keyword]);
    rules.push(["function", /^[A-Za-z_$][\w$]*(?=\()/]);
    if (language === "java" || language === "cpp") rules.push(["type", /^[A-Z][\w]*\b/]);
    return rules;
  }

  const cache = new Map();

  function highlight(code, language) {
    const name = normalize(language);
    if (!name) return escapeHtml(code);
    if (!cache.has(name)) cache.set(name, rulesFor(name));
    const rules = cache.get(name);
    const wordStart = /^[A-Za-z_$][\w$]*/;
    let out = "";
    let rest = String(code);
    while (rest.length) {
      let matched = null;
      for (const [cls, pattern] of rules) {
        const m = pattern.exec(rest);
        if (m && m[0].length) { matched = [cls, m[0]]; break; }
      }
      if (matched) {
        out += `<span class="tok-${matched[0]}">${escapeHtml(matched[1])}</span>`;
        rest = rest.slice(matched[1].length);
        continue;
      }
      const word = wordStart.exec(rest);
      const text = word ? word[0] : rest[0];
      out += escapeHtml(text);
      rest = rest.slice(text.length);
    }
    return out;
  }

  function highlightAll(container) {
    container.querySelectorAll("pre code").forEach((node) => {
      if (node.dataset.highlighted) return;
      const match = /language-([\w+#-]+)/.exec(node.className);
      const language = match ? match[1] : "";
      if (normalize(language) && node.textContent.length < 60000) node.innerHTML = highlight(node.textContent, language);
      node.dataset.highlighted = "1";
    });
  }

  root.GodsHighlight = { highlight, highlightAll, normalize, languageForPath, escapeHtml };
  if (typeof module !== "undefined" && module.exports) module.exports = root.GodsHighlight;
})(typeof window === "undefined" ? globalThis : window);
