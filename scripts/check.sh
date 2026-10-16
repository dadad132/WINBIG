#!/usr/bin/env bash
# WinBig health check: explains in plain words what works and what doesn't on this server.
# Run it with:  sudo winbig check      (or from the WinBig folder:  bash install.sh --check)
set -uo pipefail

CONF_FILE=/etc/winbig/winbig.env
NGINX_CONF=/etc/nginx/conf.d/winbig.conf

if [[ -t 1 ]]; then
  G=$'\e[32m' Y=$'\e[33m' R=$'\e[31m' B=$'\e[1m' N=$'\e[0m'
else
  G="" Y="" R="" B="" N=""
fi
PROBLEMS=0
good() { printf '  %s✔%s %s\n' "$G" "$N" "$*"; }
bad() {
  printf '  %s✘%s %s\n' "$R" "$N" "$*"
  PROBLEMS=$((PROBLEMS + 1))
}
tip() { printf '      %s→ %s%s\n' "$Y" "$*" "$N"; }
note() { printf '    %s\n' "$*"; }

finish() {
  echo
  if ((PROBLEMS == 0)); then
    echo "  ${G}${B}Everything looks good!${N} ${1:-}"
  else
    echo "  ${B}Found $PROBLEMS problem(s).${N} Fix the ✘ items above, then check again with:  sudo winbig check"
  fi
  echo
  exit 0
}

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root:  sudo winbig check"
  exit 1
fi

echo
echo "${B}Checking WinBig...${N}"

# ------------------------------------------------------------------ the app

if [[ ! -f $CONF_FILE ]]; then
  bad "WinBig is not installed yet"
  tip "From the WinBig folder run:  bash install.sh"
  finish
fi
PORT=$(sed -n 's/^PORT=//p' "$CONF_FILE" | tail -n 1)
PORT=${PORT:-3000}

if systemctl is-active --quiet winbig; then
  good "The WinBig service is running"
else
  bad "The WinBig service is not running"
  tip "Try:  sudo winbig restart     To see why it stopped:  sudo winbig logs"
fi
if curl -fsS -o /dev/null --max-time 5 "http://127.0.0.1:$PORT/"; then
  good "WinBig answers inside the server (port $PORT)"
else
  bad "WinBig doesn't answer inside the server (port $PORT)"
fi

# ------------------------------------------------------------------ domain & nginx

DOMAIN=""
if [[ -f $NGINX_CONF ]]; then
  DOMAIN=$(awk '$1 == "server_name" { gsub(";", "", $2); print $2; exit }' "$NGINX_CONF")
fi
if [[ -z $DOMAIN ]]; then
  bad "No domain name is set up yet, so the site only works on http://SERVER-IP:$PORT"
  tip "From the WinBig folder run:  bash install.sh   (it will ask for your domain)"
  finish
fi
good "Domain name: $DOMAIN"

if systemctl is-active --quiet nginx; then
  good "nginx (the web server for your domain) is running"
else
  bad "nginx (the web server for your domain) is not running"
  tip "Try:  systemctl restart nginx     To see why:  journalctl -u nginx -n 20"
fi

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H "Host: $DOMAIN" http://127.0.0.1/ || true)
if [[ $code =~ ^(200|301|302|308)$ ]]; then
  good "nginx passes $DOMAIN on to WinBig"
else
  bad "nginx doesn't pass $DOMAIN on to WinBig (got HTTP ${code:-no answer})"
  if command -v getenforce >/dev/null 2>&1 && [[ $(getenforce) == Enforcing ]] &&
    ! getsebool httpd_can_network_connect 2>/dev/null | grep -q ' on$'; then
    tip "SELinux is blocking it. Run:  setsebool -P httpd_can_network_connect 1"
  fi
fi

# ------------------------------------------------------------------ DNS

SERVER_IP=$(curl -4 -fsS --max-time 6 https://api.ipify.org 2>/dev/null || true)
DNS_V4=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{ print $1 }' | sort -u | xargs)
DNS_V6=$(getent ahostsv6 "$DOMAIN" 2>/dev/null | awk '$1 !~ /^::ffff:/ { print $1 }' | sort -u | xargs)

if [[ -z $DNS_V4 ]]; then
  bad "$DOMAIN doesn't point to any server yet (no DNS \"A record\" found)"
  ip_text=${SERVER_IP:-"this server's IP address"}
  tip "At the company where you bought the domain, add an A record for $DOMAIN pointing to $ip_text."
  tip "DNS changes can take from a few minutes up to a few hours to work."
elif [[ -n $SERVER_IP && " $DNS_V4 " != *" $SERVER_IP "* ]]; then
  bad "$DOMAIN points to $DNS_V4, but this server's IP address is $SERVER_IP"
  tip "Change the A record for $DOMAIN to $SERVER_IP (where you bought the domain)."
else
  good "$DOMAIN points to this server (${DNS_V4})"
fi
if [[ -n $DNS_V6 ]]; then
  server_v6=$(curl -6 -fsS --max-time 6 https://api64.ipify.org 2>/dev/null || true)
  if [[ -z $server_v6 || " $DNS_V6 " != *" $server_v6 "* ]]; then
    bad "$DOMAIN also has an IPv6 (\"AAAA\") record ($DNS_V6) that isn't this server"
    tip "Delete the AAAA record for $DOMAIN. HTTPS certificates check IPv6 first, so a wrong one makes them fail."
  fi
fi

if [[ $DOMAIN != www.* && -n $DNS_V4 ]] && grep -q "server_name" "$NGINX_CONF" && ! grep -q "www.$DOMAIN" "$NGINX_CONF"; then
  www_v4=$(getent ahostsv4 "www.$DOMAIN" 2>/dev/null | awk '{ print $1 }' | sort -u | xargs)
  if [[ -n $www_v4 && $www_v4 == "$DNS_V4" ]]; then
    bad "www.$DOMAIN points here but isn't set up on this server yet"
    tip "From the WinBig folder run:  git pull && bash install.sh"
  fi
fi

# ------------------------------------------------------------------ firewall & reachability

if systemctl is-active --quiet firewalld; then
  services=" $(firewall-cmd --list-services 2>/dev/null) "
  if [[ $services == *" http "* && $services == *" https "* ]]; then
    good "The server's firewall lets web visitors in (ports 80 and 443)"
  else
    bad "The server's firewall blocks web visitors"
    tip "Run:  firewall-cmd --permanent --add-service=http --add-service=https && firewall-cmd --reload"
  fi
fi

if [[ -n $SERVER_IP ]]; then
  if curl -s -o /dev/null --max-time 8 --resolve "$DOMAIN:80:$SERVER_IP" "http://$DOMAIN/"; then
    good "The website can be reached on the server's public address ($SERVER_IP)"
  else
    bad "The website can't be reached on the server's public address ($SERVER_IP)"
    tip "Your hosting company probably has its own firewall in their control panel."
    tip "Open ports 80 (HTTP) and 443 (HTTPS) there for incoming traffic."
  fi
fi

# ------------------------------------------------------------------ HTTPS certificate

CERT=/etc/letsencrypt/live/$DOMAIN/fullchain.pem
if [[ -f $CERT ]]; then
  expires=$(openssl x509 -enddate -noout -in "$CERT" 2>/dev/null | cut -d= -f2)
  good "HTTPS certificate installed (valid until $(date -d "$expires" '+%d %B %Y' 2>/dev/null || echo "$expires"))"
  if systemctl is-active --quiet certbot-renew.timer; then
    good "The certificate renews automatically"
  else
    bad "Automatic certificate renewal is switched off"
    tip "Run:  systemctl enable --now certbot-renew.timer"
  fi
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/" || true)
  if [[ $code == 200 ]]; then
    good "https://$DOMAIN works"
  else
    bad "https://$DOMAIN doesn't work (got HTTP ${code:-no answer})"
  fi
else
  bad "There is no HTTPS certificate yet"
  tip "When the ✘ items above are fixed, run the installer again from the WinBig folder:  bash install.sh"
  if [[ -f /var/log/letsencrypt/letsencrypt.log ]]; then
    reason=$(grep -oE 'Detail: .*' /var/log/letsencrypt/letsencrypt.log | tail -n 1)
    if [[ -n $reason ]]; then note "Last certificate error from Let's Encrypt: ${reason#Detail: }"; fi
  fi
fi

finish "Your site: https://$DOMAIN  (admin panel: https://$DOMAIN/admin)"
