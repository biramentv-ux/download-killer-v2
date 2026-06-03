# DyrakArmy Mobile Expo Shell

Native mobile shell scaffold for iOS/Android that syncs with the main DyrakArmy platform.

## Included in this scaffold

- Retro Wave themed app shell
- Tabs: `Download`, `History`, `Settings`
- Shared sync model:
  - `apiBase`
  - `syncKey`
  - `lang` (`bg`/`en`)
- Queue/download via existing Worker API (`/api/download`, `/api/job/:id`, `/api/history`)
- Deep link/open actions for Web app, Telegram, desktop builds, and browser extensions

## Run

```bash
cd mobile_expo
npm install
npm run start
```

## Typecheck

```bash
npx tsc --noEmit
```

## Store-ready builds

This is a real Expo native app project, not only a PWA shortcut. The website publishes this source package for download, while public iOS/Android distribution is produced with EAS and store credentials:

```bash
npm run build:ios:production
npm run build:android:production
npm run submit:ios
npm run submit:android
```

Required external accounts are listed in `store-readiness.md`.
