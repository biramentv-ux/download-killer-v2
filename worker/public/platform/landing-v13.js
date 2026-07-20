(() => {
  'use strict';

  const translations = {
    bg: {
      nav_home: 'Начало', nav_how: 'Как работи', nav_features: 'Функции', nav_docs: 'Документация', nav_contacts: 'Контакти',
      hero_tag: 'БЪРЗО. ЛЕСНО. МОЩНО.', hero_title_a: 'Какво е системата', hero_title_b: 'и как се използва',
      hero_text_a: 'Платформата приема публичен URL, валидира го, добавя задачата в обща опашка и предава обработката към наличния backend.',
      hero_text_b: 'Резултатът се връща в сайта или директно в Telegram.', learn_more: 'Научи повече', docs: 'Към документация',
      benefits_fast: 'Бърза обработка', benefits_fast_text: 'Оптимизирани сървъри и smart маршрутизация.',
      benefits_secure: 'Сигурно и надеждно', benefits_secure_text: 'Валидация, защити и стабилна инфраструктура.',
      benefits_scale: 'Мащабируемост', benefits_scale_text: 'Система, готова за голямо натоварване.',
      benefits_auto: 'Автоматизация', benefits_auto_text: 'Минимална намеса, максимална ефективност.',
      process_tag: 'КАК РАБОТИ', process_title: 'Прост процес, мощен резултат',
      step1: 'Подай URL', step1_text: 'Въведи публичен линк в системата.', step2: 'Валидация', step2_text: 'Системата проверява линка и типа съдържание.',
      step3: 'В опашка', step3_text: 'Задачата се добавя в обща опашка.', step4: 'Обработка', step4_text: 'Предава се към наличния backend.', step5: 'Резултат', step5_text: 'Файлът се връща в сайта или Telegram.',
      features_tag: 'ФУНКЦИИ', features_title: 'Създадена за производителност',
      feature1: 'Множество източници', feature1_text: 'Видео, аудио, плейлисти и публични RSS източници.',
      feature2: 'Интелигентна опашка', feature2_text: 'Оптимално разпределение, retry логика и status backoff.',
      feature3: 'Telegram интеграция', feature3_text: 'Mini App, архив, история и директна доставка в чата.',
      feature4: 'Мощен backend', feature4_text: 'Cloudflare Worker, FastAPI, FFmpeg, D1, KV и Queues.',
      feature5: 'Сигурност и контрол', feature5_text: 'URL политики, rate limits, HMAC и защитени файлови връзки.',
      feature6: 'Responsive интерфейс', feature6_text: 'Оптимизиран за телефон, таблет и настолен компютър.',
      console_tag: 'LIVE CONTROL', console_title: 'Работеща Download конзола',
      telegram_cta: 'Готов да опиташ Download Killer?', telegram_cta_text: 'Отвори @dyrakarmy_bot чрез инсталирания Telegram клиент.',
      status_tag: 'RUNTIME TELEMETRY', status_heading: 'Системен статус и последни задачи'
    },
    en: {
      nav_home: 'Home', nav_how: 'How it works', nav_features: 'Features', nav_docs: 'Documentation', nav_contacts: 'Contacts',
      hero_tag: 'FAST. SIMPLE. POWERFUL.', hero_title_a: 'What the system is', hero_title_b: 'and how to use it',
      hero_text_a: 'The platform accepts a public URL, validates it, adds the task to a shared queue and routes processing to the available backend.',
      hero_text_b: 'The result returns to the website or directly to Telegram.', learn_more: 'Learn more', docs: 'Documentation',
      benefits_fast: 'Fast processing', benefits_fast_text: 'Optimized servers and smart routing.', benefits_secure: 'Secure and reliable', benefits_secure_text: 'Validation, protection and stable infrastructure.',
      benefits_scale: 'Scalable', benefits_scale_text: 'A system ready for heavy load.', benefits_auto: 'Automation', benefits_auto_text: 'Minimal intervention, maximum efficiency.',
      process_tag: 'HOW IT WORKS', process_title: 'Simple process, powerful result', step1: 'Submit URL', step1_text: 'Enter a public link.', step2: 'Validation', step2_text: 'The system verifies the URL and content type.', step3: 'Queue', step3_text: 'The task enters the shared queue.', step4: 'Processing', step4_text: 'It is sent to an available backend.', step5: 'Result', step5_text: 'The file returns to web or Telegram.',
      features_tag: 'FEATURES', features_title: 'Built for productivity', feature1: 'Multiple sources', feature1_text: 'Video, audio, playlists and public RSS sources.', feature2: 'Smart queue', feature2_text: 'Optimal distribution, retries and status backoff.', feature3: 'Telegram integration', feature3_text: 'Mini App, archive, history and direct chat delivery.', feature4: 'Powerful backend', feature4_text: 'Cloudflare Worker, FastAPI, FFmpeg, D1, KV and Queues.', feature5: 'Security and control', feature5_text: 'URL policies, rate limits, HMAC and protected file links.', feature6: 'Responsive interface', feature6_text: 'Optimized for phone, tablet and desktop.', console_tag: 'LIVE CONTROL', console_title: 'Working download console', telegram_cta: 'Ready to try Download Killer?', telegram_cta_text: 'Open @dyrakarmy_bot with the installed Telegram client.', status_tag: 'RUNTIME TELEMETRY', status_heading: 'System status and recent jobs'
    },
    ru: {},
    de: {}
  };

  translations.ru = { ...translations.en, nav_home: 'Главная', nav_how: 'Как работает', nav_features: 'Функции', nav_docs: 'Документация', nav_contacts: 'Контакты', hero_title_a: 'Что это за система', hero_title_b: 'и как её использовать', learn_more: 'Узнать больше', docs: 'Документация' };
  translations.de = { ...translations.en, nav_home: 'Start', nav_how: 'So funktioniert es', nav_features: 'Funktionen', nav_docs: 'Dokumentation', nav_contacts: 'Kontakt', hero_title_a: 'Was das System ist', hero_title_b: 'und wie es funktioniert', learn_more: 'Mehr erfahren', docs: 'Dokumentation' };

  const getLang = () => {
    const lang = String(document.documentElement.lang || 'bg').slice(0, 2).toLowerCase();
    return translations[lang] ? lang : 'bg';
  };

  function applyTranslations() {
    const copy = translations[getLang()];
    document.querySelectorAll('[data-landing-i18n]').forEach((node) => {
      const value = copy[node.dataset.landingI18n];
      if (value) node.textContent = value;
    });
  }

  function setupNavigation() {
    const toggle = document.querySelector('#mobileNavToggle');
    const nav = document.querySelector('#mainNav');
    const header = document.querySelector('.topbar');
    if (!toggle || !nav) return;

    const setOpen = (open) => {
      toggle.setAttribute('aria-expanded', String(open));
      nav.dataset.open = String(open);
      document.body.classList.toggle('nav-open', open);
    };

    toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'));
    nav.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => setOpen(false)));
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') setOpen(false); });
    document.addEventListener('click', (event) => {
      if (toggle.getAttribute('aria-expanded') === 'true' && !nav.contains(event.target) && !toggle.contains(event.target)) setOpen(false);
    });

    const onScroll = () => { if (header) header.dataset.scrolled = String(window.scrollY > 18); };
    onScroll();
    addEventListener('scroll', onScroll, { passive: true });

    if ('IntersectionObserver' in window) {
      const links = new Map(Array.from(nav.querySelectorAll('a[href^="#"]')).map((link) => [link.getAttribute('href').slice(1), link]));
      const observer = new IntersectionObserver((entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (!visible) return;
        links.forEach((link) => link.classList.remove('active'));
        links.get(visible.target.id)?.classList.add('active');
      }, { rootMargin: '-25% 0px -60%', threshold: [0.1, 0.35, 0.6] });
      links.forEach((_, id) => { const section = document.getElementById(id); if (section) observer.observe(section); });
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    applyTranslations();
    setupNavigation();
    new MutationObserver(applyTranslations).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  });
})();
