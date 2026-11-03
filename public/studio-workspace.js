"use strict";

// Studio views: blueprint editor, build workspace (editor/explorer/review/preview), git, collaboration, admin.
(function studioWorkspace(root) {
  const S = root.GodsStudio;
  const { h, api, toast, guard } = S;
  const HL = root.GodsHighlight;

  function needProject(el) {
    if (S.projects.length) return true;
    el.append(h("p", { class: "helper-text", text: "You have no projects yet. Create one in the Projects view, or ask a collaborator to share theirs." }));
    return false;
  }
  const pid = () => S.workspaceProject;

  // ---- code editor (textarea + highlighted overlay) --------------------------------
  function createEditor() {
    const gutter = h("div", { class: "editor-gutter", "aria-hidden": "true" });
    const pre = h("pre", { class: "editor-highlight", "aria-hidden": "true" }, h("code"));
    const area = h("textarea", { class: "editor-input", spellcheck: "false", wrap: "off", "aria-label": "Code editor" });
    const wrap = h("div", { class: "editor" }, gutter, h("div", { class: "editor-stack" }, pre, area));
    let language = "";
    let marks = new Map();
    function paint() {
      const code = area.value;
      pre.firstChild.innerHTML = HL.highlight(code + (code.endsWith("\n") ? " " : ""), language);
      const count = code.split("\n").length;
      gutter.replaceChildren(...Array.from({ length: count }, (_, i) => h("div", { class: marks.has(i + 1) ? `ln ln-${marks.get(i + 1).severity}` : "ln", title: marks.get(i + 1)?.message || false, text: String(i + 1) })));
      pre.scrollTop = area.scrollTop; pre.scrollLeft = area.scrollLeft; gutter.scrollTop = area.scrollTop;
    }
    area.addEventListener("scroll", () => { pre.scrollTop = area.scrollTop; pre.scrollLeft = area.scrollLeft; gutter.scrollTop = area.scrollTop; });
    area.addEventListener("input", paint);
    area.addEventListener("keydown", (event) => {
      if (event.key === "Tab" && !event.ctrlKey) {
        event.preventDefault();
        area.setRangeText("  ", area.selectionStart, area.selectionEnd, "end");
        paint();
      }
    });
    return {
      el: wrap, area,
      set(code, lang) { language = lang; area.value = code; marks = new Map(); paint(); },
      mark(diagnostics) { marks = new Map(); for (const d of diagnostics) if (!marks.has(d.line) || d.severity === "error") marks.set(d.line, d); paint(); },
      onInput(fn) { area.addEventListener("input", fn); }
    };
  }

  // ---- build workspace --------------------------------------------------------------
  S.views.workspace = async (el) => {
    await S.refreshProjects();
    if (!needProject(el)) return;
    let current = null; // {path, version, language}
    let role = "viewer";
    let dirty = false;
    const editor = createEditor();
    const tree = h("div", { class: "file-tree", role: "tree" });
    const problems = h("ul", { class: "problems" });
    const status = h("span", { class: "helper-text" });
    const side = h("div", { class: "side-panel glass-panel" });
    const previewFrame = h("iframe", { class: "preview-frame hidden", title: "Preview", sandbox: "allow-scripts" });
    const autoFormat = h("input", { type: "checkbox", checked: localStorage.getItem("gods.formatOnSave") === "1" });
    autoFormat.addEventListener("change", () => localStorage.setItem("gods.formatOnSave", autoFormat.checked ? "1" : "0"));

    async function loadTree() {
      const data = await api(`/api/studio/projects/${pid()}/files`);
      role = data.role;
      const nodes = data.files.map((f) => h("button", { type: "button", class: `tree-file${current?.path === f.path ? " active" : ""}`, role: "treeitem", text: f.path, onclick: guard(() => open(f.path)) }));
      tree.replaceChildren(...(nodes.length ? nodes : [h("p", { class: "helper-text", text: "No files yet. Save code from chat or create one." })]));
    }
    async function open(path) {
      if (dirty && !confirm("Discard unsaved changes?")) return;
      const { artifact } = await api(`/api/studio/projects/${pid()}/file?path=${encodeURIComponent(path)}`);
      current = { path: artifact.path, version: artifact.version, language: artifact.language };
      editor.set(artifact.contents, artifact.language || HL.languageForPath(artifact.path));
      editor.area.readOnly = !(role === "owner" || role === "editor" || role === "admin");
      dirty = false; status.textContent = `${artifact.path} · v${artifact.version}`; problems.replaceChildren();
      loadTree(); lintNow();
    }
    let lintTimer;
    async function lintNow() {
      if (!current) return;
      try {
        const result = await api("/api/studio/tools/lint", { method: "POST", body: { code: editor.area.value, language: current.language, path: current.path } });
        editor.mark(result.diagnostics);
        problems.replaceChildren(...(result.diagnostics.length ? result.diagnostics.map((d) => h("li", { class: `sev-${d.severity}` }, h("button", { type: "button", class: "link-button", text: `${d.line}:${d.column || 1}`, onclick: () => jump(d.line) }), ` ${d.severity}: ${d.message}`))
          : [h("li", { class: "helper-text", text: "No problems found." })]));
      } catch { /* lint is advisory */ }
    }
    function jump(line) {
      const lines = editor.area.value.split("\n").slice(0, line - 1);
      const pos = lines.join("\n").length + (line > 1 ? 1 : 0);
      editor.area.focus(); editor.area.setSelectionRange(pos, pos);
      editor.area.scrollTop = Math.max(0, (line - 3) * 20);
    }
    editor.onInput(() => { dirty = true; status.textContent = `${current?.path} · unsaved`; clearTimeout(lintTimer); lintTimer = setTimeout(lintNow, 500); });
    const formatCode = async () => {
      if (!current) return;
      const r = await api("/api/studio/tools/format", { method: "POST", body: { code: editor.area.value, language: current.language, path: current.path } });
      if (r.changed) { editor.set(r.code, current.language); dirty = true; }
      lintNow();
    };
    const format = guard(formatCode);
    const saveFile = async () => {
      if (!current) return;
      if (autoFormat.checked) await formatCode();
      const { artifact } = await api(`/api/studio/projects/${pid()}/file`, { method: "PUT", body: { path: current.path, contents: editor.area.value, expectedVersion: current.version } });
      current.version = artifact.version; dirty = false; status.textContent = `${artifact.path} · v${artifact.version} saved`;
      toast("Saved."); lintNow();
    };
    const save = guard(saveFile);
    editor.area.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); save(); } });

    const newFile = guard(async () => {
      const path = prompt("New file path (e.g. src/app.js):");
      if (!path) return;
      await api(`/api/studio/projects/${pid()}/file`, { method: "POST", body: { path, contents: "" } });
      await loadTree(); await open(path);
    });
    const del = guard(async () => {
      if (!current || !confirm(`Delete ${current.path}?`)) return;
      await api(`/api/studio/projects/${pid()}/file?path=${encodeURIComponent(current.path)}&version=${current.version}`, { method: "DELETE" });
      current = null; dirty = false; editor.set("", ""); await loadTree();
    });
    const review = guard(async () => {
      if (!current) return toast("Open a file to review.", true);
      if (dirty) await saveFile();
      const r = await api(`/api/studio/projects/${pid()}/review`, { method: "POST", body: { path: current.path } });
      const findings = r.reports.flatMap((x) => x.findings);
      side.replaceChildren(h("h3", { text: "Refactoring & Security review" }), h("p", { class: "helper-text", text: r.note }),
        h("p", { text: `${findings.length} finding(s).` }),
        findings.length ? h("button", { class: "primary-button", type: "button", text: "Apply all safe fixes", onclick: guard(() => applyFixes(undefined)) }) : null,
        ...findings.map((f) => h("div", { class: `finding sev-${f.severity}` },
          h("strong", { text: `[${f.category}] ${f.message}` }), h("small", { text: ` line ${f.line} · ${f.severity} · ${f.ruleId}` }),
          h("p", { text: f.explanation }), h("p", { class: "helper-text", text: `Why: ${f.justification}` }), h("p", { text: `Suggestion: ${f.suggestion}` }),
          f.fixable ? h("button", { class: "mini-button", type: "button", text: "Apply this fix", onclick: guard(() => applyFixes([f.ruleId])) }) : h("span", { class: "helper-text", text: "Manual change recommended." }))));
    });
    async function applyFixes(ruleIds) {
      const r = await api(`/api/studio/projects/${pid()}/review/apply`, { method: "POST", body: { path: current.path, expectedVersion: current.version, ruleIds } });
      toast(r.applied.length ? `Applied ${r.applied.length} fix(es).` : r.message);
      await open(current.path); review();
    }
    const build = guard(async () => {
      const r = await api(`/api/studio/projects/${pid()}/build`, { method: "POST" });
      const report = r.build?.report || r.build || {};
      side.replaceChildren(h("h3", { text: `Build check: ${r.status}` }), h("pre", { class: "output", text: JSON.stringify(report, null, 2).slice(0, 4000) }));
    });
    const preview = guard(async () => {
      const entry = current?.path.endsWith(".html") ? current.path : "index.html";
      if (dirty) await saveFile();
      previewFrame.classList.remove("hidden");
      previewFrame.src = `/api/studio/projects/${pid()}/preview?entry=${encodeURIComponent(entry)}&t=${Date.now()}`;
    });

    const picker = S.projectPicker(() => { current = null; S.show("workspace"); });
    el.append(h("h2", { text: "Build Workspace" }), h("div", { class: "toolbar" }, picker,
      h("button", { class: "secondary-button", type: "button", text: "New file", onclick: newFile }),
      h("button", { class: "primary-button", type: "button", text: "Save", onclick: save }),
      h("button", { class: "secondary-button", type: "button", text: "Format", onclick: format }),
      h("label", { class: "check" }, autoFormat, " Format on save"),
      h("button", { class: "secondary-button", type: "button", text: "Review", onclick: review }),
      h("button", { class: "secondary-button", type: "button", text: "Build check", onclick: build }),
      h("button", { class: "secondary-button", type: "button", text: "Preview", onclick: preview }),
      h("button", { class: "secondary-button", type: "button", text: "Delete", onclick: del })),
      h("div", { class: "workspace-grid" }, tree, h("div", { class: "editor-column" }, status, editor.el, h("h4", { text: "Problems" }), problems), side), previewFrame);
    await loadTree();
  };

  // ---- blueprint editor ---------------------------------------------------------------
  S.views.blueprint = async (el) => {
    await S.refreshProjects();
    if (!needProject(el)) return;
    const data = await api(`/api/studio/projects/${pid()}/blueprint`);
    let version = data.version;
    const canEdit = ["owner", "editor", "admin"].includes(data.role);
    let model = data.model || { app: { name: "My App", version: "0.1.0", description: "", author: "" }, modules: [], pages: [], components: [], routes: [], dataModels: [] };
    const yamlArea = h("textarea", { class: "glass-textarea mono", rows: "24", spellcheck: "false", "aria-label": "gods.blueprint.yaml" });
    const errorsBox = h("ul", { class: "problems" });
    const form = h("div", { class: "blueprint-form" });
    yamlArea.value = data.yaml;
    const showErrors = (errors) => errorsBox.replaceChildren(...(errors || []).map((e) => h("li", { class: "sev-error", text: e })));
    showErrors(data.errors);

    async function modelToYaml() {
      const r = await api("/api/studio/blueprint/serialize", { method: "POST", body: { model } });
      yamlArea.value = r.yaml; showErrors(r.errors);
    }
    const sync = guard(modelToYaml);
    const field = (label, value, onChange, opts = {}) => h("label", { class: "field" }, label,
      h("input", { class: "glass-input", value: value ?? "", disabled: !canEdit, maxlength: opts.max || "200", oninput: (e) => { onChange(e.target.value); sync(); } }));
    function listSection(title, key, blank, renderRow) {
      return h("fieldset", { class: "bp-section" }, h("legend", { text: title }),
        ...model[key].map((item, i) => h("div", { class: "bp-row" }, renderRow(item),
          canEdit ? h("button", { type: "button", class: "mini-button", text: "Remove", onclick: () => { model[key].splice(i, 1); draw(); sync(); } }) : null)),
        canEdit ? h("button", { type: "button", class: "secondary-button", text: `Add ${title.toLowerCase().replace(/s$/, "")}`, onclick: () => { model[key].push(blank()); draw(); sync(); } }) : null);
    }
    function draw() {
      form.replaceChildren(
        h("fieldset", { class: "bp-section" }, h("legend", { text: "Application" }),
          field("Name", model.app.name, (v) => { model.app.name = v; }), field("Version", model.app.version, (v) => { model.app.version = v; }),
          field("Author", model.app.author, (v) => { model.app.author = v; }), field("Description", model.app.description, (v) => { model.app.description = v; }, { max: "1000" })),
        listSection("Modules", "modules", () => ({ name: "", description: "" }), (m) => [field("Name", m.name, (v) => { m.name = v; }), field("Description", m.description, (v) => { m.description = v; })]),
        listSection("Pages", "pages", () => ({ name: "", path: "/", components: [] }), (p) => [field("Name", p.name, (v) => { p.name = v; }), field("Path", p.path, (v) => { p.path = v; }),
          field("Components (comma separated)", p.components.join(", "), (v) => { p.components = v.split(",").map((x) => x.trim()).filter(Boolean); })]),
        listSection("Components", "components", () => ({ name: "", description: "" }), (c) => [field("Name", c.name, (v) => { c.name = v; }), field("Description", c.description, (v) => { c.description = v; })]),
        listSection("Routes", "routes", () => ({ method: "GET", path: "/", handler: "", auth: false }), (r) => [
          h("label", { class: "field" }, "Method", h("select", { class: "glass-input", disabled: !canEdit, onchange: (e) => { r.method = e.target.value; sync(); } }, ["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => h("option", { value: m, text: m, selected: m === r.method })))),
          field("Path", r.path, (v) => { r.path = v; }), field("Handler", r.handler, (v) => { r.handler = v; }),
          h("label", { class: "check" }, h("input", { type: "checkbox", checked: r.auth, disabled: !canEdit, onchange: (e) => { r.auth = e.target.checked; sync(); } }), " Requires auth")]),
        listSection("Data models", "dataModels", () => ({ name: "", fields: [] }), (d) => [field("Name", d.name, (v) => { d.name = v; }),
          h("div", { class: "bp-fields" }, ...d.fields.map((f, i) => h("div", { class: "bp-field" },
            field("Field", f.name, (v) => { f.name = v; }),
            h("select", { class: "glass-input", disabled: !canEdit, "aria-label": "Type", onchange: (e) => { f.type = e.target.value; sync(); } }, ["string", "text", "integer", "number", "boolean", "date", "datetime", "json", "reference"].map((t) => h("option", { value: t, text: t, selected: t === f.type }))),
            h("label", { class: "check" }, h("input", { type: "checkbox", checked: f.required, disabled: !canEdit, onchange: (e) => { f.required = e.target.checked; sync(); } }), " required"),
            canEdit ? h("button", { type: "button", class: "mini-button", text: "×", "aria-label": "Remove field", onclick: () => { d.fields.splice(i, 1); draw(); sync(); } }) : null)),
            canEdit ? h("button", { type: "button", class: "mini-button", text: "+ field", onclick: () => { d.fields.push({ name: "", type: "string", required: false }); draw(); sync(); } }) : null)]));
    }
    yamlArea.addEventListener("input", () => {
      clearTimeout(yamlArea.timer);
      yamlArea.timer = setTimeout(async () => {
        const r = await api("/api/studio/blueprint/parse", { method: "POST", body: { yaml: yamlArea.value } }).catch((e) => ({ errors: [e.message] }));
        showErrors(r.errors);
        if (r.model) { model = r.model; draw(); }
      }, 400);
    });
    const saveBp = guard(async () => {
      const r = await api(`/api/studio/projects/${pid()}/blueprint`, { method: "PUT", body: { yaml: yamlArea.value, expectedVersion: version } });
      version = r.version; toast("Blueprint saved to gods.blueprint.yaml.");
    });
    draw();
    el.append(h("h2", { text: "Blueprint Editor" }), h("div", { class: "toolbar" }, S.projectPicker(() => S.show("blueprint")),
      canEdit ? h("button", { class: "primary-button", type: "button", text: "Save gods.blueprint.yaml", onclick: saveBp }) : h("span", { class: "helper-text", text: "Read-only (viewer)." })),
      errorsBox, h("div", { class: "blueprint-grid" }, form, h("div", {}, h("h3", { text: "gods.blueprint.yaml" }), yamlArea)));
  };

  // ---- git ------------------------------------------------------------------------------
  S.views.git = async (el) => {
    await S.refreshProjects();
    if (!needProject(el)) return;
    const g = await api(`/api/studio/projects/${pid()}/git`);
    const canEdit = ["owner", "editor", "admin"].includes(g.role);
    const canAdmin = ["owner", "admin"].includes(g.role);
    const reload = () => S.show("git");
    const out = h("div", { class: "glass-panel" });
    const post = (sub, body) => guard(async () => { await api(`/api/studio/projects/${pid()}/git/${sub}`, { method: "POST", body }); toast("Done."); reload(); });
    const msg = h("input", { class: "glass-input", placeholder: "Commit message", maxlength: "200" });
    const branchName = h("input", { class: "glass-input", placeholder: "new-branch-name", maxlength: "64" });
    const base = h("select", { class: "glass-input", "aria-label": "Base" }, g.branches.map((b) => h("option", { value: b.name, text: b.name })));
    const head = h("select", { class: "glass-input", "aria-label": "Compare" }, g.branches.map((b) => h("option", { value: b.name, text: b.name, selected: b.name === g.current })));
    const lane = (c) => h("li", { class: "commit" }, h("span", { class: `dot${c.mergeParentId ? " merge" : ""}` }), h("div", {}, h("strong", { text: c.message }),
      h("small", { text: ` ${c.branch} · ${c.authorEmail} · ${new Date(c.createdAt).toLocaleString()} · ${c.id.slice(0, 7)}` })));
    el.append(h("h2", { text: "Git" }), h("div", { class: "toolbar" }, S.projectPicker(reload)),
      h("p", { text: `Current branch: ${g.current}. ${g.dirty.length ? `${g.dirty.length} uncommitted change(s).` : "Working tree clean."}` }),
      h("p", { class: "helper-text", text: "History is stored as snapshots inside the studio (not a real git repository)." }),
      h("div", { class: "git-grid" },
        h("div", { class: "glass-panel" }, h("h3", { text: "Branches" }),
          h("ul", { class: "branch-list" }, g.branches.map((b) => h("li", {}, `${b.isCurrent ? "● " : "○ "}${b.name}`,
            canAdmin && !b.isCurrent ? [h("button", { class: "mini-button", type: "button", text: "Checkout", onclick: post("checkout", { branch: b.name, discard: g.dirty.length ? confirm("Discard uncommitted changes?") : false }) }),
              h("button", { class: "mini-button", type: "button", text: "Merge into current", onclick: post("merge", { source: b.name }) })] : null))),
          canEdit ? h("div", { class: "button-row" }, branchName, h("button", { class: "secondary-button", type: "button", text: "Create branch", onclick: guard(async () => { await api(`/api/studio/projects/${pid()}/git/branches`, { method: "POST", body: { name: branchName.value } }); reload(); }) })) : null,
          canEdit ? h("div", { class: "button-row" }, msg, h("button", { class: "primary-button", type: "button", text: "Commit", onclick: guard(async () => { await api(`/api/studio/projects/${pid()}/git/commit`, { method: "POST", body: { message: msg.value } }); reload(); }) })) : null,
          g.dirty.length ? h("ul", {}, g.dirty.map((d) => h("li", { text: `${d.status}: ${d.path}` }))) : null),
        h("div", { class: "glass-panel" }, h("h3", { text: "History" }), h("ul", { class: "commit-list" }, g.commits.length ? g.commits.map(lane) : [h("li", { class: "helper-text", text: "No commits yet." })])),
        h("div", { class: "glass-panel" }, h("h3", { text: "Compare branches" }), h("div", { class: "button-row" }, base, "→", head,
          h("button", { class: "secondary-button", type: "button", text: "Compare", onclick: guard(async () => {
            const r = await api(`/api/studio/projects/${pid()}/git/compare?base=${encodeURIComponent(base.value)}&head=${encodeURIComponent(head.value)}`);
            out.replaceChildren(r.changes.length ? h("ul", {}, r.changes.map((c) => h("li", { class: `diff-${c.status}`, text: `${c.status}: ${c.path}${c.added != null ? ` (+${c.added}/-${c.removed})` : ""}` }))) : h("p", { text: "Branches are identical." }));
          }) })), out)));
  };

  // ---- collaboration ----------------------------------------------------------------------
  S.views.collab = async (el) => {
    await S.refreshProjects();
    if (!needProject(el)) return;
    const reload = () => S.show("collab");
    const data = await api(`/api/studio/projects/${pid()}/collaborators`);
    const act = await api(`/api/studio/projects/${pid()}/activity`);
    const isAdmin = ["owner", "admin"].includes(data.role);
    const presence = h("p", { class: "helper-text", text: `Online: ${act.online.map((u) => u.email || u).join(", ") || "just you"}` });
    const feed = h("ul", { class: "activity-list" }, act.activity.map((a) => h("li", {}, h("time", { text: new Date(a.createdAt).toLocaleTimeString() }), ` ${a.summary}`)));
    const live = h("p", { class: "helper-text", text: "Connecting to live updates…" });
    const email = h("input", { class: "glass-input", type: "email", placeholder: "collaborator@example.com", maxlength: "254" });
    const roleSel = h("select", { class: "glass-input", "aria-label": "Role" }, data.roles.filter((r) => r !== "admin" || data.role === "owner").map((r) => h("option", { value: r, text: r })));
    const source = new EventSource(`/api/studio/projects/${pid()}/stream`);
    S.cleanup = () => source.close();
    source.addEventListener("ready", () => { live.textContent = "Live: you will see teammates' agent activity and builds."; });
    source.addEventListener("presence", (e) => { presence.textContent = `Online: ${JSON.parse(e.data).users.map((u) => u.email || u).join(", ")}`; });
    const push = (text) => feed.prepend(h("li", {}, h("time", { text: new Date().toLocaleTimeString() }), ` ${text}`));
    source.addEventListener("activity", (e) => push(JSON.parse(e.data).activity.summary));
    source.addEventListener("agent-start", (e) => push(`${JSON.parse(e.data).by} started ${JSON.parse(e.data).agent}.`));
    source.addEventListener("agent-step", (e) => { const d = JSON.parse(e.data); push(`Agent step: ${d.step} (${d.status})`); });
    source.addEventListener("agent-done", (e) => push(`${JSON.parse(e.data).agent} finished.`));
    source.addEventListener("build", (e) => { const d = JSON.parse(e.data); push(`Build ${d.status} (${d.by}).`); });
    el.append(h("h2", { text: "Collaboration" }), h("div", { class: "toolbar" }, S.projectPicker(reload)), live, presence,
      h("p", { class: "helper-text", text: "Roles: viewer reads; editor edits files, chats and commits; admin also manages members, checkout and merge; the owner can grant admin." }),
      h("table", { class: "table" }, h("thead", {}, h("tr", {}, ["Member", "Role", ""].map((t) => h("th", { text: t })))),
        h("tbody", {}, data.collaborators.map((c) => h("tr", {}, h("td", { text: c.email }), h("td", { text: c.role }),
          h("td", {}, isAdmin ? h("button", { class: "mini-button", type: "button", text: "Remove", onclick: guard(async () => { await api(`/api/studio/projects/${pid()}/collaborators/${c.userId}`, { method: "DELETE" }); reload(); }) }) : null)))
        )),
      isAdmin ? h("div", { class: "button-row" }, email, roleSel, h("button", { class: "primary-button", type: "button", text: "Invite", onclick: guard(async () => {
        await api(`/api/studio/projects/${pid()}/collaborators`, { method: "POST", body: { email: email.value, role: roleSel.value } }); toast("Collaborator added."); reload();
      }) })) : h("p", { class: "helper-text", text: "Only project admins can invite people." }),
      h("h3", { text: "Live activity" }), feed);
  };

  // ---- admin dashboard ------------------------------------------------------------------------
  const money = (c, cur = "USD") => `${(c / 100).toFixed(2)} ${cur}`;
  const table = (cols, rows) => h("table", { class: "table" }, h("thead", {}, h("tr", {}, cols.map((c) => h("th", { text: c })))), h("tbody", {}, rows));
  const TABS = {
    async overview(el) {
      const { summary, payments, settings } = await api("/api/admin/overview");
      el.append(h("div", { class: "stat-grid" }, Object.entries(summary).filter(([, v]) => typeof v !== "object").map(([k, v]) => h("div", { class: "stat-card glass-panel" }, h("strong", { text: String(v) }), h("span", { text: k })))),
        h("p", { class: "helper-text", text: `Registration: ${settings.registrationOpen ? "open" : "closed"} · Maintenance: ${settings.maintenanceMode ? "ON" : "off"} · Payments recorded: ${JSON.stringify(payments)}` }));
    },
    async users(el) {
      const { users } = await api("/api/admin/users");
      const act = (u, action, extra) => guard(async () => { await api(`/api/admin/users/${u.id}/${action}`, { method: "POST", body: extra || {} }); toast("Done."); S.show("admin"); });
      el.append(table(["Email", "Role", "Plan", "Projects", "Sessions", "Status", "Actions"], users.map((u) => h("tr", {}, h("td", { text: u.email }), h("td", { text: u.role }), h("td", { text: u.plan }), h("td", { text: u.projects }), h("td", { text: u.sessions }), h("td", { text: u.disabled ? "disabled" : "active" }),
        h("td", {}, u.role === "admin" ? h("span", { class: "helper-text", text: "protected" }) : [
          u.disabled ? h("button", { class: "mini-button", type: "button", text: "Enable", onclick: act(u, "enable") }) : h("button", { class: "mini-button", type: "button", text: "Disable", onclick: act(u, "disable", { reason: "Disabled by admin" }) }),
          h("button", { class: "mini-button", type: "button", text: "Revoke sessions", onclick: act(u, "revoke-sessions") }),
          h("button", { class: "mini-button danger", type: "button", text: "Delete", onclick: () => { if (prompt(`Type ${u.email} to confirm deletion`) === u.email) act(u, "delete", { confirmEmail: u.email })(); } })])))));
    },
    async settings(el) {
      const { settings } = await api("/api/admin/settings");
      const inputs = {};
      const row = (key, label, type) => {
        const input = h("input", type === "boolean" ? { type: "checkbox", checked: settings[key] } : { class: "glass-input", type: type === "number" ? "number" : "text", value: settings[key], maxlength: "300" });
        inputs[key] = [input, type];
        return h("label", { class: "field" }, label, input);
      };
      el.append(row("registrationOpen", "Registration open", "boolean"), row("maintenanceMode", "Maintenance mode (blocks chat for non-admins)", "boolean"), row("allowProviderChat", "Allow provider-backed chat", "boolean"),
        row("announcement", "Announcement banner", "text"), row("chatRatePerHour", "Chat messages per hour per user", "number"), row("maxCollaboratorsPerProject", "Max collaborators per project", "number"),
        h("button", { class: "primary-button", type: "button", text: "Save settings", onclick: guard(async () => {
          const body = {};
          for (const [key, [input, type]] of Object.entries(inputs)) body[key] = type === "boolean" ? input.checked : type === "number" ? Number(input.value) : input.value;
          await api("/api/admin/settings", { method: "PUT", body }); toast("Settings saved.");
        }) }));
    },
    async payments(el) {
      const d = await api("/api/admin/payments");
      const f = { email: h("input", { class: "glass-input", placeholder: "user email" }), plan: h("input", { class: "glass-input", placeholder: "plan", value: "pro" }), amount: h("input", { class: "glass-input", type: "number", step: "0.01", placeholder: "amount" }) };
      el.append(h("p", { class: "announcement", text: `⚠ ${d.processor.status}: ${d.processor.note}` }), h("p", { text: `Totals: ${JSON.stringify(d.totals)}` }),
        h("div", { class: "button-row" }, f.email, f.plan, f.amount, h("button", { class: "primary-button", type: "button", text: "Record manual payment", onclick: guard(async () => {
          await api("/api/admin/payments", { method: "POST", body: { email: f.email.value, plan: f.plan.value, amountCents: Math.round(Number(f.amount.value) * 100), currency: "USD", status: "paid" } }); S.show("admin");
        }) })),
        table(["When", "User", "Plan", "Amount", "Status"], d.payments.map((p) => h("tr", {}, h("td", { text: new Date(p.createdAt).toLocaleString() }), h("td", { text: p.email || p.userId }), h("td", { text: p.plan }), h("td", { text: money(p.amountCents, p.currency) }), h("td", { text: p.status })))));
    },
    async api(el) {
      const d = await api("/api/admin/api");
      el.append(h("p", { text: `Chat limit/hour: ${d.limits.chatRatePerHour} · Body limit: ${d.limits.bodyLimitBytes} B` }), h("h4", { text: "Endpoints" }), h("ul", {}, d.endpoints.map((e) => h("li", { text: e }))),
        h("h4", { text: "Usage" }), h("pre", { class: "output", text: JSON.stringify(d.usage, null, 2) }));
    },
    async adk(el) {
      const d = await api("/api/admin/agents");
      el.append(h("p", { class: "helper-text", text: "Global agent defaults (ADK). Users can override these in their Agent Command Center." }), table(["Agent", "Model", "Enabled", "Customised", ""], d.agents.map((a) => {
        const model = h("input", { class: "glass-input", value: a.model });
        const en = h("input", { type: "checkbox", checked: a.enabled });
        return h("tr", {}, h("td", { text: a.name }), h("td", {}, model), h("td", {}, en), h("td", { text: a.customized ? "yes" : "no" }),
          h("td", {}, h("button", { class: "mini-button", type: "button", text: "Save", onclick: guard(async () => { await api(`/api/admin/agents/${a.id}`, { method: "PUT", body: { model: model.value, enabled: en.checked } }); toast("Saved."); }) }),
            h("button", { class: "mini-button", type: "button", text: "Reset", onclick: guard(async () => { await api(`/api/admin/agents/${a.id}`, { method: "DELETE" }); S.show("admin"); }) })));
      })));
    },
    async deployment(el) {
      const d = await api("/api/admin/deployment");
      const out = h("pre", { class: "output" });
      el.append(h("p", { class: "helper-text", text: d.note }), h("p", { text: `Production mode: ${d.productionMode} · Secret key configured: ${d.secretKeyConfigured}` }),
        h("ul", {}, d.environment.map((e) => h("li", { text: `${e.name}: ${e.configured ? "set" : "not set"}` }))),
        h("div", { class: "button-row" }, d.actions.map((a) => h("button", { class: "secondary-button", type: "button", text: `Run ${a}`, onclick: guard(async () => {
          out.textContent = "Running…"; const r = await api("/api/admin/deployment/run", { method: "POST", body: { action: a } }); out.textContent = `${r.status} (exit ${r.exitCode})\n${r.output}`;
        }) }))), out);
    },
    async security(el) {
      const d = await api("/api/admin/security");
      el.append(table(["Check", "Status"], d.posture.map((p) => h("tr", {}, h("td", { text: p.check }), h("td", { text: p.status })))), h("p", { text: `Active sessions: ${d.activeSessions}` }),
        h("button", { class: "mini-button danger", type: "button", text: "Revoke ALL sessions", onclick: guard(async () => { if (!confirm("Sign everyone out, including you?")) return; await api("/api/admin/security/revoke-all-sessions", { method: "POST", body: {} }); location.reload(); }) }));
    },
    async audit(el) {
      const { audit } = await api("/api/admin/audit");
      el.append(table(["When", "Actor", "Action", "Target"], audit.map((a) => h("tr", {}, h("td", { text: new Date(a.createdAt).toLocaleString() }), h("td", { text: a.actor }), h("td", { text: a.action }), h("td", { text: a.target || "" })))));
    }
  };
  S.views.admin = async (el) => {
    if (S.user.role !== "admin") return el.append(h("p", { class: "error-message", text: "Admin access required." }));
    const body = h("div", { class: "glass-panel" });
    const tabs = h("div", { class: "tabs", role: "tablist" });
    const open = guard(async (name) => {
      tabs.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
      body.replaceChildren(); await TABS[name](body);
    });
    Object.keys(TABS).forEach((name) => tabs.append(h("button", { type: "button", role: "tab", class: "tab", "data-tab": name, text: name.toUpperCase(), onclick: () => open(name) })));
    el.append(h("h2", { text: "Admin dashboard" }), tabs, body);
    open("overview");
  };
})(window);
