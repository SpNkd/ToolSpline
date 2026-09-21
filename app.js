const PAGE_SIZE = 10;

const VALID_STATUSES = new Set([
  "ok",
  "stale",
  "unknown",
  "invalid_url",
  "removed",
  "private",
]);

const VALID_SORTS = new Set([
  "stars-desc",
  "stars-asc",
  "forks-desc",
  "forks-asc",
  "name-asc",
  "metricsUpdatedAt-desc",
]);

const STATUS_LABELS = {
  ok: "ok",
  stale: "stale",
  unknown: "unknown",
  invalid_url: "invalid_url",
  removed: "removed",
  private: "private",
};

const elements = {
  form: document.querySelector("#filters-form"),
  search: document.querySelector("#search-input"),
  minStars: document.querySelector("#min-stars-input"),
  minForks: document.querySelector("#min-forks-input"),
  sort: document.querySelector("#sort-select"),
  clear: document.querySelector("#clear-filters"),
  loadStatus: document.querySelector("#load-status"),
  resultCount: document.querySelector("#result-count"),
  results: document.querySelector("#results"),
  pagination: document.querySelector("#pagination"),
  paginationControls: document.querySelector("#pagination-controls"),
};

const state = {
  query: "",
  minStars: null,
  minForks: null,
  sort: "stars-desc",
  page: 1,
};

let tools = [];
let loadError = null;
let loadWarnings = [];
let isLoading = true;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  readUrlState();
  syncControls();
  bindEvents();
  render();

  try {
    const response = await fetch("tools.json", {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    const normalized = normalizeTools(payload);
    tools = normalized.tools;
    loadWarnings = normalized.warnings;
    loadError = null;
    isLoading = false;
    setLoadStatus();
  } catch (error) {
    tools = [];
    loadError = error;
    loadWarnings = [];
    isLoading = false;
    setLoadStatus();
  }

  render();
}

function bindEvents() {
  elements.form.addEventListener("submit", (event) => event.preventDefault());

  elements.search.addEventListener("input", () => {
    state.query = elements.search.value.trim();
    resetPageAndRender();
  });

  elements.minStars.addEventListener("input", () => {
    state.minStars = parseIntegerInput(elements.minStars.value);
    resetPageAndRender();
  });

  elements.minForks.addEventListener("input", () => {
    state.minForks = parseIntegerInput(elements.minForks.value);
    resetPageAndRender();
  });

  elements.sort.addEventListener("change", () => {
    state.sort = VALID_SORTS.has(elements.sort.value) ? elements.sort.value : "stars-desc";
    resetPageAndRender();
  });

  elements.clear.addEventListener("click", () => {
    state.query = "";
    state.minStars = null;
    state.minForks = null;
    state.sort = "stars-desc";
    state.page = 1;
    syncControls();
    updateUrlState();
    render();
    elements.search.focus();
  });
}

function normalizeTools(payload) {
  if (!Array.isArray(payload)) {
    throw new Error("tools.json должен содержать JSON-массив");
  }

  const warnings = [];
  const seenSlugs = new Set();
  const normalizedTools = [];

  payload.forEach((rawTool, index) => {
    if (!rawTool || typeof rawTool !== "object" || Array.isArray(rawTool)) {
      warnings.push(`Запись ${index + 1} пропущена: ожидался объект.`);
      return;
    }

    const slug = readText(rawTool.slug).trim();
    if (!slug) {
      warnings.push(`Запись ${index + 1} пропущена: отсутствует slug.`);
      return;
    }

    if (seenSlugs.has(slug)) {
      warnings.push(`Дубликат slug «${slug}» пропущен; используется первая запись.`);
      return;
    }
    seenSlugs.add(slug);

    const rawUseCases = rawTool.useCases;
    if (!Array.isArray(rawUseCases)) {
      warnings.push(`«${slug}»: useCases отсутствует или не является массивом; использован пустой список.`);
    }

    const url = readText(rawTool.url).trim();
    const validUrl = isSafeHttpUrl(url);
    const rawStatus = readText(rawTool.status);
    const status = !validUrl ? "invalid_url" : VALID_STATUSES.has(rawStatus) ? rawStatus : "unknown";

    normalizedTools.push({
      slug,
      name: readText(rawTool.name).trim() || slug,
      description: readText(rawTool.description).trim() || "Описание отсутствует.",
      url,
      safeUrl: validUrl ? url : null,
      useCases: normalizeStringArray(rawUseCases),
      stars: normalizeMetric(rawTool.stars),
      forks: normalizeMetric(rawTool.forks),
      downloads: normalizeMetric(rawTool.downloads),
      views: normalizeMetric(rawTool.views),
      comments: normalizeMetric(rawTool.comments),
      metricsUpdatedAt: normalizeDate(rawTool.metricsUpdatedAt),
      status,
      tags: normalizeStringArray(rawTool.tags),
      language: readText(rawTool.language).trim(),
      license: readText(rawTool.license).trim(),
      notes: readText(rawTool.notes).trim(),
    });
  });

  return { tools: normalizedTools, warnings };
}

function readText(value) {
  return typeof value === "string" ? value : "";
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function normalizeMetric(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  return value;
}

function normalizeDate(value) {
  if (typeof value !== "string" || !value.trim() || Number.isNaN(Date.parse(value))) {
    return null;
  }
  return value;
}

function isSafeHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function parseIntegerInput(value) {
  if (value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeSearch(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function getFilteredTools() {
  const query = normalizeSearch(state.query);

  return tools
    .filter((tool) => {
      const haystack = normalizeSearch([
        tool.name,
        tool.description,
        ...tool.useCases,
      ].join(" "));

      const matchesQuery = !query || haystack.includes(query);
      const matchesStars = state.minStars === null
        || (tool.stars !== null && tool.stars >= state.minStars);
      const matchesForks = state.minForks === null
        || (tool.forks !== null && tool.forks >= state.minForks);

      return matchesQuery && matchesStars && matchesForks;
    })
    .sort(compareTools);
}

function compareTools(left, right) {
  let result = 0;

  switch (state.sort) {
    case "stars-asc":
      result = compareNullableNumber(left.stars, right.stars, false);
      break;
    case "forks-desc":
      result = compareNullableNumber(left.forks, right.forks, true);
      break;
    case "forks-asc":
      result = compareNullableNumber(left.forks, right.forks, false);
      break;
    case "name-asc":
      result = left.name.localeCompare(right.name, "ru", { sensitivity: "base" });
      break;
    case "metricsUpdatedAt-desc":
      result = compareNullableNumber(dateValue(left.metricsUpdatedAt), dateValue(right.metricsUpdatedAt), true);
      break;
    case "stars-desc":
    default:
      result = compareNullableNumber(left.stars, right.stars, true);
      break;
  }

  if (result !== 0) {
    return result;
  }

  const nameResult = left.name.localeCompare(right.name, "ru", { sensitivity: "base" });
  return nameResult || left.slug.localeCompare(right.slug, "en");
}

function compareNullableNumber(left, right, descending) {
  const leftMissing = left === null || left === undefined || Number.isNaN(left);
  const rightMissing = right === null || right === undefined || Number.isNaN(right);

  if (leftMissing && rightMissing) return 0;
  if (leftMissing) return 1;
  if (rightMissing) return -1;

  return descending ? right - left : left - right;
}

function dateValue(value) {
  return value ? Date.parse(value) : null;
}

function render() {
  const filteredTools = getFilteredTools();
  const pageCount = Math.max(1, Math.ceil(filteredTools.length / PAGE_SIZE));
  state.page = Math.min(Math.max(state.page, 1), pageCount);
  const start = (state.page - 1) * PAGE_SIZE;
  const pageTools = filteredTools.slice(start, start + PAGE_SIZE);

  elements.results.replaceChildren();
  elements.results.setAttribute("aria-busy", String(isLoading));

  if (isLoading) {
    elements.results.append(createEmptyState("Загрузка каталога…"));
  } else if (loadError) {
    elements.results.append(createEmptyState("Каталог недоступен. Проверьте tools.json и обновите страницу."));
  } else if (pageTools.length === 0) {
    elements.results.append(createEmptyState("Ничего не найдено. Измените запрос или сбросьте фильтры."));
  } else {
    pageTools.forEach((tool) => elements.results.append(createToolCard(tool)));
  }

  elements.resultCount.textContent = isLoading || loadError
    ? ""
    : `${filteredTools.length} ${pluralize(filteredTools.length, "инструмент", "инструмента", "инструментов")}`;

  renderPagination(filteredTools.length, pageCount);
  updateUrlState();
}

function createEmptyState(message) {
  const element = document.createElement("p");
  element.className = "empty-state";
  element.textContent = message;
  return element;
}

function createToolCard(tool) {
  const card = document.createElement("article");
  card.className = "tool-card";

  const heading = document.createElement("div");
  heading.className = "tool-card__heading";
  const title = document.createElement("h3");

  if (tool.safeUrl) {
    const link = document.createElement("a");
    link.href = tool.safeUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = tool.name;
    title.append(link);
  } else {
    title.textContent = tool.name;
  }

  heading.append(title, createStatusBadge(tool.status));
  card.append(heading);

  const description = document.createElement("p");
  description.className = "tool-card__description";
  description.textContent = tool.description;
  card.append(description);

  if (tool.tags.length > 0) {
    card.append(createTextList(tool.tags, "tag-list", "Теги"));
  }

  if (tool.useCases.length > 0) {
    card.append(createTextList(tool.useCases, "use-case-list", "Сценарии использования"));
  }

  if (tool.notes) {
    const notes = document.createElement("p");
    notes.className = "tool-card__notes";
    notes.textContent = tool.notes;
    card.append(notes);
  }

  const stats = document.createElement("dl");
  stats.className = "tool-card__stats";
  stats.append(
    createStat("Звёзды", tool.stars),
    createStat("Форки", tool.forks),
    createStat("Скачивания", tool.downloads),
    createStat("Просмотры", tool.views),
    createStat("Комментарии", tool.comments),
  );
  card.append(stats);

  const meta = document.createElement("div");
  meta.className = "tool-card__meta";
  const language = tool.language || "Язык не указан";
  const license = tool.license || "Лицензия не указана";
  const updated = tool.metricsUpdatedAt ? `Метрики: ${formatDate(tool.metricsUpdatedAt)}` : "Дата метрик не указана";
  meta.append(createTextSpan(`${language} · ${license}`), createTextSpan(updated));
  card.append(meta);

  return card;
}

function createStatusBadge(status) {
  const badge = document.createElement("span");
  badge.className = `status-badge status-badge--${status}`;
  badge.textContent = STATUS_LABELS[status] || "unknown";
  badge.setAttribute("aria-label", `Статус: ${badge.textContent}`);
  return badge;
}

function createTextList(items, className, label) {
  const list = document.createElement("ul");
  list.className = className;
  list.setAttribute("aria-label", label);
  items.forEach((item) => {
    const listItem = document.createElement("li");
    listItem.textContent = item;
    list.append(listItem);
  });
  return list;
}

function createStat(label, value) {
  const wrapper = document.createElement("div");
  wrapper.className = "stat";
  const term = document.createElement("dt");
  term.textContent = label;
  const description = document.createElement("dd");
  description.textContent = value === null || value === undefined ? "—" : formatNumber(value);
  wrapper.append(term, description);
  return wrapper;
}

function createTextSpan(value) {
  const span = document.createElement("span");
  span.textContent = value;
  return span;
}

function renderPagination(resultCount, pageCount) {
  elements.paginationControls.replaceChildren();
  elements.pagination.hidden = resultCount === 0 || pageCount <= 1;
  if (elements.pagination.hidden) {
    return;
  }

  elements.paginationControls.append(createPageButton("←", "Предыдущая страница", state.page - 1, state.page === 1));

  for (let page = 1; page <= pageCount; page += 1) {
    const button = createPageButton(String(page), `Страница ${page}`, page, false);
    if (page === state.page) {
      button.setAttribute("aria-current", "page");
    }
    elements.paginationControls.append(button);
  }

  elements.paginationControls.append(createPageButton("→", "Следующая страница", state.page + 1, state.page === pageCount));

  const summary = document.createElement("span");
  summary.className = "pagination__summary";
  summary.textContent = `Страница ${state.page} из ${pageCount}`;
  elements.paginationControls.append(summary);
}

function createPageButton(label, ariaLabel, page, disabled) {
  const button = document.createElement("button");
  button.className = "pagination__button";
  button.type = "button";
  button.textContent = label;
  button.setAttribute("aria-label", ariaLabel);
  button.disabled = disabled;
  button.addEventListener("click", () => {
    state.page = page;
    updateUrlState();
    render();
    document.querySelector("#results-title").focus({ preventScroll: true });
  });
  return button;
}

function syncControls() {
  elements.search.value = state.query;
  elements.minStars.value = state.minStars === null ? "" : String(state.minStars);
  elements.minForks.value = state.minForks === null ? "" : String(state.minForks);
  elements.sort.value = state.sort;
}

function readUrlState() {
  const params = new URLSearchParams(window.location.search);
  state.query = params.get("q")?.trim() || "";
  state.minStars = parseIntegerInput(params.get("minStars") || "");
  state.minForks = parseIntegerInput(params.get("minForks") || "");
  state.sort = VALID_SORTS.has(params.get("sort")) ? params.get("sort") : "stars-desc";
  const page = parseIntegerInput(params.get("page") || "1");
  state.page = page && page > 0 ? page : 1;
}

function updateUrlState() {
  const url = new URL(window.location.href);
  url.search = "";
  const params = new URLSearchParams();

  if (state.query) params.set("q", state.query);
  if (state.minStars !== null) params.set("minStars", String(state.minStars));
  if (state.minForks !== null) params.set("minForks", String(state.minForks));
  if (state.sort !== "stars-desc") params.set("sort", state.sort);
  if (state.page > 1) params.set("page", String(state.page));

  const query = params.toString();
  window.history.replaceState(null, "", query ? `${url.pathname}?${query}${url.hash}` : `${url.pathname}${url.hash}`);
}

function resetPageAndRender() {
  state.page = 1;
  updateUrlState();
  render();
}

function setLoadStatus() {
  elements.loadStatus.removeAttribute("data-tone");

  if (loadError) {
    elements.loadStatus.dataset.tone = "error";
    elements.loadStatus.textContent = `Не удалось загрузить каталог: ${loadError.message || "неизвестная ошибка"}`;
    return;
  }

  if (loadWarnings.length > 0) {
    elements.loadStatus.dataset.tone = "warning";
    elements.loadStatus.textContent = `Загружено ${tools.length}; предупреждений: ${loadWarnings.length}. ${loadWarnings[0]}`;
    return;
  }

  elements.loadStatus.textContent = `Загружено инструментов: ${tools.length}.`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("ru-RU").format(value);
}

function formatDate(value) {
  return new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium" }).format(new Date(value));
}

function pluralize(value, one, few, many) {
  const mod10 = value % 10;
  const mod100 = value % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}
