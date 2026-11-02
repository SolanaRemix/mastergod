const assert = require("node:assert/strict");
const { test } = require("node:test");
const { render } = require("../public/markdown-renderer.js");

test("Markdown renderer handles structured document blocks", () => {
  const html = render(`# Project\n\n> Read **this** first.\n\n1. First\n2. Second\n   - Nested\n\n- [x] Done\n- [ ] Next\n\n| Name | Status |\n| :--- | ---: |\n| App | Ready |\n\n\`\`\`js\nconst answer = 42;\n\`\`\``);
  assert.match(html, /<h1>Project<\/h1>/);
  assert.match(html, /<blockquote><p>Read <strong>this<\/strong> first\.<\/p><\/blockquote>/);
  assert.match(html, /<ol><li>First<\/li><li>Second<ul><li>Nested<\/li><\/ul><\/li><\/ol>/);
  assert.match(html, /type="checkbox" disabled checked/);
  assert.match(html, /<th style="text-align:left">Name<\/th>/);
  assert.match(html, /<td style="text-align:right">Ready<\/td>/);
  assert.match(html, /class="language-js"/);
  assert.match(html, /<code class="language-js">const answer = 42;<\/code>/);
});

test("Markdown renderer escapes raw HTML and rejects executable URLs", () => {
  const html = render('<script>alert("bad")</script>\n\n[x](javascript:alert(1))\n\n![pixel](data:image/svg+xml,<svg>)');
  assert.match(html, /&lt;script&gt;alert\(&quot;bad&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/i);
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.doesNotMatch(html, /src="data:/i);
});

test("Markdown links and images constrain protocols and protect external links", () => {
  const html = render('[Docs](https://example.test/guide "Guide") ![Preview](https://example.test/image.png)');
  assert.match(html, /href="https:\/\/example\.test\/guide" title="Guide" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /src="https:\/\/example\.test\/image\.png" alt="Preview".*referrerpolicy="no-referrer"/);
});
