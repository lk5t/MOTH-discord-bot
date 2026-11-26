#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
#  MOTH installer — AI-powered Discord bot & server management platform
#
#    curl -fsSL https://raw.githubusercontent.com/lk5t/MOTH-discord-bot/main/install.sh | sudo bash
#
#  Options (pass after `bash -s --`, or as environment variables):
#    --dir <path>          Install directory            (MOTH_DIR, default /opt/moth)
#    --version <tag>       Release tag to install       (MOTH_INSTALL_VERSION, default latest)
#    --domain <domain>     Enable automatic HTTPS       (MOTH_DOMAIN)
#    --port <port>         Dashboard port without HTTPS (DASHBOARD_PORT, default 3000)
#    --unattended          Never prompt; read DISCORD_TOKEN, DISCORD_CLIENT_ID,
#                          DISCORD_CLIENT_SECRET, MOTH_OWNER_IDS from the environment
#    --build               Build images locally instead of pulling them
#    --no-start            Configure everything but don't start services
#
#  Re-running the installer upgrades an existing installation and keeps .env,
#  the database and backups.
# ──────────────────────────────────────────────────────────────────────────────
set -Eeuo pipefail

REPO="lk5t/MOTH-discord-bot"
MOTH_DIR="${MOTH_DIR:-/opt/moth}"
INSTALL_VERSION="${MOTH_INSTALL_VERSION:-latest}"
DOMAIN="${MOTH_DOMAIN:-}"
PORT="${DASHBOARD_PORT:-3000}"
UNATTENDED="${MOTH_UNATTENDED:-0}"
FORCE_BUILD="${MOTH_BUILD:-0}"
NO_START=0
LOG_FILE="/var/log/moth-install.log"
MIN_RAM_MB=900
MIN_DISK_GB=4

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) MOTH_DIR="$2"; shift 2 ;;
    --version) INSTALL_VERSION="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --unattended|-y) UNATTENDED=1; shift ;;
    --build) FORCE_BUILD=1; shift ;;
    --no-start) NO_START=1; shift ;;
    -h|--help) sed -n '2,22p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

# ─── Output helpers ───
if [[ -t 1 ]]; then C_R=$'\e[38;5;161m'; C_G=$'\e[32m'; C_Y=$'\e[33m'; C_D=$'\e[2m'; C_B=$'\e[1m'; C_0=$'\e[0m'; else C_R=; C_G=; C_Y=; C_D=; C_B=; C_0=; fi
STEP=0; TOTAL=13
step() { STEP=$((STEP + 1)); printf "\n%s[%2d/%d]%s %s%s%s\n" "$C_R" "$STEP" "$TOTAL" "$C_0" "$C_B" "$*" "$C_0"; }
info() { printf "      %s\n" "$*"; }
ok()   { printf "      %s✓%s %s\n" "$C_G" "$C_0" "$*"; }
warn() { printf "      %s!%s %s\n" "$C_Y" "$C_0" "$*"; }
die()  { printf "\n%s✗ %s%s\n" "$C_R" "$*" "$C_0" >&2; printf "  Full log: %s\n" "$LOG_FILE" >&2; exit 1; }
run()  { echo "+ $*" >>"$LOG_FILE"; "$@" >>"$LOG_FILE" 2>&1; }
trap 'die "Installation failed at line $LINENO (step $STEP). See the log for details."' ERR

# Prompts read from the terminal even when the script is piped into bash.
TTY=/dev/tty
can_prompt() { [[ "$UNATTENDED" != "1" ]] && [[ -r "$TTY" ]] && { : <"$TTY"; } 2>/dev/null; }
ask() { # ask VAR "Question" [default] [secret]
  local __var="$1" __q="$2" __def="${3:-}" __secret="${4:-}" __ans=""
  if ! can_prompt; then printf -v "$__var" '%s' "$__def"; return; fi
  if [[ -n "$__secret" ]]; then read -rs -p "      $__q: " __ans <"$TTY"; echo; else read -r -p "      $__q${__def:+ [$__def]}: " __ans <"$TTY"; fi
  printf -v "$__var" '%s' "${__ans:-$__def}"
}

banner() {
  cat <<EOF
${C_R}
    ███╗   ███╗ ██████╗ ████████╗██╗  ██╗
    ████╗ ████║██╔═══██╗╚══██╔══╝██║  ██║
    ██╔████╔██║██║   ██║   ██║   ███████║
    ██║╚██╔╝██║██║   ██║   ██║   ██╔══██║
    ██║ ╚═╝ ██║╚██████╔╝   ██║   ██║  ██║
    ╚═╝     ╚═╝ ╚═════╝    ╚═╝   ╚═╝  ╚═╝${C_0}
    ${C_D}AI-powered Discord server management · installer${C_0}
EOF
}

[[ $EUID -eq 0 ]] || { echo "Please run as root: curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | sudo bash" >&2; exit 1; }
mkdir -p "$(dirname "$LOG_FILE")"; : >"$LOG_FILE"; chmod 600 "$LOG_FILE"
banner

# ─── 1. Detect distribution & architecture ───
step "Detecting system"
[[ -r /etc/os-release ]] || die "Cannot detect the Linux distribution (/etc/os-release missing)."
# shellcheck disable=SC1091
. /etc/os-release
DISTRO="${ID:-unknown}"; DISTRO_LIKE="${ID_LIKE:-}"; DISTRO_VERSION="${VERSION_ID:-}"
case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "Unsupported architecture $(uname -m). MOTH supports x86_64 and arm64." ;;
esac
PKG=""
for pm in apt-get dnf yum pacman zypper apk; do command -v "$pm" >/dev/null 2>&1 && { PKG="$pm"; break; }; done
[[ -n "$PKG" ]] || die "No supported package manager found (apt, dnf, yum, pacman, zypper, apk)."
HAS_SYSTEMD=0; [[ -d /run/systemd/system ]] && HAS_SYSTEMD=1
ok "${PRETTY_NAME:-$DISTRO $DISTRO_VERSION} · $ARCH · package manager: $PKG · init: $([[ $HAS_SYSTEMD == 1 ]] && echo systemd || echo other)"

# ─── 2. System requirements ───
step "Checking system requirements"
RAM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
[[ "$RAM_MB" -ge "$MIN_RAM_MB" ]] || die "At least 1 GB RAM is required (found ${RAM_MB} MB)."
[[ "$RAM_MB" -ge 1900 ]] && ok "Memory: ${RAM_MB} MB" || warn "Memory: ${RAM_MB} MB — 2 GB+ recommended (local image builds may be slow)."
mkdir -p "$(dirname "$MOTH_DIR")"
DISK_GB=$(df -Pk "$(dirname "$MOTH_DIR")" | awk 'NR==2 {print int($4/1048576)}')
[[ "$DISK_GB" -ge "$MIN_DISK_GB" ]] || die "At least ${MIN_DISK_GB} GB free disk space is required (found ${DISK_GB} GB)."
ok "Free disk: ${DISK_GB} GB"
KERNEL_MAJOR=$(uname -r | cut -d. -f1)
[[ "$KERNEL_MAJOR" -ge 4 ]] || die "Linux kernel 4.x or newer is required."
ok "Kernel $(uname -r)"

# ─── 3. Dependencies ───
step "Installing dependencies"
pkg_install() {
  case "$PKG" in
    apt-get) DEBIAN_FRONTEND=noninteractive run apt-get update -y && DEBIAN_FRONTEND=noninteractive run apt-get install -y --no-install-recommends "$@" ;;
    dnf) run dnf install -y "$@" ;;
    yum) run yum install -y "$@" ;;
    pacman) run pacman -Sy --noconfirm --needed "$@" ;;
    zypper) run zypper --non-interactive install "$@" ;;
    apk) run apk add --no-cache "$@" ;;
  esac
}
NEED=()
for bin in curl tar openssl gzip; do command -v "$bin" >/dev/null 2>&1 || NEED+=("$bin"); done
[[ -f /etc/ssl/certs/ca-certificates.crt || -f /etc/pki/tls/certs/ca-bundle.crt || -f /etc/ssl/ca-bundle.pem ]] || NEED+=(ca-certificates)
[[ "$PKG" == "apk" ]] && ! command -v bash >/dev/null && NEED+=(bash)
if [[ ${#NEED[@]} -gt 0 ]]; then pkg_install "${NEED[@]}" || die "Failed to install: ${NEED[*]}"; fi
ok "curl, tar, openssl, gzip, CA certificates"

# ─── 4. Docker & Docker Compose ───
step "Installing Docker"
install_docker() {
  local family="$DISTRO"
  case " $DISTRO_LIKE " in *" arch "*) family=arch ;; *" rhel "*|*" centos "*) [[ "$DISTRO" != fedora ]] && family=rhel ;; *" suse "*) family=opensuse ;; esac
  case "$family" in
    arch|manjaro|endeavouros) pkg_install docker docker-compose ;;
    alpine) pkg_install docker docker-cli-compose ;;
    opensuse*|sles) pkg_install docker docker-compose ;;
    rocky|almalinux|rhel|centos|ol)
      pkg_install dnf-plugins-core || true
      run dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo || run yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
      pkg_install docker-ce docker-ce-cli containerd.io docker-compose-plugin ;;
    *)
      # Official convenience script: Ubuntu, Debian, Raspbian, Fedora, CentOS, RHEL…
      local tmp; tmp="$(mktemp)"
      curl -fsSL https://get.docker.com -o "$tmp" || die "Could not download the Docker installer."
      run sh "$tmp" || die "Docker installation failed. Install Docker manually (https://docs.docker.com/engine/install/) and re-run."
      rm -f -- "$tmp" ;;
  esac
}
if command -v docker >/dev/null 2>&1; then ok "Docker already installed ($(docker --version | cut -d, -f1))"; else install_docker; ok "Docker installed"; fi
if [[ $HAS_SYSTEMD == 1 ]]; then run systemctl enable --now docker || true
elif command -v rc-update >/dev/null; then run rc-update add docker default || true; run service docker start || true; fi
for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
docker info >/dev/null 2>&1 || die "The Docker daemon is not running."
if ! docker compose version >/dev/null 2>&1; then
  info "Installing the Docker Compose plugin…"
  pkg_install docker-compose-plugin >/dev/null 2>&1 || {
    CV=$(curl -fsSL https://api.github.com/repos/docker/compose/releases/latest | grep -m1 '"tag_name"' | cut -d'"' -f4)
    mkdir -p /usr/local/lib/docker/cli-plugins
    curl -fsSL "https://github.com/docker/compose/releases/download/${CV}/docker-compose-linux-$(uname -m)" -o /usr/local/lib/docker/cli-plugins/docker-compose
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
  }
fi
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required but could not be installed."
ok "$(docker compose version | head -1)"

# ─── 5. Download MOTH ───
step "Downloading MOTH"
TAG=""
if [[ "$INSTALL_VERSION" == "latest" ]]; then
  TAG=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null | grep -m1 '"tag_name"' | cut -d'"' -f4 || true)
else TAG="$INSTALL_VERSION"; fi
WORK="$(mktemp -d)"
if [[ -n "$TAG" ]] && curl -fsSL "https://github.com/${REPO}/archive/refs/tags/${TAG}.tar.gz" -o "$WORK/moth.tar.gz" 2>>"$LOG_FILE"; then
  ok "Stable release ${TAG}"
  IMAGE_VERSION="${TAG#v}"
else
  [[ "$INSTALL_VERSION" != "latest" ]] && die "Release ${INSTALL_VERSION} not found."
  warn "No published release found — installing the latest main branch."
  curl -fsSL "https://github.com/${REPO}/archive/refs/heads/main.tar.gz" -o "$WORK/moth.tar.gz" || die "Could not download MOTH from GitHub."
  IMAGE_VERSION="latest"; FORCE_BUILD=1
fi
mkdir -p "$WORK/src"
tar -xzf "$WORK/moth.tar.gz" -C "$WORK/src" --strip-components=1 || die "Downloaded archive is corrupt."
[[ -f "$WORK/src/docker-compose.yml" ]] || die "Downloaded archive doesn't look like MOTH."
UPGRADE=0; [[ -f "$MOTH_DIR/.env" ]] && UPGRADE=1
mkdir -p "$MOTH_DIR"
# Copy the new release over the install dir, preserving .env and backups.
(cd "$WORK/src" && tar -cf - --exclude=.env --exclude=backups .) | (cd "$MOTH_DIR" && tar -xf -)
rm -rf -- "${WORK:?}"
ok "Installed to $MOTH_DIR$([[ $UPGRADE == 1 ]] && echo " (upgrade — existing configuration kept)")"

# ─── 6. Configuration & credentials ───
step "Configuring MOTH"
ENV_FILE="$MOTH_DIR/.env"
get_env() { [[ -f "$ENV_FILE" ]] && grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }
set_env() { # set_env KEY VALUE — idempotent, safe for special characters
  local k="$1" v="$2"
  touch "$ENV_FILE"
  if grep -qE "^${k}=" "$ENV_FILE"; then
    local tmp; tmp="$(mktemp)"; awk -v k="$k" -v v="$v" -F= 'BEGIN{OFS="="} $1==k {print k"="v; next} {print}' "$ENV_FILE" >"$tmp" && cat "$tmp" >"$ENV_FILE" && rm -f -- "$tmp"
  else printf '%s=%s\n' "$k" "$v" >>"$ENV_FILE"; fi
}
[[ -f "$ENV_FILE" ]] || cp "$MOTH_DIR/.env.example" "$ENV_FILE"
chmod 600 "$ENV_FILE"

TOKEN="${DISCORD_TOKEN:-$(get_env DISCORD_TOKEN)}"
CLIENT_ID="${DISCORD_CLIENT_ID:-$(get_env DISCORD_CLIENT_ID)}"
CLIENT_SECRET="${DISCORD_CLIENT_SECRET:-$(get_env DISCORD_CLIENT_SECRET)}"
OWNERS="${MOTH_OWNER_IDS:-$(get_env MOTH_OWNER_IDS)}"
if [[ -z "$TOKEN" || -z "$CLIENT_ID" || -z "$CLIENT_SECRET" ]]; then
  if can_prompt; then
    cat <<EOF

      ${C_B}Discord application setup${C_0} — https://discord.com/developers/applications
      1. Create an application → ${C_B}Bot${C_0} tab → Reset Token (copy it).
      2. On the Bot tab enable ${C_B}Server Members Intent${C_0} and ${C_B}Message Content Intent${C_0}.
      3. ${C_B}OAuth2${C_0} tab → copy the Client ID and Client Secret.

EOF
  fi
  while [[ -z "$TOKEN" ]]; do ask TOKEN "Bot token" "" secret; can_prompt || break; done
  while [[ -z "$CLIENT_ID" ]]; do ask CLIENT_ID "Application (client) ID" ""; can_prompt || break; done
  while [[ -z "$CLIENT_SECRET" ]]; do ask CLIENT_SECRET "OAuth2 client secret" "" secret; can_prompt || break; done
fi
[[ -n "$TOKEN" && -n "$CLIENT_ID" && -n "$CLIENT_SECRET" ]] || die "Discord credentials are required. Re-run interactively, or set DISCORD_TOKEN, DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET."
[[ "$CLIENT_ID" =~ ^[0-9]{15,22}$ ]] || die "The client ID should be a numeric Discord ID."
[[ -z "$OWNERS" ]] && ask OWNERS "Your Discord user ID (instance owner, optional)" ""

# Validate the token against Discord before going further.
BOT_ME=$(curl -fsS -H "Authorization: Bot $TOKEN" https://discord.com/api/v10/users/@me 2>/dev/null || true)
if [[ -z "$BOT_ME" ]]; then die "Discord rejected the bot token. Double-check it on the Bot tab and try again."; fi
BOT_NAME=$(printf '%s' "$BOT_ME" | grep -o '"username":"[^"]*"' | head -1 | cut -d'"' -f4)
ok "Bot token valid (${BOT_NAME:-bot})"

[[ -z "$DOMAIN" ]] && DOMAIN="$(get_env MOTH_DOMAIN)"
if [[ -z "$DOMAIN" && $UPGRADE == 0 ]]; then ask DOMAIN "Domain for HTTPS (leave empty to use http://<server-ip>:${PORT})" ""; fi
PUBLIC_IP=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")

set_env DISCORD_TOKEN "$TOKEN"; set_env DISCORD_CLIENT_ID "$CLIENT_ID"; set_env DISCORD_CLIENT_SECRET "$CLIENT_SECRET"
set_env MOTH_OWNER_IDS "$OWNERS"
for secret in POSTGRES_PASSWORD MOTH_ENCRYPTION_KEY INTERNAL_API_SECRET; do
  [[ -n "$(get_env $secret)" ]] || set_env "$secret" "$(openssl rand -hex 32)"
done
set_env MOTH_VERSION "$IMAGE_VERSION"
ok "Secrets generated and stored in $ENV_FILE (mode 600)"

# ─── 7. Persistent storage ───
step "Configuring persistent storage"
mkdir -p "$MOTH_DIR/backups"; chmod 700 "$MOTH_DIR/backups"
ok "Database volume: moth_moth-db · backups: $MOTH_DIR/backups"

# ─── 8 & 9. Bot service & dashboard ───
step "Preparing the bot service"
ok "Bot runs migrations on start, restarts automatically and reports health every 15s"
step "Preparing the dashboard"
if [[ -n "$DOMAIN" ]]; then
  set_env MOTH_DOMAIN "$DOMAIN"; set_env COMPOSE_PROFILES "https"; set_env DASHBOARD_BIND "127.0.0.1"
  set_env DASHBOARD_URL "https://${DOMAIN}"
else
  set_env MOTH_DOMAIN ""; set_env COMPOSE_PROFILES ""; set_env DASHBOARD_BIND "0.0.0.0"; set_env DASHBOARD_PORT "$PORT"
  CUR_URL="$(get_env DASHBOARD_URL)"
  [[ -z "$CUR_URL" || "$CUR_URL" == "http://localhost:3000" ]] && set_env DASHBOARD_URL "http://${PUBLIC_IP}:${PORT}"
fi
DASH_URL="$(get_env DASHBOARD_URL)"
ok "Dashboard URL: $DASH_URL"

# ─── 10. Networking ───
step "Configuring networking"
open_port() {
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then run ufw allow "$1"/tcp; ok "ufw: opened $1/tcp"
  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then run firewall-cmd --permanent --add-port="$1"/tcp; run firewall-cmd --reload; ok "firewalld: opened $1/tcp"; fi
}
if [[ -n "$DOMAIN" ]]; then
  open_port 80; open_port 443
  RESOLVED=$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1 || true)
  if [[ -n "$RESOLVED" && "$RESOLVED" != "$PUBLIC_IP" ]]; then warn "$DOMAIN resolves to $RESOLVED, but this server's IP looks like $PUBLIC_IP. HTTPS certificates need DNS pointing here."; fi
  ok "Automatic HTTPS via Caddy for $DOMAIN"
else
  open_port "$PORT"
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${PORT}$" && ! docker ps --format '{{.Names}}' | grep -q '^moth-dashboard'; then warn "Port $PORT is already in use. Change DASHBOARD_PORT in $ENV_FILE."; fi
  ok "Dashboard exposed on port $PORT"
fi

# ─── 11. Automatic startup ───
step "Configuring automatic startup"
install -m 0755 "$MOTH_DIR/scripts/moth" /usr/local/bin/moth
if [[ $HAS_SYSTEMD == 1 ]]; then
  DOCKER_BIN="$(command -v docker)"
  cat >/etc/systemd/system/moth.service <<EOF
[Unit]
Description=MOTH — AI-powered Discord platform
Documentation=https://github.com/${REPO}
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${MOTH_DIR}
ExecStart=${DOCKER_BIN} compose up -d --remove-orphans
ExecStop=${DOCKER_BIN} compose down
ExecReload=${DOCKER_BIN} compose up -d --remove-orphans
TimeoutStartSec=900

[Install]
WantedBy=multi-user.target
EOF
  run systemctl daemon-reload; run systemctl enable moth.service
  ok "systemd unit moth.service enabled (plus Docker restart policies)"
else
  ok "Docker restart policies will start MOTH on boot"
fi
ok "Management CLI installed: moth"

# ─── 12. Start services ───
step "Starting MOTH"
cd "$MOTH_DIR"
if [[ $NO_START == 1 ]]; then warn "--no-start given; run 'moth start' when ready."; else
  if [[ $FORCE_BUILD != 1 ]] && run docker compose pull --quiet bot dashboard migrate; then ok "Pulled images ($IMAGE_VERSION)"
  else
    info "Building images locally (first build takes a few minutes)…"
    run docker compose build bot dashboard || die "Image build failed."
    ok "Images built"
  fi
  run docker compose pull --quiet postgres || true
  [[ -n "$DOMAIN" ]] && { run docker compose pull --quiet caddy || true; }
  run docker compose up -d --remove-orphans || die "Failed to start services."
  ok "Containers started"
fi

# ─── 13. Verify ───
step "Verifying installation"
if [[ $NO_START == 0 ]]; then
  DP="$(get_env DASHBOARD_PORT)"; HEALTH_URL="http://127.0.0.1:${DP:-3000}/api/health"
  DASH_OK=0; BOT_STATE=""
  for _ in $(seq 1 90); do
    if [[ $DASH_OK == 0 ]]; then
      if [[ -n "$DOMAIN" ]]; then docker compose exec -T dashboard node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1 && DASH_OK=1
      else curl -fsS "$HEALTH_URL" >/dev/null 2>&1 && DASH_OK=1; fi
    fi
    BOT_STATE=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$(docker compose ps -q bot 2>/dev/null | head -1)" 2>/dev/null || echo "missing")
    [[ $DASH_OK == 1 && "$BOT_STATE" == "healthy" ]] && break
    sleep 2
  done
  MIG_EXIT=$(docker inspect -f '{{.State.ExitCode}}' "$(docker compose ps -aq migrate | head -1)" 2>/dev/null || echo "?")
  [[ "$MIG_EXIT" == "0" ]] && ok "Database migrated" || warn "Migrations exited with code $MIG_EXIT — run: moth logs migrate"
  [[ $DASH_OK == 1 ]] && ok "Dashboard is healthy" || warn "Dashboard not healthy yet — run: moth logs dashboard"
  if [[ "$BOT_STATE" == "healthy" ]]; then ok "Bot connected to Discord"
  else
    warn "Bot status: ${BOT_STATE}. If it keeps restarting, make sure both privileged intents are enabled"
    warn "(Server Members + Message Content) on the Bot tab, then run: moth restart · logs: moth logs bot"
  fi
fi
trap - ERR

INVITE="https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&permissions=8&scope=bot%20applications.commands"
cat <<EOF

${C_R}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C_0}
  ${C_B}🦋 MOTH is installed.${C_0}

  ${C_B}Dashboard${C_0}     ${DASH_URL}
  ${C_B}Invite bot${C_0}    ${INVITE}

  ${C_B}One more step:${C_0} in the Discord Developer Portal → OAuth2 → Redirects, add
                ${C_B}${DASH_URL}/api/auth/callback${C_0}

  ${C_D}Manage:   moth status · moth logs · moth update · moth backup · moth help
  Config:   ${ENV_FILE}
  Log:      ${LOG_FILE}${C_0}
${C_R}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C_0}
EOF
