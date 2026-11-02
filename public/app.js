const promptForm = document.querySelector("#prompt-form");
const promptInput = document.querySelector("#prompt");
const reviewSection = document.querySelector("#review-section");
const requirementList = document.querySelector("#requirement-list");
const requirementCount = document.querySelector("#requirement-count");
const approveButton = document.querySelector("#approve-button");
const projectsList = document.querySelector("#projects-list");
const projectCount = document.querySelector("#project-count");
const errorMessage = document.querySelector("#error-message");
const liveRegion = document.querySelector("#live-region");
const healthLabel = document.querySelector("#health-label");
const appVersion = document.querySelector("#app-version");
const authSection = document.querySelector("#auth-section");
const appWorkspace = document.querySelector("#app-workspace");
const loginForm = document.querySelector("#login-form");
const registerForm = document.querySelector("#register-form");
const signoutButton = document.querySelector("#signout-button");
const gameForm = document.querySelector("#game-form");
const gamePromptInput = document.querySelector("#game-prompt");
const gameWorkspace = document.querySelector("#game-workspace");
const gameTitle = document.querySelector("#game-title");
const gameSummary = document.querySelector("#game-summary");
const gameStatus = document.querySelector("#game-status");
const gameSpecification = document.querySelector("#game-specification");
const gameLimitations = document.querySelector("#game-limitations");
const gamePreview = document.querySelector("#game-preview");
const gameVersion = document.querySelector("#game-version");
const gameRefineForm = document.querySelector("#game-refine-form");
const gameRefinementInput = document.querySelector("#game-refinement");
const gameSaveStatus = document.querySelector("#game-save-status");
const gamesList = document.querySelector("#games-list");
const gameCount = document.querySelector("#game-count");
const saveGameButton = document.querySelector("#save-game");
const loadGameSaveButton = document.querySelector("#load-game-save");
const restartGameButton = document.querySelector("#restart-game");
const restoreGameVersionButton = document.querySelector("#restore-game-version");

let draftProject = null;
let activeGame = null;
let currentGameSave = null;
let latestPreviewState = null;
const FLASH_GLOW_VARIANTS = new Set(["purple", "orange", "red", "green", "yellow", "cyan", "blue", "rainbow-subtle"]);
const FLASH_GLOW_INTENSITIES = new Set(["subtle", "medium", "strong"]);
const FLASH_GLOW_RADII = new Set(["sm", "md", "lg", "xl"]);

function FlashGlowCard({
  variant = "cyan",
  intensity = "subtle",
  animated = false,
  hoverGlow = true,
  selected = false,
  interactive = false,
  blur = true,
  borderRadius = "md",
  className = ""
} = {}) {
  const card = document.createElement("article");
  card.classList.add("flash-glow-card");
  String(className).split(/\s+/).filter((name) => /^[a-zA-Z0-9_-]+$/.test(name)).forEach((name) => card.classList.add(name));
  card.dataset.glow = FLASH_GLOW_VARIANTS.has(variant) ? variant : "cyan";
  card.dataset.intensity = FLASH_GLOW_INTENSITIES.has(intensity) ? intensity : "subtle";
  card.dataset.animated = String(Boolean(animated));
  card.dataset.hoverGlow = String(Boolean(hoverGlow));
  card.dataset.selected = String(Boolean(selected));
  card.dataset.interactive = String(Boolean(interactive));
  card.dataset.blur = String(blur !== false);
  if (typeof blur === "number" && Number.isFinite(blur)) {
    card.style.setProperty("--card-blur", `${Math.min(24, Math.max(0, blur))}px`);
  }
  if (FLASH_GLOW_RADII.has(borderRadius)) {
    card.dataset.radius = borderRadius;
  } else if (typeof borderRadius === "number" && Number.isFinite(borderRadius) && borderRadius >= 0 && borderRadius <= 48) {
    card.style.setProperty("--card-radius", `${borderRadius}px`);
  } else if (typeof borderRadius === "string" && /^\d+(?:\.\d+)?(?:px|rem|em)$/.test(borderRadius)) {
    card.style.setProperty("--card-radius", borderRadius);
  }
  if (interactive) card.tabIndex = 0;
  return card;
}

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.classList.remove("hidden");
}

function clearError() {
  errorMessage.textContent = "";
  errorMessage.classList.add("hidden");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers
    }
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "The request could not be completed.");
  return body;
}

function updateRequirementCount() {
  const accepted = requirementList.querySelectorAll('input[type="checkbox"]:checked').length;
  requirementCount.textContent = `${accepted} requirement${accepted === 1 ? "" : "s"} will be included.`;
}

function renderRequirements(project) {
  requirementList.replaceChildren();
  project.requirements.forEach((requirement) => {
    const item = FlashGlowCard({ variant: "purple", className: "requirement-item" });

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.setAttribute("aria-label", `Include requirement ${requirement.id}`);
    checkbox.addEventListener("change", updateRequirementCount);

    const content = document.createElement("div");
    content.className = "requirement-content";
    const badge = document.createElement("span");
    badge.className = "requirement-id";
    badge.textContent = requirement.id;

    const text = document.createElement("textarea");
    text.value = requirement.text;
    text.maxLength = 2000;
    text.setAttribute("aria-label", `Edit requirement ${requirement.id}`);
    text.rows = Math.min(4, Math.max(2, Math.ceil(requirement.text.length / 90)));

    content.append(badge, text);
    item.append(checkbox, content);
    requirementList.append(item);
  });
  updateRequirementCount();
  reviewSection.classList.remove("hidden");
  reviewSection.scrollIntoView({
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    block: "start"
  });
}

function makeTag(text, className = "status-pill") {
  const tag = document.createElement("span");
  tag.className = className;
  tag.classList.add("neon-badge");
  if (/^(BLOCKED|QUEUED|RUNNING|RETRYING|COMPLETED|FAILED)$/i.test(text)) {
    tag.classList.add(text.toLowerCase());
  }
  tag.textContent = text.replaceAll("_", " ");
  return tag;
}

function renderProject(project) {
  const card = FlashGlowCard({
    variant: project.status === "DRAFT" ? "purple" : "cyan",
    className: "project-card"
  });

  const header = document.createElement("div");
  header.className = "project-card-header";
  const title = document.createElement("h3");
  title.textContent = project.title;
  header.append(title, makeTag(project.status));

  const summary = document.createElement("p");
  summary.className = "project-summary";
  summary.textContent = project.originalRequest;
  const metadata = document.createElement("p");
  metadata.className = "project-meta";
  const requirementCount = project.status === "DRAFT"
    ? project.requirements.length
    : project.blueprint.requirements.length;
  const requirementLabel = project.status === "DRAFT" ? "draft requirement" : "approved requirement";
  metadata.textContent = `${requirementCount} ${requirementLabel}${requirementCount === 1 ? "" : "s"} · Created ${new Date(project.createdAt).toLocaleString()}`;
  card.append(header, summary, metadata);

  if (project.tasks?.length) {
    const taskHeading = document.createElement("h4");
    taskHeading.className = "subheading";
    taskHeading.textContent = "Build tasks";
    const taskList = document.createElement("ul");
    taskList.className = "task-list";
    project.tasks.forEach((task) => {
      const row = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = task.assignedAgent.name;
      row.append(name, makeTag(task.status, "status-pill blocked"));
      taskList.append(row);
    });
    card.append(taskHeading, taskList);
  }

  const notice = document.createElement("p");
  notice.className = "project-notice";
  notice.textContent = project.status === "DRAFT"
    ? "Needs your approval before it can move forward."
    : "Plan saved. Build workers are blocked until an AI provider and secure execution environment are configured.";
  card.append(notice);

  const blueprintLink = document.createElement("a");
  blueprintLink.className = "text-link";
  blueprintLink.href = `/api/projects/${encodeURIComponent(project.id)}/blueprint`;
  blueprintLink.textContent = "Download project blueprint";
  card.append(blueprintLink);

  if (project.status !== "DRAFT") {
    const executionSection = document.createElement("section");
    executionSection.className = "agent-task-panel flash-glow-card";
    executionSection.dataset.glow = "purple";
    const executionHeading = document.createElement("h4");
    executionHeading.textContent = "Agent execution graph";
    const executionDescription = document.createElement("p");
    executionDescription.className = "helper-text";
    executionDescription.textContent = "Create traceable tasks from this approved blueprint. Tasks remain blocked until a real worker is configured.";
    const executionSummary = document.createElement("div");
    executionSummary.className = "helper-text";
    function renderExecutionSummary(execution) {
      executionSummary.replaceChildren();
      if (!execution) return;
      const team = document.createElement("p");
      const selectedNames = [...new Set((execution.selectedAgents || []).map((agent) => agent.agentName))];
      team.textContent = selectedNames.length
        ? `Planned team (catalog definitions, not running workers): ${selectedNames.join(", ")}.`
        : "No matching agent definitions are available.";
      executionSummary.append(team);
      if (execution.capabilityGaps?.length) {
        const gaps = document.createElement("p");
        const unavailable = [...new Set(execution.capabilityGaps.map((gap) => gap.capability))];
        gaps.textContent = `Execution is blocked. Unavailable capabilities or workers: ${unavailable.join(", ")}.`;
        executionSummary.append(gaps);
      }
    }
    const createGraph = addButton("Create blueprint task graph", "primary-button");
    const executionTasks = document.createElement("div");
    executionTasks.className = "agent-task-list";
    createGraph.addEventListener("click", async () => {
      createGraph.disabled = true;
      try {
        const result = await api(`/api/projects/${encodeURIComponent(project.id)}/generate`, {
          method: "POST",
          body: JSON.stringify({})
        });
        executionDescription.textContent = result.executionNote;
        renderExecutionSummary(result.execution);
        createGraph.classList.add("hidden");
        renderAgentTasks(project, executionTasks, result.tasks);
      } catch (error) {
        showError(error.message);
      } finally {
        createGraph.disabled = false;
      }
    });
    executionSection.append(executionHeading, executionDescription, executionSummary, createGraph, executionTasks);
    card.append(executionSection);
    api(`/api/projects/${encodeURIComponent(project.id)}/tasks`)
      .then(({ tasks }) => {
        if (tasks.length) {
          createGraph.classList.add("hidden");
          executionDescription.textContent = tasks.some((task) => task.status === "QUEUED")
            ? "Tasks are queued for registered workers; outcomes will be recorded with evidence."
            : "The graph is persisted; tasks are blocked because no verified worker is registered.";
          renderAgentTasks(project, executionTasks, tasks);
          api(`/api/projects/${encodeURIComponent(project.id)}/execution`)
            .then(({ execution }) => renderExecutionSummary(execution))
            .catch(() => {});
        }
      })
      .catch(() => {});

    const artifactSection = document.createElement("section");
    artifactSection.className = "artifact-workspace flash-glow-card";
    artifactSection.dataset.glow = "cyan";
    const artifactHeading = document.createElement("h4");
    artifactHeading.textContent = "Project files";
    const artifactDescription = document.createElement("p");
    artifactDescription.className = "helper-text";
    artifactDescription.textContent = "Create and manage files persisted in your project database. Agent generation is not available until a verified worker is configured.";
    const artifactToggle = document.createElement("button");
    artifactToggle.className = "secondary-button";
    artifactToggle.type = "button";
    artifactToggle.textContent = "Open file manager";
    const fileManager = document.createElement("div");
    fileManager.className = "hidden";
    artifactToggle.addEventListener("click", async () => {
      fileManager.classList.toggle("hidden");
      if (!fileManager.classList.contains("hidden")) {
        artifactToggle.textContent = "Refresh file manager";
        await renderArtifactManager(project, fileManager);
      }
    });
    artifactSection.append(artifactHeading, artifactDescription, artifactToggle, fileManager);
    card.append(artifactSection);
    api(`/api/projects/${encodeURIComponent(project.id)}/artifacts`)
      .then(({ files }) => {
        if (files.length) {
          artifactDescription.textContent = `${files.length} project files are persisted in local storage.`;
        }
      })
      .catch(() => {});
  }
  projectsList.append(card);
}

function taskGlow(status) {
  return ({
    QUEUED: "purple",
    RUNNING: "cyan",
    RETRYING: "yellow",
    COMPLETED: "green",
    FAILED: "red",
    BLOCKED: "blue"
  })[status] || "cyan";
}

function renderAgentTasks(project, container, tasks) {
  container.replaceChildren();
  tasks.forEach((task) => {
    const card = FlashGlowCard({
      variant: taskGlow(task.status),
      intensity: task.status === "RUNNING" ? "strong" : "subtle",
      animated: task.status === "RUNNING",
      selected: task.status === "RUNNING",
      className: "agent-task-card"
    });
    card.dataset.status = task.status.toLowerCase();
    const header = document.createElement("div");
    header.className = "agent-task-header";
    const title = document.createElement("h5");
    title.textContent = task.title;
    header.append(title, makeTag(task.status, "status-pill task-status"));
    const metadata = document.createElement("p");
    metadata.className = "project-meta";
    metadata.textContent = `${task.agentId} · Attempt ${task.attempt}/${task.maxAttempts} · ${task.projectType} project`;
    card.append(header, metadata);
    if (task.blockedReason) {
      const reason = document.createElement("p");
      reason.className = "task-blocked-reason";
      reason.textContent = task.blockedReason;
      card.append(reason);
    }
    if (["QUEUED", "BLOCKED", "FAILED"].includes(task.status)) {
      const runTask = addButton("Run specialist task", "primary-button");
      runTask.addEventListener("click", async () => {
        runTask.disabled = true;
        try {
          await api(`/api/projects/${encodeURIComponent(project.id)}/tasks/${encodeURIComponent(task.taskId)}/run`, {
            method: "POST",
            body: JSON.stringify({})
          });
          const { tasks: latest } = await api(`/api/projects/${encodeURIComponent(project.id)}/tasks`);
          renderAgentTasks(project, container, latest);
          liveRegion.textContent = `${task.agentId} completed or updated its task. Review the saved output and evidence.`;
        } catch (error) {
          showError(error.message);
        } finally {
          runTask.disabled = false;
        }
      });
      card.append(runTask);
    }
    const activity = document.createElement("details");
    activity.className = "agent-task-events";
    const summary = document.createElement("summary");
    summary.textContent = "Execution history";
    const events = document.createElement("ol");
    events.className = "agent-event-list";
    activity.append(summary, events);
    activity.addEventListener("toggle", async () => {
      if (!activity.open || events.childElementCount) return;
      try {
        const { events: history } = await api(
          `/api/projects/${encodeURIComponent(project.id)}/tasks/${encodeURIComponent(task.taskId)}/events`
        );
        history.forEach((event) => {
          const item = document.createElement("li");
          item.textContent = `${event.fromState || "CREATED"} → ${event.toState} · ${new Date(event.createdAt).toLocaleString()}`;
          events.append(item);
        });
      } catch (error) {
        const item = document.createElement("li");
        item.textContent = error.message;
        events.append(item);
      }
    });
    card.append(activity);
    container.append(card);
  });
}

function encodeBase64Utf8(value) {
  const bytes = new TextEncoder().encode(value);
  return encodeBase64Bytes(bytes);
}

function encodeBase64Bytes(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function addButton(label, className = "secondary-button") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  if (className.split(/\s+/).includes("primary-button")) button.classList.add("neon-button");
  button.textContent = label;
  return button;
}

async function renderArtifactManager(project, container, selectedPath) {
  try {
    const tree = await api(`/api/projects/${encodeURIComponent(project.id)}/artifacts`);
    container.replaceChildren();

    const toolbar = document.createElement("div");
    toolbar.className = "artifact-toolbar";
    const createFile = addButton("New file");
    createFile.addEventListener("click", async () => {
      const filePath = window.prompt("Choose a project-relative file path, such as docs/notes.md");
      if (!filePath) return;
      const contents = window.prompt("Enter the initial file contents", "");
      if (contents === null) return;
      try {
        const { artifact } = await api(`/api/projects/${encodeURIComponent(project.id)}/artifacts/files`, {
          method: "POST",
          body: JSON.stringify({ path: filePath, contents, language: filePath.split(".").pop() || "text" })
        });
        await renderArtifactManager(project, container, artifact.path);
      } catch (error) {
        showError(error.message);
      }
    });
    const createFolder = addButton("New folder");
    createFolder.addEventListener("click", async () => {
      const folderPath = window.prompt("Choose a project-relative folder path");
      if (!folderPath) return;
      try {
        await api(`/api/projects/${encodeURIComponent(project.id)}/artifacts/directories`, {
          method: "POST",
          body: JSON.stringify({ path: folderPath })
        });
        await renderArtifactManager(project, container);
      } catch (error) {
        showError(error.message);
      }
    });
    const exportLink = document.createElement("a");
    exportLink.className = "secondary-button";
    exportLink.href = `/api/projects/${encodeURIComponent(project.id)}/artifacts/export`;
    exportLink.textContent = "Export project JSON";
    const zipLink = document.createElement("a");
    zipLink.className = "secondary-button";
    zipLink.href = `/api/projects/${encodeURIComponent(project.id)}/artifacts/zip`;
    zipLink.textContent = "Download verified project ZIP";
    const uploadInput = document.createElement("input");
    uploadInput.type = "file";
    uploadInput.multiple = true;
    uploadInput.accept = ".js,.jsx,.ts,.tsx,.html,.css,.json,.yaml,.yml,.md,.sql,.py,.php,.sol,.rs,.toml,.xml,.txt,.svg";
    uploadInput.setAttribute("aria-label", "Upload UTF-8 text files to the project");
    uploadInput.addEventListener("change", async () => {
      const selectedFiles = [...(uploadInput.files || [])];
      if (!selectedFiles.length) return;
      try {
        for (const file of selectedFiles) {
          if (file.size > 256 * 1024) throw new Error(`${file.name} exceeds the 256 KiB per-file limit.`);
          const contents = await file.text();
          const filePath = file.webkitRelativePath || file.name;
          await api(`/api/projects/${encodeURIComponent(project.id)}/artifacts/upload`, {
            method: "POST",
            body: JSON.stringify({
              path: filePath,
              contentsBase64: encodeBase64Utf8(contents),
              language: filePath.split(".").pop() || "text"
            })
          });
        }
        await renderArtifactManager(project, container);
        liveRegion.textContent = `${selectedFiles.length} text file(s) uploaded and saved to the project.`;
      } catch (error) {
        showError(error.message);
      } finally {
        uploadInput.value = "";
      }
    });
    const uploadLabel = document.createElement("label");
    uploadLabel.className = "secondary-button";
    uploadLabel.textContent = "Upload UTF-8 text files";
    uploadLabel.append(uploadInput);
    const zipImportInput = document.createElement("input");
    zipImportInput.type = "file";
    zipImportInput.accept = ".zip,application/zip";
    zipImportInput.setAttribute("aria-label", "Import a project ZIP without overwriting existing files");
    zipImportInput.addEventListener("change", async () => {
      const archiveFile = zipImportInput.files?.[0];
      if (!archiveFile) return;
      if (archiveFile.size > 5 * 1024 * 1024) {
        showError("Project ZIP uploads are limited to 5 MiB.");
        zipImportInput.value = "";
        return;
      }
      if (!window.confirm("Import text files from this ZIP? Existing files will not be overwritten; path conflicts will stop the import.")) {
        zipImportInput.value = "";
        return;
      }
      try {
        const archiveBase64 = encodeBase64Bytes(await archiveFile.arrayBuffer());
        const result = await api(`/api/projects/${encodeURIComponent(project.id)}/artifacts/zip-import`, {
          method: "POST",
          body: JSON.stringify({ archiveBase64 })
        });
        await renderArtifactManager(project, container);
        liveRegion.textContent = `Imported ${result.imported.length} files and read them back from project storage.`;
      } catch (error) {
        showError(error.message);
      } finally {
        zipImportInput.value = "";
      }
    });
    const zipImportLabel = document.createElement("label");
    zipImportLabel.className = "secondary-button";
    zipImportLabel.textContent = "Import project ZIP";
    zipImportLabel.append(zipImportInput);
    const buildButton = addButton("Run safe static checks", "primary-button");
    const buildReport = document.createElement("pre");
    buildReport.className = "project-build-report hidden";
    buildReport.setAttribute("aria-live", "polite");
    buildButton.addEventListener("click", async () => {
      buildButton.disabled = true;
      try {
        const { build } = await api(`/api/projects/${encodeURIComponent(project.id)}/build`, {
          method: "POST",
          body: JSON.stringify({})
        });
        buildReport.textContent = [
          `${build.status} · ${new Date(build.createdAt).toLocaleString()}`,
          ...build.report.logs,
          ...build.report.checks.map((check) => `${check.status} ${check.path}: ${check.check} — ${check.message}`),
          build.report.execution
        ].filter(Boolean).join("\n");
        buildReport.classList.remove("hidden");
      } catch (error) {
        showError(error.message);
      } finally {
        buildButton.disabled = false;
      }
    });
    toolbar.append(createFile, createFolder, exportLink, zipLink, uploadLabel, zipImportLabel, buildButton);
    container.append(buildReport);

    const columns = document.createElement("div");
    columns.className = "artifact-columns";
    const treePanel = document.createElement("div");
    treePanel.className = "artifact-tree glass-card";
    const treeHeading = document.createElement("h5");
    treeHeading.textContent = "Files";
    treePanel.append(treeHeading);
    tree.directories.forEach((directory) => {
      const row = document.createElement("div");
      row.className = "artifact-tree-row";
      const label = document.createElement("span");
      label.textContent = `▸ ${directory}/`;
      const rename = addButton("Rename");
      rename.addEventListener("click", async () => {
        const toPath = window.prompt("New folder path", directory);
        if (!toPath || toPath === directory) return;
        try {
          await api(`/api/projects/${encodeURIComponent(project.id)}/artifacts/directories`, {
            method: "PATCH",
            body: JSON.stringify({ fromPath: directory, toPath })
          });
          await renderArtifactManager(project, container);
        } catch (error) {
          showError(error.message);
        }
      });
      const remove = addButton("Delete");
      remove.addEventListener("click", async () => {
        if (!window.confirm(`Delete folder ${directory} and all files in it? This cannot be undone.`)) return;
        try {
          await api(`/api/projects/${encodeURIComponent(project.id)}/artifacts/directories?path=${encodeURIComponent(directory)}`, {
            method: "DELETE"
          });
          await renderArtifactManager(project, container);
        } catch (error) {
          showError(error.message);
        }
      });
      row.append(label, rename, remove);
      treePanel.append(row);
    });
    tree.files.forEach((file) => {
      const row = document.createElement("div");
      row.className = "artifact-tree-row";
      const open = addButton(`${file.path} · v${file.version}`);
      open.className = "artifact-file-button";
      open.setAttribute("aria-current", selectedPath === file.path ? "true" : "false");
      open.addEventListener("click", () => renderArtifactManager(project, container, file.path));
      row.append(open);
      treePanel.append(row);
    });
    columns.append(treePanel);

    if (selectedPath) {
      const { artifact } = await api(`/api/projects/${encodeURIComponent(project.id)}/artifacts/file?path=${encodeURIComponent(selectedPath)}`);
      const editorPanel = document.createElement("div");
      editorPanel.className = "artifact-editor";
      const fileTitle = document.createElement("h5");
      fileTitle.textContent = artifact.path;
      const state = document.createElement("p");
      state.className = "helper-text";
      state.textContent = `Version ${artifact.version} · ${artifact.sizeBytes} bytes · ${artifact.checksum.slice(0, 12)}… · ${artifact.status.replaceAll("_", " ")}`;
      const editor = document.createElement("textarea");
      editor.className = "artifact-editor-input glass-textarea";
      editor.setAttribute("aria-label", `Edit ${artifact.path}`);
      editor.spellcheck = false;
      editor.value = artifact.contents;
      const editorShell = document.createElement("div");
      editorShell.className = "artifact-source-editor";
      const lineNumbers = document.createElement("pre");
      lineNumbers.className = "artifact-line-numbers";
      lineNumbers.setAttribute("aria-hidden", "true");
      const updateLineNumbers = () => {
        lineNumbers.textContent = Array.from({ length: editor.value.split("\n").length }, (_, index) => String(index + 1)).join("\n");
        lineNumbers.scrollTop = editor.scrollTop;
      };
      editor.addEventListener("input", updateLineNumbers);
      editor.addEventListener("scroll", () => { lineNumbers.scrollTop = editor.scrollTop; });
      updateLineNumbers();
      editorShell.append(lineNumbers, editor);
      const markdownPreview = document.createElement("div");
      markdownPreview.className = "artifact-markdown-preview glass-card";
      markdownPreview.setAttribute("aria-label", "Markdown preview");
      const renderMarkdownPreview = () => {
        const escaped = editor.value.replace(/[&<>"']/g, (character) => ({
          "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
        })[character]);
        markdownPreview.innerHTML = escaped
          .replace(/^### (.+)$/gm, "<h3>$1</h3>")
          .replace(/^## (.+)$/gm, "<h2>$1</h2>")
          .replace(/^# (.+)$/gm, "<h1>$1</h1>")
          .replace(/^\s*[-*] (.+)$/gm, "<li>$1</li>")
          .replace(/(?:<li>.*<\/li>\n?)+/g, (items) => `<ul>${items}</ul>`)
          .replace(/`([^`\n]+)`/g, "<code>$1</code>")
          .split(/\n{2,}/)
          .map((block) => /^(?:<h[1-3]>|<ul>)/.test(block) ? block : `<p>${block.replace(/\n/g, "<br>")}</p>`)
          .join("");
      };
      const isMarkdown = artifact.path.toLowerCase().endsWith(".md")
        || artifact.language === "markdown" || artifact.language === "md";
      if (isMarkdown) {
        renderMarkdownPreview();
        editor.addEventListener("input", renderMarkdownPreview);
      } else {
        markdownPreview.classList.add("hidden");
      }
      const livePreview = document.createElement("section");
      livePreview.className = "project-live-preview";
      if (artifact.path.toLowerCase().endsWith(".html")) {
        const previewHeading = document.createElement("h6");
        previewHeading.textContent = "Sandboxed preview of this saved HTML file";
        const previewControls = document.createElement("div");
        previewControls.className = "artifact-toolbar";
        const viewport = document.createElement("select");
        viewport.className = "glass-select preview-viewport-select";
        viewport.setAttribute("aria-label", "Preview viewport width");
        for (const [label, value] of [["Mobile · 390px", "390"], ["Large mobile · 430px", "430"], ["Tablet · 768px", "768"], ["Laptop · 1024px", "1024"], ["Desktop · 1440px", "1440"], ["Custom width", "custom"]]) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = label;
          viewport.append(option);
        }
        const previewStatus = document.createElement("span");
        previewStatus.className = "helper-text";
        previewStatus.textContent = "Preview runs in a sandbox without network access.";
        const previewFrame = document.createElement("iframe");
        previewFrame.className = "project-preview-frame";
        previewFrame.title = `Preview of ${artifact.path}`;
        previewFrame.setAttribute("sandbox", "allow-scripts");
        previewFrame.setAttribute("loading", "lazy");
        previewFrame.hidden = true;
        const setViewport = () => {
          let width = Number(viewport.value);
          if (viewport.value === "custom") {
            width = Number(window.prompt("Custom preview width in pixels (320–1920)", "1280"));
            if (!Number.isInteger(width) || width < 320 || width > 1920) {
              viewport.value = "390";
              width = 390;
            }
          }
          previewFrame.style.width = `${width}px`;
          previewFrame.style.maxWidth = "100%";
        };
        viewport.addEventListener("change", setViewport);
        setViewport();
        const runPreview = addButton("Run saved-file preview", "primary-button");
        runPreview.addEventListener("click", () => {
          previewFrame.src = `/api/projects/${encodeURIComponent(project.id)}/preview?entry=${encodeURIComponent(artifact.path)}`;
          previewFrame.hidden = false;
          previewStatus.textContent = "Loaded this saved project file; external network requests are blocked.";
        });
        const stopPreview = addButton("Stop");
        stopPreview.addEventListener("click", () => {
          previewFrame.src = "about:blank";
          previewFrame.hidden = true;
          previewStatus.textContent = "Preview stopped.";
        });
        const restartPreview = addButton("Restart");
        restartPreview.addEventListener("click", () => {
          if (previewFrame.src && !previewFrame.src.endsWith("about:blank")) previewFrame.src = previewFrame.src;
        });
        previewControls.append(viewport, runPreview, stopPreview, restartPreview, previewStatus);
        livePreview.append(previewHeading, previewControls, previewFrame);
      }
      const controls = document.createElement("div");
      controls.className = "artifact-toolbar";
      const save = addButton("Save changes", "primary-button");
      save.addEventListener("click", async () => {
        try {
          const result = await api(`/api/projects/${encodeURIComponent(project.id)}/artifacts/file?path=${encodeURIComponent(artifact.path)}`, {
            method: "PUT",
            body: JSON.stringify({ contents: editor.value, expectedVersion: artifact.version })
          });
          await renderArtifactManager(project, container, result.artifact.path);
          liveRegion.textContent = `${artifact.path} saved and read back from storage.`;
        } catch (error) {
          showError(error.message);
        }
      });
      const download = document.createElement("a");
      download.className = "secondary-button";
      download.href = `/api/projects/${encodeURIComponent(project.id)}/artifacts/file?path=${encodeURIComponent(artifact.path)}&download=1`;
      download.textContent = "Download";
      const findReplace = addButton("Find and replace");
      findReplace.addEventListener("click", () => {
        const find = window.prompt("Text to find");
        if (find === null || find === "") return;
        const replacement = window.prompt("Replace with", "");
        if (replacement === null) return;
        editor.value = editor.value.split(find).join(replacement);
        updateLineNumbers();
        renderMarkdownPreview();
        editor.dispatchEvent(new Event("input"));
      });
      const copy = addButton("Copy");
      copy.addEventListener("click", async () => {
        const toPath = window.prompt("New path for the copy", `${artifact.path}.copy`);
        if (!toPath) return;
        try {
          const result = await api(`/api/projects/${encodeURIComponent(project.id)}/artifacts/duplicate`, {
            method: "POST",
            body: JSON.stringify({ fromPath: artifact.path, toPath })
          });
          await renderArtifactManager(project, container, result.artifact.path);
        } catch (error) {
          showError(error.message);
        }
      });
      const rename = addButton("Rename");
      rename.addEventListener("click", async () => {
        const toPath = window.prompt("New file path", artifact.path);
        if (!toPath || toPath === artifact.path) return;
        try {
          const result = await api(`/api/projects/${encodeURIComponent(project.id)}/artifacts/rename`, {
            method: "POST",
            body: JSON.stringify({
              kind: "file",
              fromPath: artifact.path,
              toPath,
              expectedVersion: artifact.version
            })
          });
          await renderArtifactManager(project, container, result.artifact.path);
        } catch (error) {
          showError(error.message);
        }
      });
      const remove = addButton("Delete file");
      remove.addEventListener("click", async () => {
        if (!window.confirm(`Delete ${artifact.path}? This cannot be undone.`)) return;
        try {
          await api(`/api/projects/${encodeURIComponent(project.id)}/artifacts/file?path=${encodeURIComponent(artifact.path)}&version=${artifact.version}`, {
            method: "DELETE"
          });
          await renderArtifactManager(project, container);
        } catch (error) {
          showError(error.message);
        }
      });
      controls.append(save, download, findReplace, copy, rename, remove);

      const history = await api(`/api/projects/${encodeURIComponent(project.id)}/artifacts/history?path=${encodeURIComponent(artifact.path)}`);
      const versionLabel = document.createElement("label");
      versionLabel.textContent = "Version history";
      versionLabel.htmlFor = `artifact-version-${project.id}`;
      const versions = document.createElement("select");
      versions.id = `artifact-version-${project.id}`;
      versions.className = "glass-select";
      history.history.forEach((version) => {
        const option = document.createElement("option");
        option.value = String(version.version);
        option.textContent = `Version ${version.version} · ${new Date(version.createdAt).toLocaleString()}`;
        versions.append(option);
      });
      versions.value = String(artifact.version);
      const restore = addButton("Restore selected version");
      restore.addEventListener("click", async () => {
        const version = Number(versions.value);
        if (version === artifact.version || !window.confirm(`Restore version ${version} as a new version?`)) return;
        try {
          const result = await api(`/api/projects/${encodeURIComponent(project.id)}/artifacts/restore`, {
            method: "POST",
            body: JSON.stringify({ path: artifact.path, version, expectedVersion: artifact.version })
          });
          await renderArtifactManager(project, container, result.artifact.path);
        } catch (error) {
          showError(error.message);
        }
      });
      editorPanel.append(fileTitle, state, editorShell, markdownPreview, livePreview, controls, versionLabel, versions, restore);
      columns.append(editorPanel);
    } else {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = tree.files.length ? "Choose a file to open and edit it." : "No files yet. Create a file to begin.";
      columns.append(empty);
    }

    container.append(toolbar, columns);
  } catch (error) {
    showError(error.message);
    container.replaceChildren();
  }
}

async function loadProjects() {
  const { projects } = await api("/api/projects");
  projectsList.replaceChildren();
  projectCount.textContent = `${projects.length} project${projects.length === 1 ? "" : "s"}`;
  if (projects.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Your project plans will appear here.";
    projectsList.append(empty);
    return;
  }
  projects.forEach(renderProject);
}

function renderGames(games) {
  gamesList.replaceChildren();
  gameCount.textContent = `${games.length} game${games.length === 1 ? "" : "s"}`;
  if (games.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Describe a game above to create your first private game project.";
    gamesList.append(empty);
    return;
  }
  games.forEach((game) => {
    const card = FlashGlowCard({ variant: "orange", className: "project-card" });
    const header = document.createElement("div");
    header.className = "project-card-header";
    const title = document.createElement("h3");
    title.textContent = game.title;
    header.append(title, makeTag(game.status));
    const metadata = document.createElement("p");
    metadata.className = "project-meta";
    metadata.textContent = `Version ${game.latestVersion} · Updated ${new Date(game.updatedAt).toLocaleString()}`;
    const open = document.createElement("button");
    open.className = "secondary-button";
    open.type = "button";
    open.textContent = "Open game";
    open.addEventListener("click", () => openGame(game.id));
    card.append(header, metadata, open);
    gamesList.append(card);
  });
}

async function loadGames() {
  const { games } = await api("/api/games");
  renderGames(games);
}

function renderGame(game) {
  activeGame = game;
  latestPreviewState = null;
  gameWorkspace.classList.remove("hidden");
  gameTitle.textContent = game.title;
  gameSummary.textContent = game.specification.summary;
  gameStatus.textContent = `${game.status.replaceAll("_", " ")} · Local deterministic template; not AI-generated or independently QA-verified.`;
  gameSpecification.replaceChildren();
  [
    `Engine: ${game.specification.engine}`,
    `Gameplay: ${game.specification.gameplayLoop}`,
    `Controls: ${game.specification.controls.keyboard}; ${game.specification.controls.touch}.`,
    `Camera: ${game.specification.camera}`,
    `Difficulty: ${game.specification.difficulty}`
  ].forEach((text) => {
    const item = document.createElement("li");
    item.textContent = text;
    gameSpecification.append(item);
  });
  gameLimitations.textContent = game.specification.unsupportedRequests.length
    ? `Not generated: ${game.specification.unsupportedRequests.join(", ")}.`
    : "This game is private and not published. Online services and generated media are unavailable.";

  gameVersion.replaceChildren();
  game.versions.forEach((version) => {
    const option = document.createElement("option");
    option.value = String(version.version);
    option.textContent = `Version ${version.version} · ${version.changeSummary}`;
    gameVersion.append(option);
  });
  gameVersion.value = String(game.latestVersion);
  gamePreview.src = `/api/games/${encodeURIComponent(game.id)}/preview?version=${game.latestVersion}`;
  restoreGameVersionButton.classList.add("hidden");
  gameSaveStatus.textContent = "";
  gameWorkspace.scrollIntoView({
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    block: "start"
  });
}

async function openGame(id) {
  clearError();
  try {
    const { game } = await api(`/api/games/${encodeURIComponent(id)}`);
    const { save } = await api(`/api/games/${encodeURIComponent(id)}/save`);
    currentGameSave = save;
    renderGame(game);
    gameSaveStatus.textContent = save ? `Saved ${new Date(save.updatedAt).toLocaleString()}.` : "No saved progress yet.";
  } catch (error) {
    showError(error.message);
  }
}

function postPreviewMessage(message) {
  gamePreview.contentWindow?.postMessage({ contract: "gods-game-v1", ...message }, "*");
}

function isValidPreviewState(state) {
  return state
    && Number.isFinite(state.x) && state.x >= 18 && state.x <= 782
    && Number.isFinite(state.y) && state.y >= 18 && state.y <= 432
    && Number.isInteger(state.score) && state.score >= 0 && state.score <= 1000000
    && Number.isFinite(state.orbX) && state.orbX >= 12 && state.orbX <= 788
    && Number.isFinite(state.orbY) && state.orbY >= 12 && state.orbY <= 438;
}

async function saveGameProgress(state) {
  if (!activeGame || !isValidPreviewState(state)) throw new Error("Wait for the game preview to finish loading.");
  const { save } = await api(`/api/games/${encodeURIComponent(activeGame.id)}/save`, {
    method: "POST",
    body: JSON.stringify({ state })
  });
  currentGameSave = save;
  gameSaveStatus.textContent = `Progress saved ${new Date(save.updatedAt).toLocaleTimeString()}.`;
}

window.addEventListener("message", (event) => {
  if (event.source !== gamePreview.contentWindow
    || !event.data
    || event.data.contract !== "gods-game-v1"
    || event.data.type !== "game-state"
    || !isValidPreviewState(event.data.state)) return;
  latestPreviewState = event.data.state;
});

gamePreview.addEventListener("load", () => {
  if (currentGameSave?.state) postPreviewMessage({ type: "load-state", state: currentGameSave.state });
});

gameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError();
  const button = gameForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const { game, limitations } = await api("/api/games", {
      method: "POST",
      body: JSON.stringify({ prompt: gamePromptInput.value })
    });
    currentGameSave = null;
    renderGame(game);
    await loadGames();
    liveRegion.textContent = `${game.title} created as a private playable game.`;
    if (limitations.length) gameLimitations.textContent = `Not generated: ${limitations.join(", ")}.`;
  } catch (error) {
    showError(error.message);
  } finally {
    button.disabled = false;
  }
});

gameRefineForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!activeGame) return;
  clearError();
  const button = gameRefineForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const { game, changeSummary } = await api(`/api/games/${encodeURIComponent(activeGame.id)}/refine`, {
      method: "POST",
      body: JSON.stringify({ instruction: gameRefinementInput.value })
    });
    currentGameSave = await api(`/api/games/${encodeURIComponent(game.id)}/save`).then((result) => result.save);
    renderGame(game);
    await loadGames();
    gameSaveStatus.textContent = `${changeSummary} A new version was saved.`;
    gameRefinementInput.value = "";
  } catch (error) {
    showError(error.message);
  } finally {
    button.disabled = false;
  }
});

gameVersion.addEventListener("change", () => {
  if (!activeGame) return;
  const selectedVersion = Number(gameVersion.value);
  const version = activeGame.versions.find((item) => item.version === selectedVersion);
  if (!version) return;
  gamePreview.src = `/api/games/${encodeURIComponent(activeGame.id)}/preview?version=${selectedVersion}`;
  restoreGameVersionButton.classList.toggle("hidden", selectedVersion === activeGame.latestVersion);
});

restartGameButton.addEventListener("click", () => postPreviewMessage({ type: "restart" }));

saveGameButton.addEventListener("click", async () => {
  try {
    await saveGameProgress(latestPreviewState);
  } catch (error) {
    showError(error.message);
  }
});

loadGameSaveButton.addEventListener("click", async () => {
  if (!activeGame) return;
  try {
    const { save } = await api(`/api/games/${encodeURIComponent(activeGame.id)}/save`);
    if (!save) {
      gameSaveStatus.textContent = "No saved progress yet.";
      return;
    }
    currentGameSave = save;
    latestPreviewState = save.state;
    postPreviewMessage({ type: "load-state", state: save.state });
    gameSaveStatus.textContent = `Loaded progress saved ${new Date(save.updatedAt).toLocaleString()}.`;
  } catch (error) {
    showError(error.message);
  }
});

restoreGameVersionButton.addEventListener("click", async () => {
  if (!activeGame) return;
  const selectedVersion = Number(gameVersion.value);
  try {
    const { game } = await api(`/api/games/${encodeURIComponent(activeGame.id)}/rollback`, {
      method: "POST",
      body: JSON.stringify({ version: selectedVersion })
    });
    renderGame(game);
    await loadGames();
    gameSaveStatus.textContent = `Restored version ${selectedVersion} as version ${game.latestVersion}.`;
  } catch (error) {
    showError(error.message);
  }
});

function showWorkspace(user) {
  authSection.classList.add("hidden");
  appWorkspace.classList.remove("hidden");
  signoutButton.classList.remove("hidden");
  healthLabel.textContent = `Signed in · ${user.email}`;
  clearError();
  Promise.all([loadProjects(), loadGames()]).catch((error) => showError(error.message));
}

async function submitCredentials(event, endpoint) {
  event.preventDefault();
  clearError();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const data = new FormData(form);
  button.disabled = true;
  try {
    const result = await api(endpoint, {
      method: "POST",
      body: JSON.stringify({
        email: data.get("email"),
        password: data.get("password")
      })
    });
    form.reset();
    showWorkspace(result.user);
    liveRegion.textContent = `Signed in as ${result.user.email}.`;
  } catch (error) {
    showError(error.message);
  } finally {
    button.disabled = false;
  }
}

loginForm.addEventListener("submit", (event) => submitCredentials(event, "/api/auth/login"));
registerForm.addEventListener("submit", (event) => submitCredentials(event, "/api/auth/register"));

signoutButton.addEventListener("click", async () => {
  signoutButton.disabled = true;
  try {
    await api("/api/auth/logout", { method: "POST", body: JSON.stringify({}) });
    draftProject = null;
    activeGame = null;
    currentGameSave = null;
    latestPreviewState = null;
    promptInput.value = "";
    gamePromptInput.value = "";
    requirementList.replaceChildren();
    reviewSection.classList.add("hidden");
    appWorkspace.classList.add("hidden");
    authSection.classList.remove("hidden");
    signoutButton.classList.add("hidden");
    projectsList.replaceChildren();
    gamesList.replaceChildren();
    gameWorkspace.classList.add("hidden");
    gamePreview.removeAttribute("src");
    projectCount.textContent = "0 projects";
    gameCount.textContent = "0 games";
    healthLabel.textContent = "Local workspace · Sign in required";
    clearError();
    liveRegion.textContent = "You have signed out.";
  } catch (error) {
    showError(error.message);
  } finally {
    signoutButton.disabled = false;
  }
});

promptForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError();
  const button = promptForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const { project } = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({ prompt: promptInput.value })
    });
    draftProject = project;
    renderRequirements(project);
    await loadProjects();
    liveRegion.textContent = `${project.requirements.length} requirements are ready to review.`;
  } catch (error) {
    showError(error.message);
  } finally {
    button.disabled = false;
  }
});

approveButton.addEventListener("click", async () => {
  if (!draftProject) return;
  clearError();
  approveButton.disabled = true;
  const items = [...requirementList.querySelectorAll(".requirement-item")];
  const decisions = items.map((item, index) => ({
    id: draftProject.requirements[index].id,
    text: item.querySelector("textarea").value,
    approved: item.querySelector('input[type="checkbox"]').checked
  }));
  try {
    const { project } = await api(`/api/projects/${encodeURIComponent(draftProject.id)}/approve`, {
      method: "POST",
      body: JSON.stringify({ decisions })
    });
    draftProject = null;
    reviewSection.classList.add("hidden");
    await loadProjects();
    liveRegion.textContent = `${project.title} plan approved. Build tasks are blocked because no AI provider is configured.`;
  } catch (error) {
    showError(error.message);
  } finally {
    approveButton.disabled = false;
  }
});

async function initialize() {
  try {
    const health = await api("/api/health");
    if (typeof health.version === "string") appVersion.textContent = `V${health.version}`;
    healthLabel.textContent = `Local workspace · AI providers ${health.aiProviders.toLowerCase()}`;
    try {
      const { user } = await api("/api/auth/me");
      showWorkspace(user);
    } catch (error) {
      if (!error.message.includes("Sign in")) throw error;
      healthLabel.textContent = "Local workspace · Sign in required";
    }
  } catch (error) {
    healthLabel.textContent = "Workspace unavailable";
    showError(error.message);
  }
}

initialize();
