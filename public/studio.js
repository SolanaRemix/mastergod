"use strict";

// Studio shell: navigation drawer, dashboard, streaming chat, composer, agent command center, tutorial.
(function studioCore(root) {
  const S = { user: null, view: "home", views: {}, projects: [], agents: [], conversationId: null, history: [] };
  root.GodsStudio = S;

  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === false || value == null) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (key === "value") node.value = value;
      else if (key === "checked" || key === "disabled" || key === "selected") node[key] = Boolean(value);
      else node.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...options.headers },
      body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body
    });
    let body = {};
    try { body = await response.json(); } catch { /* empty body */ }
    if (!response.ok) throw new Error(body.error || body.reason || `Request failed (${response.status}).`);
    return body;
  }

  function toast(message, isError) {
    const live = document.querySelector("#live-region");
    if (live) live.textContent = message;
    const box = document.querySelector("#studio-toast");
    box.textContent = message;
    box.className = `studio-toast ${isError ? "is-error" : "is-ok"}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => box.classList.add("hidden"), 5000);
  }
  const guard = (fn) => async (...args) => { try { return await fn(...args); } catch (error) { toast(error.message, true); } };

  function markdown(target, text) {
    target.innerHTML = root.GodsMarkdown ? root.GodsMarkdown.render(text) : "";
    if (!root.GodsMarkdown) target.textContent = text;
    root.GodsHighlight.highlightAll(target);
    target.querySelectorAll(".markdown-code-block").forEach((block) => {
      if (block.querySelector(".code-actions")) return;
      const code = block.querySelector("code");
      const actions = h("div", { class: "code-actions" },
        h("button", { type: "button", class: "mini-button", text: "Copy", onclick: () => navigator.clipboard?.writeText(code.textContent).then(() => toast("Code copied.")) }),
        h("button", { type: "button", class: "mini-button", text: "Save to workspace", onclick: guard(() => saveSnippet(code.textContent, block.querySelector(".markdown-code-language")?.textContent)) }));
      block.append(actions);
    });
  }

  async function saveSnippet(code, language) {
    if (!S.projects.length) throw new Error("Create a project first (Projects view) to save code into a workspace.");
    const projectId = S.workspaceProject || S.projects[0].id;
    const ext = { python: "py", javascript: "js", js: "js", typescript: "ts", html: "html", css: "css", json: "json", java: "java", cpp: "cpp", sql: "sql" }[(language || "").toLowerCase()] || "txt";
    const name = `snippets/snippet-${Date.now().toString(36)}.${ext}`;
    await api(`/api/studio/projects/${projectId}/file`, { method: "POST", body: { path: name, contents: code } });
    toast(`Saved ${name} to the workspace.`);
  }

  // ---- shell ---------------------------------------------------------------
  const NAV = [
    ["Primary", [["home", "＋", "New chat"], ["dashboard", "▦", "Dashboard"], ["projects", "▤", "Projects"]]],
    ["Workspace", [["workspace", "⌘", "Actual Build Workspace"], ["blueprint", "◇", "Blueprint Editor"], ["git", "⑂", "Git Operations"], ["collab", "♧", "Collaboration"]]],
    ["AI system", [["agents", "◈", "Agent Command Center"]]],
    ["Learn", [["tutorial", "?", "Tutorial"]]],
    ["Administration", [["admin", "⚙", "Administration", true]]]
  ];

  function applyTheme(theme) {
    const selected = ["light", "dark"].includes(theme) ? theme : "system";
    const effective = selected === "system"
      ? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
      : selected;
    document.documentElement.dataset.theme = effective;
    localStorage.setItem("gods.theme", selected);
    const control = document.querySelector("#studio-theme");
    if (control) control.value = selected;
  }

  function buildShell() {
    if (document.querySelector("#studio-root")) return;
    const recent = h("div", { id: "studio-recent", class: "studio-recent" });
    const search = h("input", { id: "conversation-search", class: "glass-input", type: "search", placeholder: "Search conversations", "aria-label": "Search conversations" });
    const drawer = h("nav", { id: "studio-drawer", class: "studio-drawer", "aria-label": "Studio navigation" },
      NAV.map(([group, items], index) => h("details", { class: "nav-group", open: index < 3 }, h("summary", { text: group }),
        items.map(([id, icon, label, adminOnly]) => h("button", { type: "button", class: "nav-item", "data-view": id, "data-admin": adminOnly ? "1" : false, text: `${icon}  ${label}`, onclick: () => {
          if (id === "home") { S.conversationId = null; S.chatProject = null; }
          show(id);
        } })), id === "home" ? [search, recent] : null)),
      h("div", { class: "drawer-footer" }, h("label", { for: "studio-theme", text: "Appearance" }),
        h("select", { id: "studio-theme", class: "glass-input", "aria-label": "Theme", onchange: (event) => applyTheme(event.target.value) },
          ["system", "light", "dark"].map((theme) => h("option", { value: theme, text: theme[0].toUpperCase() + theme.slice(1) })) )));
    const rootEl = h("section", { id: "studio-root", class: "studio-root hidden" }, drawer,
      h("div", { class: "studio-main" }, h("div", { id: "studio-toast", class: "studio-toast hidden", role: "status" }), h("div", { id: "studio-view" })));
    document.querySelector("main").prepend(rootEl);
    const toggle = h("button", { id: "drawer-toggle", type: "button", class: "secondary-button hidden", "aria-label": "Toggle navigation", text: "☰ Menu", onclick: () => drawer.classList.toggle("open") });
    const title = h("span", { id: "studio-title", class: "studio-title", text: "Master GODS" });
    const newChat = h("button", { id: "new-chat-button", type: "button", class: "secondary-button hidden", "aria-label": "Start a new chat", text: "＋", onclick: () => { S.conversationId = null; S.chatProject = null; show("home"); } });
    document.querySelector(".topbar").insertBefore(title, document.querySelector(".topbar-actions"));
    document.querySelector(".topbar-actions").prepend(toggle, newChat);
    applyTheme(localStorage.getItem("gods.theme") || "system");
    matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", () => {
      if ((localStorage.getItem("gods.theme") || "system") === "system") applyTheme("system");
    });
    search.addEventListener("input", () => renderRecent(search.value));
    S.renderRecent = renderRecent;
  }

  function renderRecent(query = "") {
    const host = document.querySelector("#studio-recent");
    if (!host) return;
    const term = query.trim().toLowerCase();
    const recent = (S.conversations || []).filter((c) => (c.title || "").toLowerCase().includes(term)).slice(0, 12);
    host.replaceChildren(...(recent.length ? recent.map((c) => h("button", {
      type: "button", class: `recent-item${c.id === S.conversationId ? " active" : ""}`,
      title: c.title, text: c.title || "New conversation",
      onclick: () => { S.conversationId = c.id; show("home"); }
    })) : [h("p", { class: "helper-text", text: term ? "No matching conversations." : "Your recent conversations appear here." })]));
  }

  function show(view) {
    S.view = view;
    document.querySelectorAll("#studio-drawer .nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
    document.querySelector("#studio-title").textContent = view === "home"
      ? ((S.conversations || []).find((c) => c.id === S.conversationId)?.title || "Master GODS")
      : ({ dashboard: "Dashboard", projects: "Projects", agents: "Agent Command Center", blueprint: "Blueprint", workspace: "Build Workspace", git: "Git Operations", collab: "Collaboration", tutorial: "Tutorial", admin: "Administration" }[view] || "Master GODS");
    document.querySelector("#studio-drawer").classList.remove("open");
    const legacy = document.querySelector("#app-workspace");
    const hero = document.querySelector(".hero");
    legacy.classList.toggle("hidden", view !== "projects");
    hero.classList.toggle("hidden", view !== "projects");
    document.querySelector("#new-chat-button").classList.toggle("hidden", view !== "home");
    const container = document.querySelector("#studio-view");
    container.replaceChildren();
    S.cleanup?.(); S.cleanup = null;
    if (view === "projects") return;
    const render = S.views[view];
    Promise.resolve(render?.(container)).catch((error) => container.append(h("p", { class: "error-message", text: error.message })));
  }
  S.show = show;

  async function refreshProjects() {
    S.projects = (await api("/api/studio/projects")).projects || [];
    S.projects.forEach((p) => { p.title = p.title || p.id.slice(0, 8); });
  }
  S.refreshProjects = refreshProjects;

  S.mount = guard(async (user) => {
    S.user = user;
    buildShell();
    document.querySelector("#studio-root").classList.remove("hidden");
    document.querySelector("#drawer-toggle").classList.remove("hidden");
    document.querySelector("#new-chat-button").classList.remove("hidden");
    document.querySelectorAll("#studio-drawer [data-admin]").forEach((item) => item.classList.toggle("hidden", user.role !== "admin"));
    await refreshProjects();
    const settings = await api("/api/studio/public").catch(() => ({}));
    S.announcement = settings.announcement || "";
    S.conversations = (await api("/api/studio/conversations")).conversations || [];
    renderRecent();
    show("home");
  });
  S.unmount = () => {
    S.cleanup?.(); S.cleanup = null;
    document.querySelector("#studio-root")?.classList.add("hidden");
    document.querySelector("#drawer-toggle")?.classList.add("hidden");
    document.querySelector("#app-workspace")?.classList.add("hidden");
    document.querySelector(".hero")?.classList.remove("hidden");
    S.user = null; S.conversationId = null; S.history = [];
  };

  function projectPicker(onChange, includeNone) {
    const select = h("select", { class: "glass-input", "aria-label": "Project" },
      includeNone ? h("option", { value: "", text: "No project (personal chat)" }) : null,
      S.projects.map((p) => h("option", { value: p.id, text: `${p.title}${p.role && p.role !== "owner" ? ` (${p.role})` : ""}`, selected: p.id === S.workspaceProject })));
    select.addEventListener("change", () => { if (select.value) S.workspaceProject = select.value; onChange(select.value); });
    if (!includeNone && S.projects.length && !S.workspaceProject) S.workspaceProject = S.projects[0].id;
    if (!includeNone && S.workspaceProject) select.value = S.workspaceProject;
    return select;
  }
  S.projectPicker = projectPicker;

  // ---- dashboard -------------------------------------------------------------
  S.views.dashboard = async (el) => {
    const { dashboard: d, settings } = await api("/api/studio/dashboard");
    const stat = (label, value) => h("div", { class: "stat-card glass-panel" }, h("strong", { text: String(value) }), h("span", { text: label }));
    el.append(h("h2", { text: "Your dashboard" }),
      settings.announcement ? h("p", { class: "announcement", text: `📣 ${settings.announcement}` }) : null,
      h("div", { class: "stat-grid" }, stat("Projects", d.projects), stat("Shared with you", d.shared), stat("Conversations", d.conversations),
        stat("Messages sent", d.messages), stat("Files", d.files), stat("Plan", d.plan)),
      h("div", { class: "button-row" },
        h("button", { class: "primary-button", type: "button", text: "New chat", onclick: () => { S.conversationId = null; show("home"); } }),
        h("button", { class: "secondary-button", type: "button", text: "Take the tutorial", onclick: () => show("tutorial") })),
      h("h3", { text: "Recent activity" }),
      d.recentActivity.length ? h("ul", { class: "activity-list" }, d.recentActivity.map((a) => h("li", {}, h("time", { text: new Date(a.createdAt).toLocaleString() }), ` ${a.summary}`)))
        : h("p", { class: "helper-text", text: "No activity yet. Start a chat or open a project workspace." }));
  };

  // ---- chat -------------------------------------------------------------------
  const SUGGESTIONS = [
    ["🌐 Build a simple website", "Build a simple website for a small bakery with a menu, opening hours and a contact form."],
    ["🧰 Build a web application", "Build me a simple To-Do list app with add, complete and delete actions."],
    ["🐍 Python data analysis", "Generate Python code for data analysis: load a CSV with pandas, clean it, and plot a summary."],
    ["🐞 Debug this function", "Debug this function and explain the fix:\n\nfunction total(items) { var sum = 0; for (var i = 0; i <= items.length; i++) sum += items[i].price; return sum; }"],
    ["🗄 Design a database schema", "Design a database schema for an online store with customers, products, orders and payments."],
    ["📜 Create a Python script", "Create a Python script that renames all files in a folder using a date prefix."],
    ["⚡ Build a complete SaaS application", "Plan and scaffold a SaaS application with accounts, subscriptions, a dashboard, and a REST API. Identify any external services that need credentials."],
    ["🔌 Build a REST API", "Design and implement a REST API for managing tasks, including validation, authorization, and tests."],
    ["🧠 Create an AI agent", "Design a specialist AI agent with a clear role, tools, permission scopes, and measurable output."],
    ["🎮 Build a 3D game", "Plan a small browser game and identify the runtime and assets needed before implementation."],
    ["🔎 Analyze an application", "Review the attached application files for architecture, reliability, and security issues."]
  ];
  const TEXT_EXT = /\.(txt|md|json|js|mjs|ts|tsx|jsx|py|java|c|cpp|h|css|html|xml|yaml|yml|sql|sh|csv|log|toml|ini)$/i;
  const MAX_FILES = 5, MAX_TEXT = 100000;

  S.views.home = async (el) => {
    const [models, agentData, convs] = await Promise.all([api("/api/studio/models"), api("/api/studio/agents"), api("/api/studio/conversations")]);
    S.agents = agentData.agents;
    S.conversations = convs.conversations || [];
    S.renderRecent?.(document.querySelector("#conversation-search")?.value || "");
    let files = [];
    let busy = false;
    const log = h("div", { id: "chat-log", class: "chat-log", "aria-live": "polite" });
    const plan = h("div", { class: "suggested-plan hidden", "aria-label": "Suggested task plan" });
    const welcome = h("section", { class: "welcome glass-panel" },
      h("h3", { text: "Welcome to Master GODS AI Studio" }),
      h("p", { class: "helper-text", text: agentData.providerConfigured ? "A provider is connected: replies stream from your model." : "No AI provider key is saved. Replies use the local deterministic mode (templates, not a live model). Add a key under Projects → provider settings." }),
      h("div", { class: "suggestion-grid" }, SUGGESTIONS.map(([label, prompt]) => h("button", { type: "button", class: "suggestion-card", onclick: () => { input.value = prompt; input.focus(); updateTools(); }, text: label }))));
    const convSelect = h("select", { class: "glass-input", "aria-label": "Conversation" }, h("option", { value: "", text: "New conversation" }),
      convs.conversations.map((c) => h("option", { value: c.id, text: c.title || "Untitled", selected: c.id === S.conversationId })));
    const input = h("textarea", { class: "glass-textarea", id: "chat-input", rows: "3", maxlength: "10000", placeholder: "Describe what you want to build, ask a question, or paste code…" });
    const toolBar = h("div", { class: "tool-chips", "aria-label": "Suggested tools" });
    const modelSel = h("select", { class: "glass-input", "aria-label": "Model" }, models.models.map((m) => h("option", { value: m.id, text: m.label })));
    const agentSel = h("select", { class: "glass-input", "aria-label": "Agent" }, h("option", { value: "auto", text: "Agent: Auto-select" }),
      S.agents.filter((a) => a.enabled).map((a) => h("option", { value: a.id, text: a.name })));
    if (S.preselectAgent) { agentSel.value = S.preselectAgent; S.preselectAgent = null; }
    const attachList = h("div", { class: "attach-list" });
    const fileInput = h("input", { type: "file", multiple: true, class: "hidden", accept: ".txt,.md,.json,.js,.ts,.tsx,.jsx,.py,.java,.c,.cpp,.h,.css,.html,.xml,.yaml,.yml,.sql,.sh,.csv,.pdf,.doc,.docx,image/*" });
    const sendBtn = h("button", { class: "primary-button", type: "submit", text: "Send" });
    const stopBtn = h("button", { class: "secondary-button hidden", type: "button", text: "Stop" });
    const form = h("form", { class: "composer glass-panel" }, toolBar, input, attachList,
      h("div", { class: "composer-row" },
        h("button", { class: "secondary-button", type: "button", text: "📎 Attach", onclick: () => fileInput.click() }), fileInput, agentSel, modelSel, stopBtn, sendBtn));
    el.append(h("div", { class: "chat-head" }, h("h2", { text: "Chat" }), convSelect), log.children.length ? null : welcome, plan, log, form);

    function renderAttachments() {
      attachList.replaceChildren(...files.map((f, index) => {
        const bar = h("progress", { max: "100", value: String(f.progress) });
        const preview = h("div", { class: "attach-preview" });
        if (f.previewUrl && f.file.type.startsWith("image/")) preview.append(h("img", { src: f.previewUrl, alt: f.file.name }));
        else if (f.previewUrl && f.file.type === "application/pdf") preview.append(h("object", { data: f.previewUrl, type: "application/pdf", "aria-label": `PDF preview of ${f.file.name}` }, "PDF preview unavailable"));
        else if (f.text != null) preview.append(h("pre", {}, h("code", { text: f.text.slice(0, 600) })));
        else preview.append(h("span", { class: "helper-text", text: "This file is previewed locally; only supported text files are transmitted to the chat service." }));
        return h("div", { class: "attach-item" },
          h("div", { class: "attach-meta" }, h("strong", { text: f.file.name }), ` ${(f.file.size / 1024).toFixed(1)} KB `, f.error ? h("span", { class: "error-message", text: f.error }) : bar,
            h("button", { type: "button", class: "mini-button", text: "Remove", onclick: () => { if (f.previewUrl) URL.revokeObjectURL(f.previewUrl); files.splice(index, 1); renderAttachments(); } })), preview);
      }));
    }
    fileInput.addEventListener("change", () => {
      for (const file of fileInput.files) {
        if (files.length >= MAX_FILES) { toast(`You can attach up to ${MAX_FILES} files.`, true); break; }
        if (file.size > 10 * 1024 * 1024) { toast(`${file.name} is larger than 10 MB.`, true); continue; }
        const entry = { file, progress: 0, text: null, previewUrl: null };
        files.push(entry);
        if (file.type.startsWith("image/") || file.type === "application/pdf") entry.previewUrl = URL.createObjectURL(file);
        const isText = TEXT_EXT.test(file.name) || file.type.startsWith("text/");
        const reader = new FileReader();
        reader.onprogress = (event) => { if (event.lengthComputable) { entry.progress = Math.round(event.loaded / event.total * 100); renderAttachments(); } };
        reader.onload = () => { entry.progress = 100; if (isText) entry.text = String(reader.result).slice(0, MAX_TEXT); renderAttachments(); };
        reader.onerror = () => { entry.error = "Could not read file."; renderAttachments(); };
        if (isText) reader.readAsText(file); else reader.readAsArrayBuffer(file);
      }
      fileInput.value = "";
      renderAttachments();
    });
    form.addEventListener("dragover", (event) => {
      if (event.dataTransfer?.types.includes("Files")) {
        event.preventDefault();
        form.classList.add("drop-target");
      }
    });
    form.addEventListener("dragleave", (event) => {
      if (!form.contains(event.relatedTarget)) form.classList.remove("drop-target");
    });
    form.addEventListener("drop", (event) => {
      if (!event.dataTransfer?.files.length) return;
      event.preventDefault();
      form.classList.remove("drop-target");
      const transfer = new DataTransfer();
      [...fileInput.files, ...event.dataTransfer.files].slice(0, MAX_FILES).forEach((file) => transfer.items.add(file));
      fileInput.files = transfer.files;
      fileInput.dispatchEvent(new Event("change"));
    });
    input.addEventListener("paste", (event) => {
      const pastedFiles = [...(event.clipboardData?.files || [])];
      if (!pastedFiles.length) return;
      event.preventDefault();
      const transfer = new DataTransfer();
      [...fileInput.files, ...pastedFiles].slice(0, MAX_FILES).forEach((file) => transfer.items.add(file));
      fileInput.files = transfer.files;
      fileInput.dispatchEvent(new Event("change"));
    });
    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 240)}px`;
    });

    let timer;
    async function updateTools() {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          const result = await api("/api/studio/suggest", { method: "POST", body: { text: input.value, history: S.history.slice(-3) } });
          toolBar.replaceChildren(...result.tools.map((t) => h("button", { type: "button", class: "chip", title: t.description || t.label, text: `${t.icon || "🔧"} ${t.label}`,
            onclick: () => { input.value = `${t.prompt || t.label + ": "}${input.value ? "\n" + input.value : ""}`; input.focus(); } })));
          if (result.agent && agentSel.value === "auto") agentSel.title = `Auto-select will use ${result.agent.name}`;
        } catch { /* suggestions are optional */ }
      }, 350);
    }
    input.addEventListener("input", updateTools);
    input.addEventListener("keydown", (event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) form.requestSubmit(); });

    function addMessage(role, who) {
      const body = h("div", { class: "message-body" });
      log.append(h("article", { class: `message ${role}` }, h("header", { text: who }), body));
      log.scrollTop = log.scrollHeight;
      welcome.remove();
      return body;
    }
    function renderPlan(steps) {
      plan.classList.remove("hidden");
      plan.replaceChildren(
        h("p", { class: "helper-text", text: "Suggested plan — these steps are not run as separate agents." }),
        h("ul", {}, steps.map((s) => h("li", { "data-step": s.id, class: "step-proposed", text: s.label })))
      );
    }

    async function loadConversation(id) {
      log.replaceChildren(); plan.classList.add("hidden"); S.history = [];
      S.conversationId = id || null;
      if (!id) return;
      const { messages } = await api(`/api/studio/conversations/${id}/messages`);
      for (const m of messages) {
        const body = addMessage(m.role === "user" ? "user" : "assistant", m.role === "user" ? m.author : (m.agentId || "assistant"));
        if (m.role === "user") { body.textContent = m.content; S.history.push(m.content); } else markdown(body, m.content);
      }
    }
    convSelect.addEventListener("change", guard(() => loadConversation(convSelect.value)));
    if (S.conversationId) await loadConversation(S.conversationId);

    form.addEventListener("submit", guard(async (event) => {
      event.preventDefault();
      const content = input.value.trim();
      if (!content || busy) return;
      if (files.some((f) => f.progress < 100 && !f.error)) return toast("Wait for file uploads to finish.", true);
      busy = true; sendBtn.disabled = true; stopBtn.classList.remove("hidden");
      const controller = new AbortController();
      stopBtn.onclick = () => controller.abort();
      try {
        if (!S.conversationId) {
          const { conversation } = await api("/api/studio/conversations", { method: "POST", body: { title: content.slice(0, 60), projectId: S.chatProject || undefined } });
          S.conversationId = conversation.id;
          S.conversations = [{ ...conversation, mine: true }, ...(S.conversations || []).filter((item) => item.id !== conversation.id)];
          S.renderRecent?.();
          convSelect.append(h("option", { value: conversation.id, text: conversation.title || "Untitled", selected: true }));
          convSelect.value = conversation.id;
        }
        const attachments = files.map((f) => ({ name: f.file.name, type: f.file.type, size: f.file.size, content: f.text ?? undefined }));
        addMessage("user", S.user.email).textContent = content + (attachments.length ? `\n📎 ${attachments.map((a) => a.name).join(", ")}` : "");
        S.history.push(content);
        input.value = ""; files.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl)); files = []; renderAttachments(); toolBar.replaceChildren();
        const out = addMessage("assistant", "Thinking…");
        const header = out.previousSibling;
        out.classList.add("streaming");
        let text = "";
        let pending = false;
        const paint = () => { pending = false; markdown(out, text); log.scrollTop = log.scrollHeight; };
        await streamPost(`/api/studio/conversations/${S.conversationId}/messages`, { content, agentId: agentSel.value, model: modelSel.value, attachments }, controller.signal, (event, data) => {
          if (event === "meta") header.textContent = `${data.agent.name} · ${data.mode === "provider" ? data.model : "local deterministic mode"}`;
          else if (event === "plan") renderPlan(data.steps);
          else if (event === "delta") { text += data.text; if (!pending) { pending = true; requestAnimationFrame(paint); } }
          else if (event === "error") toast(data.message || data.error || "The response failed.", true);
        });
        paint();
        out.classList.remove("streaming");
        plan.querySelectorAll("li").forEach((li) => { if (li.className === "step-running") li.className = "step-done"; });
      } catch (error) {
        if (error.name !== "AbortError") throw error;
        toast("Generation stopped.");
      } finally {
        busy = false; sendBtn.disabled = false; stopBtn.classList.add("hidden");
      }
    }));
  };

  async function streamPost(path, body, signal, onEvent) {
    const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || `Request failed (${response.status}).`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let lastSequence = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        const event = /^event: (.+)$/m.exec(block)?.[1];
        const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!event || !data) continue;
        let payload;
        try { payload = JSON.parse(data); }
        catch { throw new Error("The server sent an invalid streaming event."); }
        if (Number.isInteger(payload.sequence)) {
          if (payload.sequence <= lastSequence) continue;
          lastSequence = payload.sequence;
        }
        onEvent(event, payload);
      }
    }
  }

  // ---- agent command center -----------------------------------------------------
  S.views.agents = async (el) => {
    const data = await api("/api/studio/agents");
    const detail = h("div", { class: "agent-detail glass-panel" }, h("p", { class: "helper-text", text: "Select an agent to view and edit its configuration." }));
    const list = h("div", { class: "agent-list" });
    const refresh = async () => { el.replaceChildren(); S.views.agents(el); };
    const statusBadge = (s) => h("span", { class: `badge badge-${s}`, text: s });
    data.agents.forEach((agent) => {
      list.append(h("button", { type: "button", class: "agent-card", onclick: () => open(agent) },
        h("strong", { text: agent.name }), statusBadge(agent.status), h("small", { text: agent.role || agent.summary || "" })));
    });
    function open(agent) {
      const instr = h("textarea", { class: "glass-textarea", rows: "10", maxlength: "6000", "aria-label": "System instructions", value: agent.systemInstructions });
      const model = h("input", { class: "glass-input", value: agent.model, maxlength: "100", "aria-label": "Model assignment" });
      const enabled = h("input", { type: "checkbox", checked: agent.enabled });
      const tools = new Set(agent.tools);
      const toolBoxes = agent.availableTools.map((id) => {
        return h("label", { class: "check" }, h("input", { type: "checkbox", checked: tools.has(id), onchange: (e) => e.target.checked ? tools.add(id) : tools.delete(id) }), ` ${id}`);
      });
      detail.replaceChildren(h("h3", { text: agent.name }), statusBadge(agent.status), h("p", { text: agent.identity || agent.summary || "" }),
        h("label", { text: "System instructions" }), instr, h("label", { text: "Model assignment" }), model,
        h("label", { class: "check" }, enabled, " Enabled"), h("h4", { text: "Tools" }), h("div", { class: "check-grid" }, toolBoxes),
        h("h4", { text: "Permission scopes" }), h("p", { class: "helper-text", text: agent.permissionScopes.join(", ") || "none" }),
        h("div", { class: "button-row" },
          h("button", { class: "primary-button", type: "button", text: "Save", onclick: guard(async () => {
            await api(`/api/studio/agents/${agent.id}`, { method: "PUT", body: { instructions: instr.value, model: model.value, enabled: enabled.checked, tools: [...tools] } });
            toast("Agent saved."); refresh();
          }) }),
          h("button", { class: "secondary-button", type: "button", text: "Reset to default", onclick: guard(async () => { await api(`/api/studio/agents/${agent.id}`, { method: "DELETE" }); toast("Reset."); refresh(); }) }),
          h("button", { class: "secondary-button", type: "button", text: "Run a task with this agent", onclick: () => { S.preselectAgent = agent.id; S.conversationId = null; show("home"); } })));
    }
    el.append(h("h2", { text: "Agent Command Center" }), h("p", { class: "helper-text", text: data.providerConfigured ? "Provider connected." : "No provider key saved: agents run in local deterministic mode." }), h("div", { class: "agent-layout" }, list, detail));
  };

  // ---- tutorial ---------------------------------------------------------------------
  const TUTORIAL = [
    ["Start a conversation", "Open Chat from the menu. Pick “New conversation”. Each conversation keeps its history so you can continue later or share it with project collaborators.", "Open Chat", () => show("home")],
    ["Make a software request", "Describe your goal in plain words, for example: Build me a simple To-Do list app. You can attach files and choose an agent or model, or leave it on Auto.", "Use this example prompt", () => { S.prefill = "Build me a simple To-Do list app"; show("home"); setTimeout(() => { const i = document.querySelector("#chat-input"); if (i) i.value = S.prefill; }, 200); }],
    ["Watch the agents work", "A task plan appears: the Master Orchestrator decomposes the request and routes steps to specialists (UI/UX, Frontend, Reviewer…). Steps turn from pending to running to done while the answer streams in.", "Meet the agents", () => show("agents")],
    ["Save code to the workspace", "Every code block has a “Save to workspace” button. Saved files appear in the Build Workspace explorer.", "Open Build Workspace", () => show("workspace")],
    ["Edit, lint, review and preview", "In the editor you get live lint feedback, Format, and Save (Ctrl+S). Run Review for refactoring and security suggestions, then preview HTML files.", "Open Build Workspace", () => show("workspace")],
    ["Commit and collaborate", "Use Git to commit snapshots, branch and merge. Invite teammates in Collaboration and give them viewer, editor or admin access.", "Open Git", () => show("git")]
  ];
  S.views.tutorial = (el) => {
    let step = Number(localStorage.getItem("gods.tutorial") || 0) || 0;
    const body = h("div", { class: "glass-panel tutorial-card" });
    const draw = () => {
      localStorage.setItem("gods.tutorial", String(step));
      const [title, text, actionLabel, action] = TUTORIAL[step];
      body.replaceChildren(h("p", { class: "eyebrow", text: `Step ${step + 1} of ${TUTORIAL.length}` }), h("progress", { max: String(TUTORIAL.length), value: String(step + 1) }), h("h3", { text: title }), h("p", { text }),
        h("div", { class: "button-row" },
          h("button", { class: "secondary-button", type: "button", disabled: step === 0, text: "Back", onclick: () => { step -= 1; draw(); } }),
          h("button", { class: "secondary-button", type: "button", text: actionLabel, onclick: action }),
          h("button", { class: "primary-button", type: "button", text: step === TUTORIAL.length - 1 ? "Finish" : "Next", onclick: () => { if (step === TUTORIAL.length - 1) { localStorage.removeItem("gods.tutorial"); show("dashboard"); } else { step += 1; draw(); } } })));
    };
    draw();
    el.append(h("h2", { text: "Getting started tutorial" }), body);
  };

  Object.assign(S, { h, api, toast, guard, markdown, streamPost });
})(window);
