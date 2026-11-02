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
    const item = document.createElement("article");
    item.className = "requirement-item";

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
  tag.textContent = text.replaceAll("_", " ");
  return tag;
}

function renderProject(project) {
  const card = document.createElement("article");
  card.className = "project-card";

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
  projectsList.append(card);
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
    const card = document.createElement("article");
    card.className = "project-card";
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
