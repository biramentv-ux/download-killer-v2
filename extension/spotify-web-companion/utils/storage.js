import { normalizeSettings } from "./validators.js";

const STATE_KEY = "downloadKillerCompanionState";
const MAX_HISTORY = 100;

const DEFAULT_STATE = Object.freeze({
  schemaVersion: 1,
  settings: normalizeSettings({}),
  queue: [],
  history: [],
  updatedAt: 0
});

let mutationChain = Promise.resolve();

function cloneDefaultState() {
  return {
    schemaVersion: DEFAULT_STATE.schemaVersion,
    settings: { ...DEFAULT_STATE.settings },
    queue: [],
    history: [],
    updatedAt: Date.now()
  };
}

function normalizeState(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    schemaVersion: 1,
    settings: normalizeSettings(source.settings || {}),
    queue: Array.isArray(source.queue) ? source.queue.slice(0, 250) : [],
    history: Array.isArray(source.history) ? source.history.slice(0, MAX_HISTORY) : [],
    updatedAt: Number(source.updatedAt || Date.now())
  };
}

export async function getState() {
  const result = await chrome.storage.local.get(STATE_KEY);
  return normalizeState(result[STATE_KEY] || cloneDefaultState());
}

export async function setState(nextState) {
  const normalized = normalizeState({ ...nextState, updatedAt: Date.now() });
  await chrome.storage.local.set({ [STATE_KEY]: normalized });
  return normalized;
}

export function mutateState(mutator) {
  mutationChain = mutationChain.then(async () => {
    const current = await getState();
    const candidate = await mutator(current);
    return setState(candidate || current);
  });
  return mutationChain;
}

export async function initializeState() {
  const state = await getState();
  return setState(state);
}

export async function updateSettings(settings) {
  return mutateState((state) => ({
    ...state,
    settings: normalizeSettings({ ...state.settings, ...settings })
  }));
}

export async function addQueueItems(items) {
  return mutateState((state) => {
    const existing = new Set(
      state.queue
        .filter((item) => !["done", "failed", "cancelled"].includes(item.status))
        .map((item) => item.url)
    );
    const additions = items.filter((item) => item?.url && !existing.has(item.url));
    return { ...state, queue: [...state.queue, ...additions].slice(-250) };
  });
}

export async function replaceQueue(queue) {
  return mutateState((state) => ({ ...state, queue: Array.isArray(queue) ? queue.slice(-250) : [] }));
}

export async function appendHistory(entry) {
  return mutateState((state) => ({
    ...state,
    history: [{ ...entry, completedAt: entry.completedAt || Date.now() }, ...state.history]
      .slice(0, MAX_HISTORY)
  }));
}

export async function clearHistory() {
  return mutateState((state) => ({ ...state, history: [] }));
}
