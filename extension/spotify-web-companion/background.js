import {
  addQueueItems,
  appendHistory,
  clearHistory,
  getState,
  initializeState,
  mutateState,
  updateSettings
} from "./utils/storage.js";
import { cancelJob, readJob, submitDownload } from "./utils/api.js";
import {
  isSpotifyTrackUrl,
  normalizeBackendJob,
  normalizeSettings,
  safeFilename,
  spotifyTrackUrl
} from "./utils/validators.js";

const PROCESS_ALARM = "download-killer-process-queue";
const RECOVERY_DELAY_MINUTES = 0.5;
const QUICK_POLL_MS = 4500;
let stepRunning = false;
let quickTimer = null;

chrome.runtime.onInstalled.addListener(() => {
  void initializeState().then(() => scheduleProcess(250));
});

chrome.runtime.onStartup.addListener(() => {
  void initializeState().then(() => scheduleProcess(250));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PROCESS_ALARM) void processQueueStep();
});

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  const action = String(request?.action || "");

  if (action === "enqueueTrack") {
    void enqueueTracks([request.track], request.settings)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (action === "enqueuePlaylist") {
    void enqueueTracks(request.tracks, request.settings)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (action === "getState") {
    void getState()
      .then((state) => sendResponse({ ok: true, state }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (action === "updateSettings") {
    void updateSettings(request.settings || {})
      .then((state) => {
        sendResponse({ ok: true, settings: state.settings });
        scheduleProcess(100);
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (action === "clearHistory") {
    void clearHistory()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (action === "cancelAll") {
    void cancelAll()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (action === "processNow") {
    scheduleProcess(0);
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

async function enqueueTracks(rawTracks, settingsOverride = {}) {
  const state = await getState();
  const settings = normalizeSettings({ ...state.settings, ...settingsOverride });
  const source = Array.isArray(rawTracks) ? rawTracks : [];
  const now = Date.now();
  const seen = new Set();
  const tasks = [];

  for (const raw of source.slice(0, 200)) {
    const url = spotifyTrackUrl(raw?.url || raw?.uri || raw);
    if (!url || !isSpotifyTrackUrl(url) || seen.has(url)) continue;
    seen.add(url);
    tasks.push({
      localId: crypto.randomUUID(),
      url,
      title: String(raw?.title || "Spotify track").slice(0, 240),
      artist: String(raw?.artist || "Unknown artist").slice(0, 240),
      format: settings.format,
      quality: settings.quality,
      backendUrl: settings.backendUrl,
      status: "queued",
      jobId: "",
      downloadUrl: "",
      filename: "",
      downloadId: null,
      error: "",
      attempts: 0,
      createdAt: now,
      updatedAt: now
    });
  }

  if (!tasks.length) throw new Error("Няма валидни Spotify track URL адреси");
  const next = await addQueueItems(tasks);
  await updateSettings(settings);
  broadcastState(next, `Добавени задачи: ${tasks.length}`);
  scheduleProcess(100);
  return { ok: true, added: tasks.length };
}

async function processQueueStep() {
  if (stepRunning) return;
  stepRunning = true;

  try {
    const state = await getState();
    const task = state.queue.find((item) =>
      ["queued", "submitting", "processing"].includes(String(item.status))
    );

    if (!task) {
      await chrome.alarms.clear(PROCESS_ALARM);
      broadcastState(state, "Опашката е празна");
      return;
    }

    if (task.status === "queued" || task.status === "submitting") {
      await updateTask(task.localId, {
        status: "submitting",
        updatedAt: Date.now(),
        error: ""
      });

      try {
        const job = await submitDownload(task.backendUrl, task);
        await updateTask(task.localId, {
          status: normalizeRemoteStatus(job.status),
          jobId: job.id,
          title: job.title || task.title,
          artist: job.artist || task.artist,
          downloadUrl: job.downloadUrl || "",
          filename: job.filename || "",
          attempts: 0,
          updatedAt: Date.now()
        });
        broadcastLatest(`Изпратено: ${job.title || task.title}`);
        scheduleProcess(QUICK_POLL_MS);
      } catch (error) {
        await failOrRetry(task, error);
      }
      return;
    }

    if (task.status === "processing") {
      try {
        const job = await readJob(task.backendUrl, task.jobId, task);
        const status = normalizeRemoteStatus(job.status);

        if (status === "done") {
          await finishTask(task, job);
          scheduleProcess(250);
          return;
        }

        if (status === "failed") {
          await markTaskFailed(task, job.error || "Backend job failed");
          scheduleProcess(250);
          return;
        }

        await updateTask(task.localId, {
          status: "processing",
          title: job.title || task.title,
          artist: job.artist || task.artist,
          downloadUrl: job.downloadUrl || task.downloadUrl,
          filename: job.filename || task.filename,
          attempts: Number(task.attempts || 0) + 1,
          updatedAt: Date.now()
        });
        broadcastLatest(`Обработва се: ${job.title || task.title}`);
        scheduleProcess(QUICK_POLL_MS);
      } catch (error) {
        await failOrRetry(task, error);
      }
    }
  } finally {
    stepRunning = false;
  }
}

function normalizeRemoteStatus(value) {
  const status = String(value || "queued").toLowerCase();
  if (["done", "complete", "completed", "success", "succeeded"].includes(status)) return "done";
  if (["failed", "error", "cancelled", "canceled"].includes(status)) return "failed";
  return "processing";
}

async function failOrRetry(task, error) {
  const attempts = Number(task.attempts || 0) + 1;
  if (attempts >= 8) {
    await markTaskFailed(task, error?.message || String(error));
    scheduleProcess(250);
    return;
  }
  await updateTask(task.localId, {
    status: task.jobId ? "processing" : "queued",
    attempts,
    error: String(error?.message || error).slice(0, 500),
    updatedAt: Date.now()
  });
  broadcastLatest(`Временна грешка, опит ${attempts}/8`);
  scheduleProcess(Math.min(30000, QUICK_POLL_MS * attempts));
}

async function finishTask(task, job) {
  const state = await getState();
  const settings = normalizeSettings(state.settings);
  const downloadUrl = job.downloadUrl || task.downloadUrl;
  let downloadId = null;
  let downloadError = "";

  if (settings.autoDownload && downloadUrl) {
    try {
      const suggested = job.filename ||
        `${job.artist || task.artist} - ${job.title || task.title}`;
      downloadId = await chrome.downloads.download({
        url: downloadUrl,
        filename: safeFilename(suggested, job.format || task.format),
        saveAs: settings.saveAs,
        conflictAction: "uniquify"
      });
    } catch (error) {
      downloadError = `Автоматичното изтегляне не стартира: ${error.message || error}`;
    }
  }

  const completed = {
    ...task,
    ...normalizeBackendJob(job, task),
    status: "done",
    downloadUrl,
    downloadId,
    error: downloadError,
    updatedAt: Date.now()
  };
  await updateTask(task.localId, completed);
  await appendHistory(completed);
  broadcastLatest(`Готово: ${completed.title}`);
}

async function markTaskFailed(task, message) {
  const failed = {
    ...task,
    status: "failed",
    error: String(message || "Unknown error").slice(0, 500),
    updatedAt: Date.now()
  };
  await updateTask(task.localId, failed);
  await appendHistory(failed);
  broadcastLatest(`Грешка: ${failed.title}`);
}

async function updateTask(localId, patch) {
  return mutateState((state) => ({
    ...state,
    queue: state.queue.map((item) =>
      item.localId === localId ? { ...item, ...patch } : item
    )
  }));
}

async function cancelAll() {
  const state = await getState();
  const active = state.queue.filter((item) =>
    ["queued", "submitting", "processing"].includes(item.status)
  );

  await Promise.allSettled(
    active
      .filter((item) => item.jobId)
      .map((item) => cancelJob(item.backendUrl, item.jobId))
  );

  const next = await mutateState((current) => ({
    ...current,
    queue: current.queue.map((item) =>
      ["queued", "submitting", "processing"].includes(item.status)
        ? { ...item, status: "cancelled", updatedAt: Date.now() }
        : item
    )
  }));
  await chrome.alarms.clear(PROCESS_ALARM);
  if (quickTimer) clearTimeout(quickTimer);
  broadcastState(next, "Всички локални задачи са спрени");
}

function scheduleProcess(delayMs = QUICK_POLL_MS) {
  if (quickTimer) clearTimeout(quickTimer);
  quickTimer = setTimeout(() => void processQueueStep(), Math.max(0, delayMs));
  void chrome.alarms.create(PROCESS_ALARM, { delayInMinutes: RECOVERY_DELAY_MINUTES });
}

async function broadcastLatest(message) {
  const state = await getState();
  broadcastState(state, message);
}

function broadcastState(state, message) {
  void chrome.runtime.sendMessage({
    action: "stateUpdate",
    message,
    state
  }).catch(() => undefined);
}
