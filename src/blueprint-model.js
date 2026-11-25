// Minimal YAML subset (maps, sequences, scalars, flow lists) used by the visual Blueprint Editor.
const RESERVED = /^(true|false|null|yes|no|on|off|~)$/i;

function yamlError(message, line) {
  const error = new Error(line ? `YAML line ${line}: ${message}` : `YAML: ${message}`);
  error.status = 422;
  return error;
}

function stripComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === "\\" && quote === '"') i += 1;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "#" && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i).trimEnd();
  }
  return text.trimEnd();
}

function splitFlow(text) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      current += char;
      if (char === "\\" && quote === '"') current += text[++i] ?? "";
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === "[" || char === "{") {
      depth += 1;
      current += char;
    } else if (char === "]" || char === "}") {
      depth -= 1;
      current += char;
    } else if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function parseScalar(raw, lineNo) {
  const text = raw.trim();
  if (text === "" || text === "~" || /^null$/i.test(text)) return null;
  if (text.startsWith('"')) {
    try {
      return JSON.parse(text);
    } catch {
      throw yamlError("Invalid double-quoted string.", lineNo);
    }
  }
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) throw yamlError("Unterminated single-quoted string.", lineNo);
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text.startsWith("[")) {
    if (!text.endsWith("]")) throw yamlError("Unterminated flow list.", lineNo);
    return splitFlow(text.slice(1, -1)).map((part) => parseScalar(part, lineNo));
  }
  if (text.startsWith("{")) {
    if (text !== "{}") throw yamlError("Flow maps other than {} are not supported.", lineNo);
    return {};
  }
  if (/^(true)$/i.test(text)) return true;
  if (/^(false)$/i.test(text)) return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (/^[|>]/.test(text)) throw yamlError("Block scalars are not supported.", lineNo);
  return text;
}

function parseYaml(source) {
  const text = String(source);
  if (text.length > 512 * 1024) throw yamlError("Document is too large.");
  const lines = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    if (/\t/.test(raw.match(/^\s*/)[0])) throw yamlError("Tabs are not allowed for indentation.", index + 1);
    if (/^---\s*$/.test(raw) || /^\.\.\.\s*$/.test(raw)) return;
    const stripped = stripComment(raw);
    if (!stripped.trim()) return;
    lines.push({ indent: stripped.match(/^ */)[0].length, text: stripped.trim(), no: index + 1 });
  });
  if (!lines.length) return {};
  let position = 0;

  function keyValue(entry) {
    const match = /^("(?:\\.|[^"\\])*"|'(?:[^']|'')*'|[^\s"'[{#][^:]*?):(?:\s+(.*))?$/.exec(entry.text);
    if (!match) return null;
    const key = match[1].startsWith('"') ? JSON.parse(match[1]) : match[1].startsWith("'") ? match[1].slice(1, -1) : match[1].trim();
    return { key, rest: match[2] ?? "" };
  }

  function parseBlock(indent, depth) {
    if (depth > 24) throw yamlError("Document is nested too deeply.");
    const first = lines[position];
    if (first.text === "-" || first.text.startsWith("- ")) return parseSequence(indent, depth);
    return parseMap(indent, depth);
  }

  function parseSequence(indent, depth) {
    const result = [];
    while (position < lines.length && lines[position].indent === indent
      && (lines[position].text === "-" || lines[position].text.startsWith("- "))) {
      const entry = lines[position];
      const rest = entry.text === "-" ? "" : entry.text.slice(2).trim();
      if (!rest) {
        position += 1;
        if (position < lines.length && lines[position].indent > indent) result.push(parseBlock(lines[position].indent, depth + 1));
        else result.push(null);
      } else if (keyValue({ text: rest }) && !/^["'[{]/.test(rest)) {
        const offset = entry.text.indexOf(rest);
        lines[position] = { indent: indent + offset, text: rest, no: entry.no };
        result.push(parseMap(indent + offset, depth + 1));
      } else {
        position += 1;
        result.push(parseScalar(rest, entry.no));
      }
    }
    return result;
  }

  function parseMap(indent, depth) {
    const result = {};
    while (position < lines.length && lines[position].indent === indent) {
      const entry = lines[position];
      if (entry.text === "-" || entry.text.startsWith("- ")) break;
      const pair = keyValue(entry);
      if (!pair) throw yamlError("Expected 'key: value'.", entry.no);
      if (Object.prototype.hasOwnProperty.call(result, pair.key) || pair.key === "__proto__") {
        throw yamlError(`Duplicate or unsafe key '${pair.key}'.`, entry.no);
      }
      position += 1;
      if (pair.rest !== "") result[pair.key] = parseScalar(pair.rest, entry.no);
      else if (position < lines.length && lines[position].indent > indent) result[pair.key] = parseBlock(lines[position].indent, depth + 1);
      else if (position < lines.length && lines[position].indent === indent
        && (lines[position].text === "-" || lines[position].text.startsWith("- "))) result[pair.key] = parseSequence(indent, depth + 1);
      else result[pair.key] = null;
    }
    return result;
  }

  const value = parseBlock(lines[0].indent, 0);
  if (position < lines.length) throw yamlError("Unexpected indentation.", lines[position].no);
  return value;
}

function scalarToYaml(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  const text = String(value);
  if (text && /^[A-Za-z_/][\w ./@:-]*$/.test(text) && !RESERVED.test(text) && !/: |\s$|\s#/.test(text) && !text.endsWith(":")
    && !/^-?\d/.test(text)) return text;
  return JSON.stringify(text);
}

function toYaml(value, indent = 0) {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return `${pad}[]\n`;
    return value.map((item) => {
      if (item && typeof item === "object" && !Array.isArray(item) && Object.keys(item).length) {
        const body = toYaml(item, indent + 2);
        return `${pad}- ${body.slice(indent + 2)}`;
      }
      if (Array.isArray(item)) return `${pad}- ${item.length ? `[${item.map(scalarToYaml).join(", ")}]` : "[]"}\n`;
      return `${pad}- ${item && typeof item === "object" ? "{}" : scalarToYaml(item)}\n`;
    }).join("");
  }
  const keys = Object.keys(value);
  if (!keys.length) return `${pad}{}\n`;
  return keys.map((key) => {
    const item = value[key];
    const label = /^[A-Za-z_][\w-]*$/.test(key) ? key : JSON.stringify(key);
    if (Array.isArray(item)) {
      if (!item.length) return `${pad}${label}: []\n`;
      if (item.every((entry) => entry === null || typeof entry !== "object")) {
        return `${pad}${label}: [${item.map(scalarToYaml).join(", ")}]\n`;
      }
      return `${pad}${label}:\n${toYaml(item, indent + 2)}`;
    }
    if (item && typeof item === "object") {
      if (!Object.keys(item).length) return `${pad}${label}: {}\n`;
      return `${pad}${label}:\n${toYaml(item, indent + 2)}`;
    }
    return `${pad}${label}: ${scalarToYaml(item)}\n`;
  }).join("");
}

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const FIELD_TYPES = ["string", "text", "integer", "number", "boolean", "date", "datetime", "json", "reference"];
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9 _.-]{0,63}$/;

function defaultBlueprint(title = "My App") {
  return {
    app: { name: title, version: "0.1.0", description: "", author: "" },
    modules: [],
    pages: [{ name: "Home", path: "/", components: [] }],
    components: [],
    routes: [],
    dataModels: []
  };
}

function text(value, max = 500) {
  return typeof value === "string" ? value.slice(0, max) : value === null || value === undefined ? "" : String(value).slice(0, max);
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function validateBlueprint(input) {
  const errors = [];
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const app = source.app && typeof source.app === "object" ? source.app : {};
  const model = {
    app: {
      name: text(app.name, 100).trim(),
      version: text(app.version, 32).trim() || "0.1.0",
      description: text(app.description, 1000),
      author: text(app.author, 100)
    },
    modules: list(source.modules).slice(0, 100).map((item) => ({
      name: text(item?.name, 64).trim(), description: text(item?.description)
    })),
    pages: list(source.pages).slice(0, 200).map((item) => ({
      name: text(item?.name, 64).trim(), path: text(item?.path, 200).trim(),
      components: list(item?.components).slice(0, 100).map((name) => text(name, 64).trim()).filter(Boolean)
    })),
    components: list(source.components).slice(0, 300).map((item) => ({
      name: text(item?.name, 64).trim(), description: text(item?.description)
    })),
    routes: list(source.routes).slice(0, 300).map((item) => ({
      method: text(item?.method, 8).trim().toUpperCase() || "GET", path: text(item?.path, 200).trim(),
      handler: text(item?.handler, 100).trim(), auth: item?.auth === true
    })),
    dataModels: list(source.dataModels).slice(0, 100).map((item) => ({
      name: text(item?.name, 64).trim(),
      fields: list(item?.fields).slice(0, 100).map((field) => ({
        name: text(field?.name, 64).trim(), type: text(field?.type, 32).trim() || "string", required: field?.required === true
      }))
    }))
  };
  if (!model.app.name) errors.push("Application name is required.");
  const unique = (label, items, key = "name") => {
    const seen = new Set();
    items.forEach((item, index) => {
      const value = item[key];
      if (!value) errors.push(`${label} #${index + 1} needs a ${key}.`);
      else if (key === "name" && !NAME_PATTERN.test(value)) errors.push(`${label} '${value}' has an invalid name.`);
      else if (seen.has(value.toLowerCase())) errors.push(`${label} '${value}' is duplicated.`);
      seen.add(String(value).toLowerCase());
    });
  };
  unique("Module", model.modules);
  unique("Page", model.pages);
  unique("Component", model.components);
  unique("Data model", model.dataModels);
  const componentNames = new Set(model.components.map((item) => item.name.toLowerCase()));
  for (const page of model.pages) {
    if (!page.path.startsWith("/") || /\s/.test(page.path)) errors.push(`Page '${page.name}' path must start with '/' and contain no spaces.`);
    for (const name of page.components) {
      if (!componentNames.has(name.toLowerCase())) errors.push(`Page '${page.name}' uses unknown component '${name}'.`);
    }
  }
  for (const route of model.routes) {
    if (!HTTP_METHODS.includes(route.method)) errors.push(`Route ${route.path || "(empty)"} has unsupported method '${route.method}'.`);
    if (!route.path.startsWith("/") || /\s/.test(route.path)) errors.push(`Route path '${route.path}' must start with '/' and contain no spaces.`);
  }
  for (const dataModel of model.dataModels) {
    const seen = new Set();
    for (const field of dataModel.fields) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(field.name)) errors.push(`Data model '${dataModel.name}' has an invalid field name '${field.name}'.`);
      else if (seen.has(field.name.toLowerCase())) errors.push(`Data model '${dataModel.name}' repeats field '${field.name}'.`);
      seen.add(field.name.toLowerCase());
      if (!FIELD_TYPES.includes(field.type)) errors.push(`Field '${dataModel.name}.${field.name}' has unsupported type '${field.type}'.`);
    }
  }
  return { model, errors };
}

function blueprintToYaml(model) {
  return `# gods.blueprint.yaml — edited with the Master GODS visual Blueprint Editor\n${toYaml(model)}`;
}

function yamlToBlueprint(source) {
  const parsed = parseYaml(source);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw yamlError("The top level must be a map.");
  return validateBlueprint(parsed);
}

module.exports = {
  FIELD_TYPES, HTTP_METHODS, blueprintToYaml, defaultBlueprint, parseYaml, toYaml, validateBlueprint, yamlToBlueprint
};
