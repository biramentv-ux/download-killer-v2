# Latency Strike v1

Latency Strike is the Download Killer Telegram reaction game.

## Player flow

1. Open `/game` in `@dyrakarmy_bot` or choose Latency Strike in the Mini App command center.
2. Complete five `QUEUED → PROCESSING → READY` rounds.
3. The Worker validates the one-time session and calculates the score.
4. XP, rank, weekly position and newly unlocked rewards are persisted in D1.
5. Unlocked profile frames, icons, animated badges, waveforms, themes and titles can be equipped from the game screen.

## Production deployment

```bash
cd worker
npm ci
npm run typecheck
npm test
npx wrangler d1 migrations apply sounddrop-db --remote
npm run deploy
npm run telegram:setup
```

Required Worker secrets:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_SECRET_TOKEN`

Optional native Telegram Games catalog entry:

- BotFather game short name: `latency_strike`
- Game URL: `https://dyrakarmy.eu/games/latency-strike/`

The integrated Telegram Web App game and reward system do not depend on the optional catalog entry.
