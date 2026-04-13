#!/usr/bin/env bash
set -euox pipefail

project="$1"

root="/home/daytona/workspace"
repo="$root/repo"
localbin="/home/daytona/opencode"
installbin="/home/daytona/.opencode/bin/opencode"

printf "%s\n" "ipv4" > "$HOME/.curlrc"
rm -rf "$repo"
mkdir -p "$root"
tar -xzf "$HOME/repo.tgz" -C "$HOME/workspace"

ls -last "$HOME"

if [ -f "$HOME/opencode" ]; then
  chmod +x "$HOME/opencode"
  exe="$localbin"
else
  mkdir -p "$HOME/.opencode/bin"
  OPENCODE_INSTALL_DIR="$HOME/.opencode/bin" curl -4 -fsSL https://opencode.ai/install | bash
  exe="$installbin"
fi

echo "opencode: $exe"
printf "%s\n" "$project" > "$repo/.git/opencode"

cd "$repo"
OPENCODE_WORKSPACE=true OPENCODE_EXPERIMENTAL_WORKSPACES=true nohup "$exe" serve --hostname 0.0.0.0 --port 3096 --print-logs > /tmp/opencode-server.log 2>&1 &

for i in $(seq 1 60); do
  if curl -4 -fsS http://127.0.0.1:3096/global/health >/dev/null; then
    echo "ready"
    exit 0
  fi
  echo "waiting for server ($i/60)"
  sleep 1
done

echo "daytona workspace server did not become ready in time" >&2
exit 1
