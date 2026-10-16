#!/usr/bin/env bash
#
# WinBig installer for AlmaLinux 8, 9 and 10 (also works on Rocky Linux and RHEL).
#
# First install: log in to the server as root and run
#
#   dnf install -y git
#   git clone https://github.com/dadad132/WINBIG.git
#   cd WINBIG
#   bash install.sh --domain winbig.co.za --email you@example.com
#
# Update to the latest version later (your data and settings are kept):
#
#   cd WINBIG && git pull && bash install.sh
#
# Options:
#   --domain NAME   Your website's domain name. Sets up nginx and a free HTTPS certificate
#                   (Let's Encrypt). Point the domain's DNS at this server first.
#   --email ADDR    Email address for HTTPS certificate expiry notices.
#   --port N        Port the app uses inside the server (default 3000).
#   --help          Show this help.
#
# Without --domain the site runs on http://SERVER-IP:3000, which is fine for trying it out.
# Yoco needs HTTPS, so run the installer again with --domain before taking real payments.

set -Eeuo pipefail

APP_USER=winbig
APP_DIR=/opt/winbig
HOME_DIR=/var/lib/winbig
DATA_DIR=$HOME_DIR/data
BACKUP_DIR=/var/backups/winbig
CONF_DIR=/etc/winbig
CONF_FILE=$CONF_DIR/winbig.env
SERVICE_FILE=/etc/systemd/system/winbig.service
NGINX_CONF=/etc/nginx/conf.d/winbig.conf
HELPER=/usr/local/bin/winbig
LOG=/var/log/winbig-install.log
SRC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

DOMAIN=""
EMAIL=""
PORT=""

# ------------------------------------------------------------------ output helpers

if [[ -t 1 ]]; then
  B=$'\e[1m' G=$'\e[32m' Y=$'\e[33m' R=$'\e[31m' N=$'\e[0m'
else
  B="" G="" Y="" R="" N=""
fi
step() { printf '\n%s==> %s%s\n' "$B" "$*" "$N"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '%s    ! %s%s\n' "$Y" "$*" "$N"; }
die() {
  printf '\n%sERROR: %s%s\n' "$R" "$*" "$N" >&2
  exit 1
}
trap 'die "Something went wrong on line $LINENO. Details are in $LOG"' ERR

# Runs a command quietly and logs its output. If it fails, shows the end of the log.
run() {
  if ! "$@" >>"$LOG" 2>&1; then
    printf '\n' >&2
    tail -n 25 "$LOG" >&2
    die "This command failed: $*  (full log: $LOG)"
  fi
}

usage() { sed -n '3,24p' "$0" | sed 's/^# \{0,1\}//'; }

# https://winbig.co.za/ -> winbig.co.za
clean_domain() {
  local d=${1#http://}
  d=${d#https://}
  d=${d%%/*}
  printf '%s' "${d,,}"
}

# ------------------------------------------------------------------ options & checks

while [[ $# -gt 0 ]]; do
  case $1 in
    --domain | --email | --port)
      [[ $# -ge 2 ]] || die "$1 needs a value (see --help)"
      case $1 in
        --domain) DOMAIN=$2 ;;
        --email) EMAIL=$2 ;;
        --port) PORT=$2 ;;
      esac
      shift 2
      ;;
    --domain=*) DOMAIN=${1#*=} && shift ;;
    --email=*) EMAIL=${1#*=} && shift ;;
    --port=*) PORT=${1#*=} && shift ;;
    -h | --help) usage && exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "Please run this as root:  sudo bash install.sh"
[[ -f $SRC_DIR/server.js && -f $SRC_DIR/package-lock.json ]] || die "Run install.sh from inside the WinBig folder."
[[ -r /etc/os-release ]] || die "Can't tell which Linux this is (/etc/os-release is missing)."
# shellcheck source=/dev/null
. /etc/os-release
case " ${ID:-} ${ID_LIKE:-} " in
  *" almalinux "* | *" rhel "* | *" rocky "* | *" centos "*) ;;
  *) die "This installer is for AlmaLinux (or Rocky Linux / RHEL). This server runs: ${PRETTY_NAME:-unknown}" ;;
esac
EL=${VERSION_ID%%.*}
if ! [[ $EL =~ ^[0-9]+$ ]] || ((EL < 8)); then
  die "AlmaLinux 8 or newer is needed (this server runs ${PRETTY_NAME:-unknown})."
fi

touch "$LOG" && chmod 600 "$LOG"
echo "===== WinBig install $(date) =====" >>"$LOG"

conf_get() { [[ -f $CONF_FILE ]] && sed -n "s/^$1=//p" "$CONF_FILE" | tail -n 1 || true; }
set_conf() {
  if grep -q "^$1=" "$CONF_FILE"; then
    sed -i "s|^$1=.*|$1=$2|" "$CONF_FILE"
  else
    echo "$1=$2" >>"$CONF_FILE"
  fi
}

FIRST_INSTALL=true
[[ -f $CONF_FILE ]] && FIRST_INSTALL=false

PORT=${PORT:-$(conf_get PORT)}
PORT=${PORT:-3000}
if ! [[ $PORT =~ ^[0-9]+$ ]] || ((PORT < 1 || PORT > 65535)); then
  die "--port must be a number between 1 and 65535."
fi

DOMAIN=$(clean_domain "$DOMAIN")
# Running the installer again without --domain keeps the domain that was set up last time.
if [[ -z $DOMAIN && -f $NGINX_CONF ]]; then
  DOMAIN=$(awk '$1 == "server_name" { gsub(";", "", $2); print $2; exit }' "$NGINX_CONF")
fi
if $FIRST_INSTALL && [[ -z $DOMAIN && -t 0 ]]; then
  echo
  echo "Which domain name will WinBig use (for example winbig.co.za)?"
  echo "Its DNS must already point to this server. Leave it empty to skip HTTPS for now."
  read -r -p "Domain: " DOMAIN
  DOMAIN=$(clean_domain "$DOMAIN")
fi
if [[ -n $DOMAIN && ! $DOMAIN =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]; then
  die "\"$DOMAIN\" doesn't look like a domain name."
fi
if [[ -n $DOMAIN && -z $EMAIL && ! -d /etc/letsencrypt/live/$DOMAIN && -t 0 ]]; then
  read -r -p "Email address for HTTPS certificate notices: " EMAIL
fi

echo "${B}Installing WinBig on ${PRETTY_NAME:-AlmaLinux}${N}"

# ------------------------------------------------------------------ system packages & Node.js

step "Installing system packages"
run dnf -y install ca-certificates curl tar gzip rsync gcc-c++ make python3
NPM_PYTHON=""
if ((EL == 8)); then
  # Building native packages needs a newer Python than AlmaLinux 8's default 3.6.
  run dnf -y install python3.11
  NPM_PYTHON=/usr/bin/python3.11
fi

node_major() {
  if command -v node >/dev/null 2>&1; then
    node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
  else
    echo 0
  fi
}

step "Installing Node.js"
if (($(node_major) >= 20)); then
  info "Node.js $(node -v) is already installed."
else
  streams=$(dnf -q module list nodejs 2>/dev/null | awk '$1 == "nodejs" { print $2 }' || true)
  for version in 22 20; do
    if grep -qx "$version" <<<"$streams"; then
      run dnf -y module reset nodejs
      run dnf -y module enable "nodejs:$version"
      break
    fi
  done
  run dnf -y install nodejs
  dnf -y distro-sync nodejs >>"$LOG" 2>&1 || true
  if (($(node_major) < 20)); then
    info "Getting Node.js 22 from NodeSource..."
    dnf -y module disable nodejs >>"$LOG" 2>&1 || true
    run curl -fsSL https://rpm.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
    run bash /tmp/nodesource_setup.sh
    run dnf -y install nodejs
  fi
  (($(node_major) >= 20)) || die "Could not install Node.js 20 or newer."
  info "Installed Node.js $(node -v)."
fi
command -v npm >/dev/null 2>&1 || run dnf -y install npm

# ------------------------------------------------------------------ app user, files and settings

step "Creating the winbig user and folders"
if ! id "$APP_USER" >/dev/null 2>&1; then
  run useradd --system --home-dir "$HOME_DIR" --no-create-home --shell /sbin/nologin --comment "WinBig website" "$APP_USER"
fi
install -d -o "$APP_USER" -g "$APP_USER" -m 750 "$HOME_DIR" "$DATA_DIR"
install -d -m 755 "$APP_DIR"
install -d -o root -g "$APP_USER" -m 750 "$CONF_DIR"
install -d -m 700 "$BACKUP_DIR"

step "Copying WinBig to $APP_DIR"
if [[ $SRC_DIR != "$APP_DIR" ]]; then
  run rsync -a --delete --exclude=/node_modules --exclude=/data --exclude=/.env --exclude=/.git "$SRC_DIR/" "$APP_DIR/"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

step "Saving settings in $CONF_FILE"
if [[ -n $DOMAIN ]]; then
  PUBLIC_URL="https://$DOMAIN"
  HOST=127.0.0.1 # only nginx talks to the app
else
  ip=$(hostname -I 2>/dev/null | awk '{ print $1 }' || true)
  PUBLIC_URL="http://${ip:-localhost}:$PORT"
  HOST=0.0.0.0
fi
if [[ ! -f $CONF_FILE ]]; then
  cat >"$CONF_FILE" <<EOF
# WinBig settings. After changing this file run:  sudo systemctl restart winbig
# The Yoco key and the website address can also be set in the admin panel (Admin > Payments),
# which takes priority over this file.
PORT=$PORT
HOST=$HOST
PUBLIC_URL=$PUBLIC_URL
DATA_DIR=$DATA_DIR
YOCO_SECRET_KEY=
YOCO_WEBHOOK_SECRET=
EOF
else
  set_conf PORT "$PORT"
  set_conf HOST "$HOST"
  set_conf PUBLIC_URL "$PUBLIC_URL"
  set_conf DATA_DIR "$DATA_DIR"
fi
chown root:"$APP_USER" "$CONF_FILE"
chmod 640 "$CONF_FILE"
ln -sfn "$CONF_FILE" "$APP_DIR/.env" # so helper scripts read the same settings
info "Website address: $PUBLIC_URL"

step "Installing WinBig's Node.js packages (this can take a minute)"
npm_env=(HOME="$HOME_DIR")
if [[ -n $NPM_PYTHON ]]; then npm_env+=(npm_config_python="$NPM_PYTHON"); fi
run runuser -u "$APP_USER" -- env "${npm_env[@]}" bash -c "cd '$APP_DIR' && npm ci --omit=dev --no-audit --no-fund"
run runuser -u "$APP_USER" -- bash -c "cd '$APP_DIR' && node -e \"require('better-sqlite3')(':memory:').prepare('select 1').get()\""

# ------------------------------------------------------------------ service

step "Setting up the WinBig service"
NODE_BIN=$(command -v node)
cat >"$SERVICE_FILE" <<EOF
[Unit]
Description=WinBig lucky draw website
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$CONF_FILE
Environment=NODE_ENV=production
ExecStart=$NODE_BIN server.js
Restart=always
RestartSec=3

# Security hardening: WinBig can only write to its own data folder.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$HOME_DIR
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
EOF
run systemctl daemon-reload
run systemctl enable winbig
run systemctl restart winbig

started=false
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/"; then
    started=true
    break
  fi
  sleep 1
done
if ! $started; then
  journalctl -u winbig -n 30 --no-pager >&2 || true
  die "WinBig did not start. The lines above show why."
fi
info "WinBig is running."

# ------------------------------------------------------------------ helper command

cat >"$HELPER" <<'HELPER_EOF'
#!/usr/bin/env bash
# WinBig server helper (installed by install.sh). Run it with sudo.
set -euo pipefail

APP_DIR=/opt/winbig
HOME_DIR=/var/lib/winbig
BACKUP_DIR=/var/backups/winbig
CONF_FILE=/etc/winbig/winbig.env

usage() {
  cat <<'USAGE'
Usage: sudo winbig <command>

  status        Is WinBig running?
  logs          Show the live log (press Ctrl+C to stop)
  restart       Restart WinBig
  setup-code    Show the one-time code for creating the admin password
  reset-admin   Forgot the admin password? Remove it so a new one can be created
  backup        Save the database and prize photos to /var/backups/winbig
  settings      Edit the settings file, then restart WinBig
USAGE
}

if [[ $EUID -ne 0 ]]; then
  echo "Please run with sudo, for example:  sudo winbig ${1:-status}"
  exit 1
fi
PORT=$(sed -n 's/^PORT=//p' "$CONF_FILE" | tail -n 1)

setup_code() {
  if ! curl -fsS "http://127.0.0.1:${PORT:-3000}/api/admin/setup" | grep -q '"needsSetup":true'; then
    echo "The admin password has already been created. If you forgot it, run:  sudo winbig reset-admin"
    return
  fi
  local code
  code=$(journalctl -u winbig --no-pager | grep -oE 'Admin setup code[^:]*: [A-F0-9]+' | tail -n 1 | awk '{ print $NF }' || true)
  echo "Open your website's /admin page to create the admin password."
  echo "When it asks for the setup code, enter:  ${code:-(not found - run: sudo winbig restart)}"
}

case ${1:-} in
  status) systemctl status winbig --no-pager ;;
  logs) journalctl -u winbig -f ;;
  restart)
    systemctl restart winbig
    echo "WinBig restarted."
    ;;
  setup-code) setup_code ;;
  reset-admin)
    runuser -u winbig -- bash -c "cd $APP_DIR && node scripts/reset-admin.js"
    systemctl restart winbig
    sleep 3
    setup_code
    ;;
  backup)
    stamp=$(date +%Y-%m-%d-%H%M%S)
    snapshot="backup-$stamp.db"
    # A safe copy of the live database (copying the file directly while WinBig runs can corrupt it).
    runuser -u winbig -- bash -c "cd $APP_DIR && node -e \"require('better-sqlite3')('$HOME_DIR/data/winbig.db').backup('$HOME_DIR/$snapshot').then(() => process.exit(0), (e) => { console.error(e); process.exit(1); })\""
    install -d -m 700 "$BACKUP_DIR"
    tar -czf "$BACKUP_DIR/winbig-$stamp.tar.gz" -C "$HOME_DIR" "$snapshot" data/uploads
    rm -f "${HOME_DIR:?}/$snapshot"
    chmod 600 "$BACKUP_DIR/winbig-$stamp.tar.gz"
    echo "Backup saved: $BACKUP_DIR/winbig-$stamp.tar.gz"
    ;;
  settings)
    "${EDITOR:-vi}" "$CONF_FILE"
    systemctl restart winbig
    echo "Settings saved and WinBig restarted."
    ;;
  *) usage ;;
esac
HELPER_EOF
chmod 755 "$HELPER"

# ------------------------------------------------------------------ firewall, nginx & HTTPS

firewall_on() { systemctl is-active --quiet firewalld; }
HTTPS_OK=false

if [[ -n $DOMAIN ]]; then
  step "Setting up nginx for $DOMAIN"
  run dnf -y install nginx
  # Only (re)write the nginx file for a new domain: certbot adds its HTTPS settings to this file.
  if [[ ! -f $NGINX_CONF ]] || ! grep -q "server_name $DOMAIN;" "$NGINX_CONF"; then
    cat >"$NGINX_CONF" <<EOF
# WinBig - created by install.sh
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    client_max_body_size 10m; # prize photo uploads

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
  fi
  if command -v getenforce >/dev/null 2>&1 && [[ $(getenforce) != Disabled ]]; then
    info "Allowing nginx to reach WinBig (SELinux)"
    run setsebool -P httpd_can_network_connect 1
  fi
  run nginx -t
  run systemctl enable --now nginx
  run systemctl reload nginx
  if firewall_on; then
    run firewall-cmd --permanent --add-service=http --add-service=https
    firewall-cmd --permanent --remove-port="$PORT/tcp" >>"$LOG" 2>&1 || true
    run firewall-cmd --reload
  fi

  step "Getting a free HTTPS certificate for $DOMAIN"
  run dnf -y install epel-release dnf-plugins-core
  if ((EL == 8)); then
    dnf config-manager --set-enabled powertools >>"$LOG" 2>&1 || true
  else
    dnf config-manager --set-enabled crb >>"$LOG" 2>&1 || true
  fi
  run dnf -y install certbot python3-certbot-nginx
  email_args=(--register-unsafely-without-email)
  if [[ -n $EMAIL ]]; then email_args=(--email "$EMAIL"); fi
  if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect --keep-until-expiring "${email_args[@]}" >>"$LOG" 2>&1; then
    systemctl enable --now certbot-renew.timer >>"$LOG" 2>&1 || true
    HTTPS_OK=true
    info "HTTPS is set up, and the certificate renews automatically."
  else
    warn "Could not get an HTTPS certificate yet."
    warn "This usually means $DOMAIN doesn't point to this server's IP address yet,"
    warn "or ports 80/443 are blocked by your hosting provider's firewall."
    warn "Fix that, then simply run this installer again."
  fi
elif firewall_on; then
  run firewall-cmd --permanent --add-port="$PORT/tcp"
  run firewall-cmd --reload
fi

# ------------------------------------------------------------------ summary

if [[ -n $DOMAIN ]]; then
  if $HTTPS_OK; then SITE="https://$DOMAIN"; else SITE="http://$DOMAIN"; fi
else
  SITE=$PUBLIC_URL
fi
needs_setup=false
if curl -fsS "http://127.0.0.1:$PORT/api/admin/setup" | grep -q '"needsSetup":true'; then needs_setup=true; fi
setup_code=$(journalctl -u winbig --no-pager -n 200 | grep -oE 'Admin setup code[^:]*: [A-F0-9]+' | tail -n 1 | awk '{ print $NF }' || true)

echo
echo "${G}${B}WinBig is installed and running!${N}"
echo
echo "  Website:       $SITE"
echo "  Admin panel:   $SITE/admin"
if $needs_setup; then
  echo "  ${B}First admin login:${N} open the admin panel to create your admin password."
  echo "                 It will ask for this one-time setup code:  ${B}${setup_code:-run: sudo winbig setup-code}${N}"
fi
echo
echo "  Settings:      $CONF_FILE"
echo "  Data:          $DATA_DIR  (database and prize photos)"
echo "  Install log:   $LOG"
echo
echo "  Handy commands:"
echo "    sudo winbig status        is it running?"
echo "    sudo winbig logs          live log"
echo "    sudo winbig restart       restart the website"
echo "    sudo winbig backup        back up the database and photos"
echo "    sudo winbig reset-admin   forgot the admin password"
echo
echo "  Update later:  cd $SRC_DIR && git pull && sudo bash install.sh"
if [[ -z $DOMAIN ]]; then
  echo
  warn "No domain was given, so the site runs without HTTPS on port $PORT."
  warn "Yoco needs HTTPS. When your domain points here, run:  sudo bash install.sh --domain your-domain.co.za --email you@example.com"
fi
echo
