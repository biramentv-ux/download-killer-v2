(() => {
  "use strict";

  const PRIMARY_URL = "https://dyrakarmy.eu/";
  const MIRROR_URL = "https://dyrakarmy.online/";
  const WINDOWS_CLIENT_URL = "/downloads/DyrakArmyDesktop.exe";

  const labels = {
    bg: { primary: "Основен домейн: dyrakarmy.eu", mirror: "Резервен домейн: dyrakarmy.online", windows: "Свали Windows клиента", title: "Първо се опитва Telegram Desktop, после Telegram Web." },
    en: { primary: "Primary domain: dyrakarmy.eu", mirror: "Backup domain: dyrakarmy.online", windows: "Download Windows client", title: "Tries Telegram Desktop first, then Telegram Web." },
    ru: { primary: "Основной домен: dyrakarmy.eu", mirror: "Резервный домен: dyrakarmy.online", windows: "Скачать клиент Windows", title: "Сначала открывается Telegram Desktop, затем Telegram Web." },
    de: { primary: "Primäre Domain: dyrakarmy.eu", mirror: "Backup-Domain: dyrakarmy.online", windows: "Windows-Client laden", title: "Versucht zuerst Telegram Desktop, danach Telegram Web." },
  };

  function language() {
    const value = String(document.documentElement.lang || "bg").slice(0, 2).toLowerCase();
    return labels[value] ? value : "bg";
  }

  function apply() {
    const copy = labels[language()];
    const canonical = document.querySelector('link[rel="canonical"]');
    if (canonical) canonical.href = PRIMARY_URL;

    const primary = document.querySelector("#canonicalDomainLink");
    if (primary) {
      primary.href = PRIMARY_URL;
      const text = primary.querySelector("span");
      if (text) text.textContent = "dyrakarmy.eu";
    }

    const domainSwitch = document.querySelector(".domain-switch");
    if (domainSwitch) {
      const links = domainSwitch.querySelectorAll("a");
      if (links[0]) {
        links[0].href = location.hostname.endsWith("dyrakarmy.eu") ? MIRROR_URL : PRIMARY_URL;
      }
      if (links[1]) {
        links[1].href = location.hostname.endsWith("dyrakarmy.eu") ? MIRROR_URL : PRIMARY_URL;
        const text = links[1].querySelector("span") || links[1];
        text.textContent = location.hostname.endsWith("dyrakarmy.eu") ? copy.mirror : copy.primary;
      }
    }

    document.querySelectorAll(".telegram-link").forEach((link) => {
      link.title = copy.title;
    });

    const actions = document.querySelector(".telegram-actions");
    if (actions && !document.querySelector("#windowsClientLink")) {
      const link = document.createElement("a");
      link.id = "windowsClientLink";
      link.className = "secondary-button";
      link.href = WINDOWS_CLIENT_URL;
      link.textContent = copy.windows;
      link.setAttribute("download", "DyrakArmyDesktop.exe");
      actions.appendChild(link);
    } else {
      const link = document.querySelector("#windowsClientLink");
      if (link) link.textContent = copy.windows;
    }
  }

  document.addEventListener("DOMContentLoaded", apply);
  new MutationObserver(apply).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
})();
