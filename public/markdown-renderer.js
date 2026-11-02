"use strict";

(function exposeMarkdownRenderer(root, factory) {
  const renderer = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = renderer;
  if (root) root.GodsMarkdown = renderer;
})(typeof window === "undefined" ? globalThis : window, function createMarkdownRenderer() {
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;"
    })[character]);
  }

  function safeUrl(value, image = false) {
    const url = String(value).trim();
    if (!url || /[\u0000-\u0020\\]/.test(url)) return null;
    if (image) {
      if (!/^https:\/\//i.test(url)) return null;
      try {
        return new URL(url).protocol === "https:" ? url : null;
      } catch {
        return null;
      }
    }
    if (/^(?:\/(?!\/)|\.{1,2}\/)/.test(url)) return url;
    try {
      const parsed = new URL(url);
      return ["https:", "http:", "mailto:"].includes(parsed.protocol) ? url : null;
    } catch {
      return null;
    }
  }

  function renderInline(source) {
    const tokens = [];
    const hold = (html) => {
      const token = `GODSMDTOKEN${tokens.length}END`;
      tokens.push(html);
      return token;
    };
    let text = String(source)
      .replace(/`([^`\n]+)`/g, (_match, code) => hold(`<code>${escapeHtml(code)}</code>`))
      .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_match, alt, rawUrl, title) => {
        const url = safeUrl(rawUrl, true);
        if (!url) return escapeHtml(alt);
        const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
        return hold(`<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}"${titleAttribute} loading="lazy" referrerpolicy="no-referrer">`);
      })
      .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_match, label, rawUrl, title) => {
        const url = safeUrl(rawUrl);
        if (!url) return escapeHtml(label);
        const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
        const external = /^https?:\/\//i.test(url);
        const target = external ? ' target="_blank" rel="noopener noreferrer"' : "";
        return hold(`<a href="${escapeHtml(url)}"${titleAttribute}${target}>${escapeHtml(label)}</a>`);
      });

    text = escapeHtml(text)
      .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_match, a, b) => `<strong>${a || b}</strong>`)
      .replace(/~~(.+?)~~/g, "<del>$1</del>")
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
      .replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1<em>$2</em>")
      .replace(/GODSMDTOKEN(\d+)END/g, (_match, index) => tokens[Number(index)] || "");
    return text;
  }

  function isListMarker(line) {
    return line.match(/^(\s*)([-+*]|\d+[.)])\s+(.*)$/);
  }

  function isTableDivider(line) {
    const cells = line.trim().replace(/^\||\|$/g, "").split("|");
    return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
  }

  function startsBlock(lines, index) {
    const line = lines[index] || "";
    return /^\s{0,3}(?:#{1,6}\s|`{3,}|~{3,}|>|(?:[-*_]\s*){3,}$)/.test(line)
      || Boolean(isListMarker(line))
      || (index + 1 < lines.length && isTableDivider(lines[index + 1]));
  }

  function renderList(lines, start) {
    const first = isListMarker(lines[start]);
    const indent = first[1].length;
    const ordered = /^\d/.test(first[2]);
    const tag = ordered ? "ol" : "ul";
    const items = [];
    let index = start;

    while (index < lines.length) {
      const marker = isListMarker(lines[index]);
      if (!marker || marker[1].length !== indent || /^\d/.test(marker[2]) !== ordered) break;
      let itemText = marker[3];
      let task = null;
      const taskMatch = itemText.match(/^\[([ xX])\]\s+(.*)$/);
      if (taskMatch) {
        task = taskMatch[1].toLowerCase() === "x";
        itemText = taskMatch[2];
      }
      index += 1;
      const continuation = [];
      while (index < lines.length) {
        if (!lines[index].trim()) {
          const next = index + 1 < lines.length ? lines[index + 1] : "";
          const nextMarker = isListMarker(next);
          if (nextMarker && nextMarker[1].length <= indent) break;
          if (!next.trim()) break;
          continuation.push("");
          index += 1;
          continue;
        }
        const nextMarker = isListMarker(lines[index]);
        const leadingSpaces = (lines[index].match(/^\s*/) || [""])[0].length;
        if (nextMarker && leadingSpaces <= indent) break;
        if (leadingSpaces <= indent) break;
        continuation.push(lines[index].slice(Math.min(leadingSpaces, indent + 2)));
        index += 1;
      }
      const checkbox = task === null
        ? ""
        : `<input type="checkbox" disabled${task ? " checked" : ""} aria-label="Task ${task ? "completed" : "incomplete"}"> `;
      const nested = continuation.length ? renderBlocks(continuation).join("") : "";
      items.push(`<li>${checkbox}${renderInline(itemText)}${nested}</li>`);
      while (index < lines.length && !lines[index].trim()) {
        const nextMarker = index + 1 < lines.length ? isListMarker(lines[index + 1]) : null;
        if (!nextMarker || nextMarker[1].length !== indent || /^\d/.test(nextMarker[2]) !== ordered) break;
        index += 1;
      }
    }
    return { html: `<${tag}>${items.join("")}</${tag}>`, next: index };
  }

  function renderTable(lines, start) {
    const header = lines[start].trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
    const divider = lines[start + 1].trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
    const alignments = divider.map((cell) => cell.startsWith(":")
      ? cell.endsWith(":") ? "center" : "left"
      : cell.endsWith(":") ? "right" : "");
    const cell = (value, tag, index) => {
      const align = alignments[index];
      return `<${tag}${align ? ` style="text-align:${align}"` : ""}>${renderInline(value.trim())}</${tag}>`;
    };
    let index = start + 2;
    const rows = [];
    while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
      const values = lines[index].trim().replace(/^\||\|$/g, "").split("|");
      rows.push(`<tr>${header.map((_value, column) => cell(values[column] || "", "td", column)).join("")}</tr>`);
      index += 1;
    }
    return {
      html: `<div class="markdown-table-wrap"><table><thead><tr>${header.map((value, column) => cell(value, "th", column)).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`,
      next: index
    };
  }

  function renderBlocks(input) {
    const lines = String(input).replace(/\r\n?/g, "\n").split("\n");
    const output = [];
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) {
        index += 1;
        continue;
      }

      const fence = line.match(/^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)?.*$/);
      if (fence) {
        const language = (fence[2] || "").match(/^[a-z0-9_+#.-]{1,32}$/i)?.[0] || "";
        const closingFence = new RegExp("^\\s{0,3}" + fence[1][0] + "{" + fence[1].length + ",}\\s*$");
        const content = [];
        index += 1;
        while (index < lines.length && !closingFence.test(lines[index])) {
          content.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) index += 1;
        const label = language ? `<span class="markdown-code-language">${escapeHtml(language)}</span>` : "";
        output.push(`<div class="markdown-code-block">${label}<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ""}>${escapeHtml(content.join("\n"))}</code></pre></div>`);
        continue;
      }

      const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        const level = heading[1].length;
        output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
        index += 1;
        continue;
      }
      if (/^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)) {
        output.push("<hr>");
        index += 1;
        continue;
      }
      if (/^\s{0,3}>/.test(line)) {
        const quote = [];
        while (index < lines.length && /^\s{0,3}>/.test(lines[index])) {
          quote.push(lines[index].replace(/^\s{0,3}>\s?/, ""));
          index += 1;
        }
        output.push(`<blockquote>${renderBlocks(quote).join("")}</blockquote>`);
        continue;
      }
      if (index + 1 < lines.length && line.includes("|") && isTableDivider(lines[index + 1])) {
        const table = renderTable(lines, index);
        output.push(table.html);
        index = table.next;
        continue;
      }
      if (isListMarker(line)) {
        const list = renderList(lines, index);
        output.push(list.html);
        index = list.next;
        continue;
      }

      const paragraph = [line.trim()];
      index += 1;
      while (index < lines.length && lines[index].trim() && !startsBlock(lines, index)) {
        paragraph.push(lines[index].trim());
        index += 1;
      }
      output.push(`<p>${paragraph.map(renderInline).join("<br>")}</p>`);
    }
    return output;
  }

  return Object.freeze({
    render(markdown) {
      return renderBlocks(markdown).join("");
    }
  });
});
