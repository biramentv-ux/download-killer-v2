(() => {
  "use strict";

  const BUTTON_CLASS = "download-killer-track-button";
  let scanTimer = null;

  function absoluteSpotifyUrl(href) {
    try {
      const url = new URL(String(href || ""), location.origin);
      const match = url.pathname.match(/^\/(?:intl-[^/]+\/)?track\/([A-Za-z0-9]+)/);
      return match ? `https://open.spotify.com/track/${match[1]}` : "";
    } catch {
      return "";
    }
  }

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function artistFromContainer(container) {
    const artistLinks = Array.from(container.querySelectorAll('a[href*="/artist/"]'));
    const artists = artistLinks.map((node) => cleanText(node.textContent)).filter(Boolean);
    return [...new Set(artists)].join(", ") || "Unknown artist";
  }

  function trackFromAnchor(anchor) {
    const url = absoluteSpotifyUrl(anchor?.getAttribute("href"));
    if (!url) return null;
    const row = anchor.closest('[data-testid="tracklist-row"], [data-testid="track-row"], [role="row"]') ||
      anchor.parentElement || document.body;
    const title = cleanText(anchor.textContent) ||
      cleanText(row.querySelector('[data-testid="internal-track-link"]')?.textContent) ||
      cleanText(row.querySelector('[data-testid="track-title"]')?.textContent) ||
      "Spotify track";
    return { url, title, artist: artistFromContainer(row) };
  }

  function getCurrentTrack() {
    const directUrl = absoluteSpotifyUrl(location.href);
    if (directUrl) {
      const title = cleanText(document.querySelector("main h1")?.textContent) ||
        cleanText(document.querySelector('[data-testid="entityTitle"]')?.textContent) ||
        "Spotify track";
      const container = document.querySelector("main") || document.body;
      return { url: directUrl, title, artist: artistFromContainer(container) };
    }

    const candidates = [
      '[data-testid="now-playing-widget"] a[href*="/track/"]',
      '[data-testid="context-item-link"][href*="/track/"]',
      'footer a[href*="/track/"]',
      'a[href*="/track/"][aria-current="page"]'
    ];
    for (const selector of candidates) {
      const anchor = document.querySelector(selector);
      const track = trackFromAnchor(anchor);
      if (track) return track;
    }
    return null;
  }

  function getVisiblePlaylistTracks() {
    const map = new Map();
    document.querySelectorAll('a[href*="/track/"]').forEach((anchor) => {
      const track = trackFromAnchor(anchor);
      if (track && !map.has(track.url)) map.set(track.url, track);
    });
    return Array.from(map.values()).slice(0, 200);
  }

  function injectTrackButtons() {
    document.querySelectorAll('a[href*="/track/"]').forEach((anchor) => {
      const track = trackFromAnchor(anchor);
      if (!track) return;
      const row = anchor.closest('[data-testid="tracklist-row"], [data-testid="track-row"], [role="row"]');
      if (!row || row.querySelector(`.${BUTTON_CLASS}`)) return;

      const button = document.createElement("button");
      button.type = "button";
      button.className = BUTTON_CLASS;
      button.textContent = "DK";
      button.title = "Изпрати към Download Killer";
      button.setAttribute("aria-label", `Изпрати ${track.title} към Download Killer`);
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        button.disabled = true;
        chrome.runtime.sendMessage(
          { action: "enqueueTrack", track },
          (response) => {
            button.disabled = false;
            if (chrome.runtime.lastError) {
              showToast(chrome.runtime.lastError.message, true);
              return;
            }
            showToast(response?.ok ? "Добавено в Download Killer" : response?.error || "Грешка", !response?.ok);
          }
        );
      });

      const actionArea = row.querySelector('[data-testid="more-button"]')?.parentElement ||
        row.lastElementChild || row;
      actionArea.appendChild(button);
    });
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(injectTrackButtons, 250);
  }

  function showToast(message, isError = false) {
    const old = document.querySelector(".download-killer-toast");
    if (old) old.remove();
    const toast = document.createElement("div");
    toast.className = `download-killer-toast${isError ? " error" : ""}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3200);
  }

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request?.action === "getCurrentTrack") {
      sendResponse({ ok: true, track: getCurrentTrack() });
      return false;
    }
    if (request?.action === "getPlaylistTracks") {
      const tracks = getVisiblePlaylistTracks();
      sendResponse({ ok: true, tracks, playlistUrl: location.href });
      return false;
    }
    return false;
  });

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  scheduleScan();
})();
