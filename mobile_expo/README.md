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

