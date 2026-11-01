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

let draftProject = null;

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
  reviewSection.scrollIntoView({ behavior: "smooth", block: "start" });
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
  metadata.textContent = `${project.requirements.length} draft requirement${project.requirements.length === 1 ? "" : "s"} · Created ${new Date(project.createdAt).toLocaleString()}`;
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
    await loadProjects();
  } catch (error) {
    healthLabel.textContent = "Workspace unavailable";
    showError(error.message);
  }
}

initialize();
