#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
umask 077
if [[ -z "${PREFIX:-}" ]] || ! command -v sv >/dev/null 2>&1; then
  echo 'Run termux-setup.sh in Termux first.' >&2
  exit 1
fi
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
service_dir="$PREFIX/var/service/whatsappy"
boot_file="$HOME/.termux/boot/20-whatsappy"
log_dir="$PREFIX/var/log/sv/whatsappy"
if [[ -e "$service_dir" || -e "$boot_file" ]]; then
  echo 'Existing Whatsappy service or boot script found; left unchanged.' >&2
  exit 1
fi
mkdir -p -- "$service_dir/log" "$log_dir" "$(dirname -- "$boot_file")"
# Keep the service disabled until the owner starts it explicitly.
touch "$service_dir/down"
{
  printf '#!%s/bin/bash\n' "$PREFIX"
  printf 'umask 077\nexec 2>&1\ncd -- %q || exit 1\n' "$project_dir"
  printf 'exec %q src/cli.js run\n' "$PREFIX/bin/node"
} > "$service_dir/run"
{
  printf '#!%s/bin/bash\n' "$PREFIX"
  printf 'exec %q -tt %q\n' "$PREFIX/bin/svlogd" "$log_dir"
} > "$service_dir/log/run"
# Rotate at 1 MB, retain five old logs.
printf 's1000000\nn5\n' > "$log_dir/config"
{
  printf '#!%s/bin/bash\n' "$PREFIX"
  printf '%q\n' "$PREFIX/bin/termux-wake-lock"
  printf 'source %q\n' "$PREFIX/etc/profile.d/start-services.sh"
} > "$boot_file"
chmod 700 "$service_dir/run" "$service_dir/log/run" "$boot_file"
echo 'Service installed, disabled. Install/open the compatible Termux:Boot app once.'
echo 'Restart the Termux shell, then use: sv-enable whatsappy'
echo 'Keep liveEnabled=false for the first screen-locked and reboot checks.'
