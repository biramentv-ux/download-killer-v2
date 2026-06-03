DyrakArmy Desktop Linux Portable

Run:
  chmod +x ./DyrakArmyDesktop.sh
  ./DyrakArmyDesktop.sh

Requirements:
- Linux x64 or ARM64/AArch64.
- Python 3 with venv support.
- The launcher installs Python dependencies into a local .venv folder on first run.
- It connects to https://dyrakarmy.online and uses the same sync/runtime config as Web, Windows, macOS and mobile.

Optional env:
  DYRAKARMY_URL=https://dyrakarmy.online ./DyrakArmyDesktop.sh
  DYRAKARMY_SYNC_KEY=your_sync_key ./DyrakArmyDesktop.sh
