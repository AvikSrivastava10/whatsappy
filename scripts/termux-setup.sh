#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
umask 077
if [[ -z "${PREFIX:-}" ]] || ! command -v pkg >/dev/null 2>&1; then
  echo 'Run this script inside Termux on your Android phone.' >&2
  exit 1
fi
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$project_dir"
pkg install -y nodejs-lts git termux-services
node -e 'const [major,minor] = process.versions.node.split(".").map(Number); if(major<22 || (major===22 && minor<16)) throw new Error("Node 22.16+ required"); require("node:sqlite")'
npm ci --omit=dev
npm test
node src/cli.js init
node src/cli.js doctor
echo 'Setup complete. No WhatsApp account was linked and no service was started.'
echo 'Next: follow README.md to configure, link, review a question, and install the service.'
