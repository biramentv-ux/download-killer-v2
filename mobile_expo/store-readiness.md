# DyrakArmy Mobile Store Readiness

This Expo project is a native iOS/Android app shell connected to the live DyrakArmy backend.

## Current Native Metadata

- App name: `DyrakArmy Mobile`
- iOS bundle id: `online.dyrakarmy.mobile`
- Android package: `online.dyrakarmy.mobile`
- Deep-link scheme: `dyrakarmy://`
- Associated domains: `dyrakarmy.online`, `www.dyrakarmy.online`
- Encryption export: `ITSAppUsesNonExemptEncryption=false`
- iOS privacy manifest: UserDefaults required-reason declaration (`CA92.1`) and no tracking domains.

## Build

```bash
npm install
npx expo install --fix
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
- Apple credentials must be configured with `npx eas-cli@latest credentials -p ios`.
- Google Play service account JSON must stay outside git and be referenced only on the release machine/CI secret store.

## Store Artifact Notes

- iOS: public distribution is through TestFlight/App Store. A raw `.ipa` cannot be publicly installed from a normal website without Apple-approved distribution.
- Android: production artifact is an `.aab`; preview/internal testing can also build an `.apk` with the `preview` profile.
- The website download buttons expose this EAS-ready project package until official TestFlight/App Store/Play Store URLs are available.

## Backend Sync

- Runtime config: `GET /api/runtime-config`
- Preferences: `GET/POST /api/preferences`
- Queue: `POST /api/download`
- History: `GET /api/history`
- Telegram: `GET /api/telegram/info`
