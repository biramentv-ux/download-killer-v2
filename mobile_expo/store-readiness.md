# DyrakArmy Mobile Store Readiness

This Expo project is a native iOS/Android app shell connected to the live DyrakArmy backend.

## Build

```bash
npx eas-cli@latest build -p ios --profile production
npx eas-cli@latest build -p android --profile production
```

## Submit

```bash
npx eas-cli@latest submit -p ios --profile production
npx eas-cli@latest submit -p android --profile production
```

## Required External Accounts

- Apple Developer Program account for App Store/TestFlight.
- Google Play Console account and service account JSON for Play Store upload.
- EAS account/login on the build machine.

## Backend Sync

- Runtime config: `GET /api/runtime-config`
- Preferences: `GET/POST /api/preferences`
- Queue: `POST /api/download`
- History: `GET /api/history`
- Telegram: `GET /api/telegram/info`
