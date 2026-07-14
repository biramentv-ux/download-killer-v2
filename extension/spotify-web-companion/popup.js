import { normalizeSettings } from "./utils/validators.js";

const $ = (selector) => document.querySelector(selector);
let currentState = null;

document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.action === "stateUpdate") {
      currentState = message.state;
      renderState(currentState);
      setStatus(message.message || "Обновено", "working");
    }
  });
  await refreshState();
});

function bindEvents() {
  ["backendUrl", "format", "quality", "autoDownload", "saveAs"].forEach((id) => {
    $(`#${id}`).addEventListener("change", saveSettings);
  });

  $("#downloadCurrent").addEventListener("click", enqueueCurrent);
  $("#downloadPlaylist").addEventListener("click", enqueuePlaylist);
  $("#cancelAll").addEventListener("click", async () => {
    setStatus("Спиране…", "working");
    const response = await sendRuntime({ action: "cancelAll" });
    setStatus(response.ok ? "Локалната опашка е спряна" : response.error, response.ok ? "idle" : "error");
    await refreshState();
  });
  $("#clearHistory").addEventListener("click", async () => {
    await sendRuntime({ action: "clearHistory" });
    await refreshState();
  });
  $("#refresh").addEventListener("click", refreshState);
  $("#openSite").addEventListener("click", () => {
    const base = normalizeSettings(readSettings()).backendUrl;
    chrome.tabs.create({ url: base });
  });
}

async function enqueueCurrent() {
  setStatus("Четене на текущата песен…", "working");
  const response = await sendToActiveTab({ action: "getCurrentTrack" });
  const track = response?.track;
  if (!track?.url) {
    setStatus("Не е открита текуща песен", "error");
    return;
  }
  const result = await sendRuntime({
    action: "enqueueTrack",
    track,
    settings: readSettings()
  });
  setStatus(result.ok ? `Добавено: ${track.title}` : result.error, result.ok ? "working" : "error");
  await refreshState();
}

async function enqueuePlaylist() {
  setStatus("Четене на видимите песни…", "working");
  const response = await sendToActiveTab({ action: "getPlaylistTracks" });
  const tracks = Array.isArray(response?.tracks) ? response.tracks : [];
  if (!tracks.length) {
    setStatus("Не са открити видими песни", "error");
    return;
  }
  const result = await sendRuntime({
    action: "enqueuePlaylist",
    tracks,
    settings: readSettings()
  });
  setStatus(result.ok ? `Добавени: ${result.added}` : result.error, result.ok ? "working" : "error");
  await refreshState();
}

async function saveSettings() {
  const settings = normalizeSettings(readSettings());
  const response = await sendRuntime({ action: "updateSettings", settings });
  if (!response.ok) setStatus(response.error, "error");
}

function readSettings() {
  return {
    backendUrl: $("#backendUrl").value,
    format: $("#format").value,
    quality: $("#quality").value,
    autoDownload: $("#autoDownload").checked,
    saveAs: $("#saveAs").checked
  };
}

async function refreshState() {
  const response = await sendRuntime({ action: "getState" });
  if (!response.ok) {
    setStatus(response.error || "Неуспешно зареждане", "error");
    return;
  }
  currentState = response.state;
  renderState(currentState);
  const active = currentState.queue.filter((item) =>
    ["queued", "submitting", "processing"].includes(item.status)
  ).length;
  setStatus(active ? `Активни задачи: ${active}` : "Готов", active ? "working" : "idle");
}

function renderState(state) {
  const settings = normalizeSettings(state.settings || {});
  $("#backendUrl").value = settings.backendUrl;
  $("#format").value = settings.format;
  $("#quality").value = settings.quality;
  $("#autoDownload").checked = settings.autoDownload;
  $("#saveAs").checked = settings.saveAs;

  renderList($("#queueList"), state.queue.slice().reverse().slice(0, 30), false);
  renderList($("#historyList"), state.history.slice(0, 20), true);
}

function renderList(container, items, historyMode) {
  container.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = historyMode ? "Няма история" : "Няма задачи";
    container.appendChild(empty);
    return;
  }

  for (const item of items) {
    const row = document.createElement("article");
    row.className = `list-item ${String(item.status || "queued")}`;

    const copy = document.createElement("div");
    copy.className = "item-copy";
    const title = document.createElement("strong");
    title.textContent = item.title || "Spotify track";
    const meta = document.createElement("span");
    meta.textContent = `${item.artist || "Unknown artist"} · ${String(item.format || "").toUpperCase()} ${item.quality || ""}`;
    const status = document.createElement("small");
    status.textContent = item.error ? `${item.status}: ${item.error}` : String(item.status || "queued");
    copy.append(title, meta, status);

    row.appendChild(copy);
    if (item.status === "done" && item.downloadUrl) {
      const link = document.createElement("a");
      link.href = item.downloadUrl;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = "Файл";
      row.appendChild(link);
    }
    container.appendChild(row);
  }
}

function setStatus(message, state) {
  $("#statusText").textContent = String(message || "");
  $("#status").dataset.state = state;
}

async function sendRuntime(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

async function sendToActiveTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    return null;
  }
}
