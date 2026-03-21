#!/bin/bash
# ============================================================
#  AccountingOS — Setup & Management Script
#
#  Одна команда для установки с GitHub:
#  bash <(curl -fsSL https://raw.githubusercontent.com/ChernOvOne/buh_baza/main/setup.sh)
# ============================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

REPO_URL="https://github.com/ChernOvOne/buh_baza.git"
APP_DIR="/opt/accounting-service"
SERVICE_NAME="accounting"
LOG_FILE="/var/log/accounting-service.log"
NODE_MIN=18

# ────────────────────────────────────────────────────────────
print_banner() {
  clear
  echo -e "${CYAN}"
  echo "  ╔══════════════════════════════════════════════╗"
  echo "  ║         AccountingOS  •  v1.0                ║"
  echo "  ║      Finance Dashboard Management            ║"
  echo "  ╚══════════════════════════════════════════════╝"
  echo -e "${NC}"
}

log_ok()   { echo -e "  ${GREEN}✓${NC}  $1"; }
log_err()  { echo -e "  ${RED}✗${NC}  $1"; }
log_info() { echo -e "  ${CYAN}→${NC}  $1"; }
log_warn() { echo -e "  ${YELLOW}!${NC}  $1"; }
log_step() { echo -e "\n  ${BOLD}── $1${NC}"; }

require_root() {
  if [ "$EUID" -ne 0 ]; then
    log_err "Запусти с sudo: sudo $0"
    exit 1
  fi
}

# ────────────────────────────────────────────────────────────
#  Определяем откуда запущены (curl|bash или git clone)
# ────────────────────────────────────────────────────────────
ensure_repo() {
  if [ -f "${BASH_SOURCE[0]%/*}/app.js" ]; then
    SCRIPT_DIR="$(cd "${BASH_SOURCE[0]%/*}" && pwd)"
    log_ok "Используем локальные файлы: $SCRIPT_DIR"
    return 0
  fi

  log_info "Клонирую репозиторий с GitHub..."
  if ! command -v git &>/dev/null; then
    apt-get update -qq && apt-get install -y -qq git
  fi

  TMP_DIR=$(mktemp -d)
  git clone --depth=1 "$REPO_URL" "$TMP_DIR/buh_baza" 2>&1 | tail -1

  if [ ! -f "$TMP_DIR/buh_baza/app.js" ]; then
    log_err "Не удалось скачать репозиторий с $REPO_URL"
    exit 1
  fi

  SCRIPT_DIR="$TMP_DIR/buh_baza"
  log_ok "Репозиторий скачан"
}

# ────────────────────────────────────────────────────────────
install_node() {
  log_step "Node.js"
  if command -v node &>/dev/null; then
    VER=$(node -v | tr -d 'v' | cut -d. -f1)
    if [ "$VER" -ge "$NODE_MIN" ]; then
      log_ok "Уже установлен: $(node -v)"; return
    fi
    log_warn "Старая версия ($(node -v)), обновляю..."
  fi
  log_info "Устанавливаю Node.js 20.x..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y nodejs >/dev/null 2>&1
  log_ok "Node.js $(node -v)"
}

install_deps() {
  log_step "Системные зависимости"
  apt-get update -qq
  apt-get install -y -qq curl git nginx certbot python3-certbot-nginx \
    fonts-dejavu-core fontconfig sqlite3 ufw rsync
  log_ok "Nginx, Certbot, шрифты (кириллица), sqlite3 — OK"
}

deploy_app() {
  log_step "Деплой файлов приложения"
  mkdir -p "$APP_DIR/data"

  if command -v rsync &>/dev/null; then
    rsync -a --exclude='node_modules' --exclude='.git' \
      --exclude='data' --exclude='.env' \
      "${SCRIPT_DIR}/" "$APP_DIR/"
  else
    cp -r "${SCRIPT_DIR}/." "$APP_DIR/"
  fi

  cd "$APP_DIR"
  log_info "npm install..."
  npm install --omit=dev --silent
  log_ok "Приложение развёрнуто в $APP_DIR"
}

configure_env() {
  log_step "Конфигурация"

  if [ -f "$APP_DIR/.env" ]; then
    read -rp "  .env уже существует. Перезаписать? (y/n): " OW
    [[ "$OW" =~ ^[Yy]$ ]] || return
  fi

  echo ""
  read -rp "  Порт приложения (по умолч. 3000): " PORT
  PORT=${PORT:-3000}

  read -rsp "  Пароль для входа на сайт: " ADMIN_PASS; echo
  while [ -z "$ADMIN_PASS" ]; do
    echo -e "  ${RED}Пустой пароль!${NC}"
    read -rsp "  Пароль: " ADMIN_PASS; echo
  done

  echo ""
  read -rp "  Telegram Bot Token (от @BotFather): " TG_TOKEN
  read -rp "  Telegram Channel ID (например -100xxxxxxxx): " TG_CHAT

  read -rp "  Час отправки отчёта (МСК, по умолч. 21): " REPORT_H
  REPORT_H=${REPORT_H:-21}
  REPORT_UTC=$(( (REPORT_H - 3 + 24) % 24 ))

  JWT_SECRET=$(openssl rand -hex 32)

  cat > "$APP_DIR/.env" <<ENVEOF
PORT=$PORT
JWT_SECRET=$JWT_SECRET
ADMIN_PASSWORD=$ADMIN_PASS
TG_BOT_TOKEN=$TG_TOKEN
TG_CHANNEL_ID=$TG_CHAT
REPORT_HOUR=$REPORT_UTC
REPORT_MINUTE=0
ENVEOF

  chmod 600 "$APP_DIR/.env"
  log_ok ".env создан (порт: $PORT, отчёт: ${REPORT_H}:00 МСК = ${REPORT_UTC}:00 UTC)"
}

setup_systemd() {
  log_step "systemd сервис"

  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<SVCEOF
[Unit]
Description=AccountingOS Finance Dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=$(which node) $APP_DIR/app.js
Restart=on-failure
RestartSec=5
User=root
StandardOutput=append:$LOG_FILE
StandardError=append:$LOG_FILE
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
SVCEOF

  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null 2>&1
  systemctl restart "$SERVICE_NAME"
  sleep 2

  if systemctl is-active --quiet "$SERVICE_NAME"; then
    log_ok "Сервис запущен и добавлен в автозагрузку"
  else
    log_err "Сервис не стартовал — проверь: journalctl -u ${SERVICE_NAME} -n 30"
  fi
}

# ────────────────────────────────────────────────────────────
#  NGINX + SSL (Let's Encrypt)
# ────────────────────────────────────────────────────────────
setup_nginx_ssl() {
  log_step "Nginx + SSL (Let's Encrypt)"

  APP_PORT=$(grep '^PORT=' "$APP_DIR/.env" 2>/dev/null | cut -d= -f2)
  APP_PORT=${APP_PORT:-3000}

  echo ""
  echo -e "  ${DIM}Введи поддомен без www и без https://${NC}"
  echo -e "  ${DIM}Пример: buh.mysite.ru${NC}"
  echo -e "  ${DIM}DNS A-запись должна уже указывать на IP этого VPS!${NC}"
  echo ""
  read -rp "  Поддомен: " SUBDOMAIN

  NGINX_CONF="/etc/nginx/sites-available/$SERVICE_NAME"

  if [ -z "$SUBDOMAIN" ]; then
    # Без домена — просто проксируем на 80
    cat > "$NGINX_CONF" <<NGINX
server {
    listen 80 default_server;
    server_name _;
    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_cache_bypass \$http_upgrade;
        client_max_body_size 20M;
    }
}
NGINX
    rm -f /etc/nginx/sites-enabled/default
    ln -sf "$NGINX_CONF" "/etc/nginx/sites-enabled/$SERVICE_NAME"
    nginx -t >/dev/null 2>&1 && systemctl reload nginx
    log_warn "Поддомен не задан — сайт доступен по IP: http://$(curl -s ifconfig.me 2>/dev/null)"
    echo "http://$(curl -s ifconfig.me 2>/dev/null)" > "$APP_DIR/.site_url"
    return
  fi

  # HTTP-конфиг (нужен для certbot challenge)
  cat > "$NGINX_CONF" <<NGINX
server {
    listen 80;
    server_name ${SUBDOMAIN};

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        client_max_body_size 20M;
    }
}
NGINX

  rm -f /etc/nginx/sites-enabled/default 2>/dev/null
  ln -sf "$NGINX_CONF" "/etc/nginx/sites-enabled/$SERVICE_NAME"
  nginx -t >/dev/null 2>&1 && systemctl reload nginx
  log_ok "Nginx настроен для $SUBDOMAIN"

  # Firewall
  ufw allow 80/tcp  >/dev/null 2>&1
  ufw allow 443/tcp >/dev/null 2>&1
  ufw --force enable >/dev/null 2>&1
  log_ok "Порты 80 и 443 открыты"

  # SSL
  echo ""
  echo -e "  ${YELLOW}Следующий шаг — выпуск SSL-сертификата от Let's Encrypt.${NC}"
  echo -e "  ${DIM}Требование: ${SUBDOMAIN} уже должен вести на IP этого сервера.${NC}"
  echo ""
  read -rp "  DNS настроен и уже работает? Выпустить сертификат? (y/n): " DO_SSL

  if [[ "$DO_SSL" =~ ^[Yy]$ ]]; then
    read -rp "  Email для Let's Encrypt (уведомления об истечении): " LE_EMAIL

    log_info "Запрашиваю сертификат..."
    certbot --nginx \
      -d "$SUBDOMAIN" \
      --non-interactive \
      --agree-tos \
      --email "$LE_EMAIL" \
      --redirect \
      2>&1 | grep -E "(Congratulations|error|Error|failed|Successfully|Certificate)" || true

    if certbot certificates 2>/dev/null | grep -q "$SUBDOMAIN"; then
      log_ok "SSL-сертификат выпущен для $SUBDOMAIN!"

      # Автообновление через cron
      CRON_JOB="0 3 * * * certbot renew --quiet --post-hook 'systemctl reload nginx'"
      (crontab -l 2>/dev/null | grep -v 'certbot renew'; echo "$CRON_JOB") | crontab -
      log_ok "Автообновление сертификата: ежедневно в 3:00"

      echo "https://$SUBDOMAIN" > "$APP_DIR/.site_url"
    else
      log_warn "Сертификат не выпущен (возможно DNS ещё не обновился)"
      log_warn "Попробуй позже: sudo certbot --nginx -d $SUBDOMAIN --redirect"
      echo "http://$SUBDOMAIN" > "$APP_DIR/.site_url"
    fi
  else
    log_warn "SSL пропущен. Выпусти позже через меню [9] или:"
    log_warn "  sudo certbot --nginx -d $SUBDOMAIN --redirect"
    echo "http://$SUBDOMAIN" > "$APP_DIR/.site_url"
  fi
}

# ────────────────────────────────────────────────────────────
#  ПОЛНАЯ УСТАНОВКА
# ────────────────────────────────────────────────────────────
install_all() {
  print_banner
  echo -e "${BOLD}  ══ Установка AccountingOS ══${NC}"
  echo -e "${DIM}  $REPO_URL${NC}\n"

  require_root
  ensure_repo
  install_node
  install_deps
  deploy_app
  configure_env
  setup_systemd
  setup_nginx_ssl

  SITE_URL=$(cat "$APP_DIR/.site_url" 2>/dev/null || echo "http://$(hostname -I | awk '{print $1}')")

  echo ""
  echo -e "${GREEN}${BOLD}"
  echo "  ╔══════════════════════════════════════════════╗"
  echo "  ║       ✓  Установка завершена!               ║"
  echo "  ╚══════════════════════════════════════════════╝"
  echo -e "${NC}"
  echo -e "  ${CYAN}Сайт:${NC}  ${BOLD}${SITE_URL}${NC}"
  echo -e "  ${CYAN}Логи:${NC}  tail -f $LOG_FILE"
  echo -e "  ${CYAN}Меню:${NC}  sudo ./setup.sh"
  echo ""
  read -rp "  Нажми Enter..."
}

# ────────────────────────────────────────────────────────────
#  ОБНОВЛЕНИЕ С GITHUB
# ────────────────────────────────────────────────────────────
update_from_git() {
  require_root
  log_step "Обновление с GitHub"

  TMP=$(mktemp -d)
  log_info "Скачиваю последнюю версию..."
  git clone --depth=1 "$REPO_URL" "$TMP/buh_baza" 2>&1 | tail -1

  if [ ! -f "$TMP/buh_baza/app.js" ]; then
    log_err "Не удалось скачать репозиторий"; rm -rf "$TMP"; sleep 2; return
  fi

  # Бэкап
  [ -f "$APP_DIR/data/accounting.db" ] && \
    cp "$APP_DIR/data/accounting.db" "/tmp/accounting_pre_update_$(date +%Y%m%d%H%M).db"

  systemctl stop "$SERVICE_NAME"

  rsync -a --exclude='node_modules' --exclude='.git' \
    --exclude='data' --exclude='.env' \
    "$TMP/buh_baza/" "$APP_DIR/"

  cd "$APP_DIR" && npm install --omit=dev --silent
  systemctl start "$SERVICE_NAME"
  sleep 2

  if systemctl is-active --quiet "$SERVICE_NAME"; then
    log_ok "Обновление успешно! БД и .env сохранены."
  else
    log_err "Сервис не стартовал: journalctl -u $SERVICE_NAME -n 20"
  fi

  rm -rf "$TMP"
  sleep 2
}

# ────────────────────────────────────────────────────────────
#  ВЫПУСК/ПЕРЕВЫПУСК SSL
# ────────────────────────────────────────────────────────────
renew_ssl() {
  require_root
  log_step "Выпуск / обновление SSL"

  APP_PORT=$(grep '^PORT=' "$APP_DIR/.env" 2>/dev/null | cut -d= -f2)
  APP_PORT=${APP_PORT:-3000}

  read -rp "  Поддомен (например buh.mysite.ru): " SUBDOMAIN
  read -rp "  Email для Let's Encrypt: " LE_EMAIL

  NGINX_CONF="/etc/nginx/sites-available/$SERVICE_NAME"
  cat > "$NGINX_CONF" <<NGINX
server {
    listen 80;
    server_name ${SUBDOMAIN};
    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        client_max_body_size 20M;
    }
}
NGINX

  ln -sf "$NGINX_CONF" "/etc/nginx/sites-enabled/$SERVICE_NAME"
  nginx -t >/dev/null 2>&1 && systemctl reload nginx

  certbot --nginx -d "$SUBDOMAIN" --non-interactive --agree-tos \
    --email "$LE_EMAIL" --redirect 2>&1 | \
    grep -E "(Congratulations|error|Error|failed|Successfully|Certificate)" || true

  if certbot certificates 2>/dev/null | grep -q "$SUBDOMAIN"; then
    log_ok "https://$SUBDOMAIN — сертификат выпущен!"
    echo "https://$SUBDOMAIN" > "$APP_DIR/.site_url"
  else
    log_err "Не удалось. Проверь что DNS $SUBDOMAIN → IP этого сервера."
  fi
  sleep 3
}

# ────────────────────────────────────────────────────────────
#  МЕНЮ
# ────────────────────────────────────────────────────────────
show_menu() {
  while true; do
    print_banner

    if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
      STATUS="${GREEN}● Работает${NC}"
    else
      STATUS="${RED}● Остановлен${NC}"
    fi

    SITE_URL=$(cat "$APP_DIR/.site_url" 2>/dev/null || echo "не настроен")

    echo -e "  Статус:  ${STATUS}"
    echo -e "  Сайт:    ${CYAN}${SITE_URL}${NC}"
    echo ""
    echo -e "  ${BOLD}Сервис:${NC}"
    echo "  [1]  Установить / Переустановить"
    echo "  [2]  Обновить с GitHub"
    echo "  [3]  Запустить"
    echo "  [4]  Остановить"
    echo "  [5]  Перезапустить"
    echo "  [6]  Просмотр логов"
    echo ""
    echo -e "  ${BOLD}Конфигурация:${NC}"
    echo "  [7]  Изменить пароль"
    echo "  [8]  Изменить Telegram настройки"
    echo "  [9]  Выпустить / обновить SSL-сертификат"
    echo "  [10] Изменить порт"
    echo "  [11] Показать конфиг"
    echo ""
    echo -e "  ${BOLD}База данных:${NC}"
    echo "  [12] Бэкап"
    echo "  [13] Восстановить"
    echo "  [14] Статистика"
    echo ""
    echo "  [0]  Выход"
    echo ""
    read -rp "  Выбери: " C

    case "$C" in
      1)  install_all ;;
      2)  update_from_git ;;
      3)  require_root; systemctl start "$SERVICE_NAME"; log_ok "Запущен"; sleep 1 ;;
      4)  require_root; systemctl stop "$SERVICE_NAME"; log_ok "Остановлен"; sleep 1 ;;
      5)  require_root; systemctl restart "$SERVICE_NAME"; sleep 2
          systemctl is-active --quiet "$SERVICE_NAME" && log_ok "OK" || log_err "Ошибка"; sleep 1 ;;
      6)  echo -e "  ${CYAN}Ctrl+C для выхода${NC}"; sleep 0.5
          tail -f "$LOG_FILE" 2>/dev/null || journalctl -u "$SERVICE_NAME" -f ;;
      7)  require_root
          read -rsp "  Новый пароль: " P; echo
          [ -n "$P" ] && [ -f "$APP_DIR/.env" ] && \
            sed -i "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=${P}/" "$APP_DIR/.env" && \
            systemctl restart "$SERVICE_NAME" && log_ok "Готово" || log_err "Ошибка"
          sleep 2 ;;
      8)  require_root
          read -rp "  Bot Token: " T; read -rp "  Chat ID: " CH
          [ -f "$APP_DIR/.env" ] && \
            sed -i "s|^TG_BOT_TOKEN=.*|TG_BOT_TOKEN=${T}|" "$APP_DIR/.env" && \
            sed -i "s|^TG_CHANNEL_ID=.*|TG_CHANNEL_ID=${CH}|" "$APP_DIR/.env" && \
            systemctl restart "$SERVICE_NAME" && log_ok "Telegram обновлён" || log_err "Ошибка"
          sleep 2 ;;
      9)  renew_ssl ;;
      10) require_root
          read -rp "  Новый порт: " P
          [ -n "$P" ] && [ -f "$APP_DIR/.env" ] && \
            sed -i "s/^PORT=.*/PORT=${P}/" "$APP_DIR/.env" && \
            systemctl restart "$SERVICE_NAME" && log_ok "Порт: $P" || log_err "Ошибка"
          sleep 2 ;;
      11) echo ""
          [ -f "$APP_DIR/.env" ] && \
            sed 's/\(ADMIN_PASSWORD=\).*/\1[СКРЫТО]/' "$APP_DIR/.env" | \
            sed 's/\(JWT_SECRET=\).*/\1[СКРЫТО]/' | \
            sed 's/\(TG_BOT_TOKEN=\).*/\1[СКРЫТО]/' || log_err ".env не найден"
          echo ""; read -rp "  Enter..." ;;
      12) BD="/opt/accounting-backups"; mkdir -p "$BD"
          BF="$BD/accounting_$(date +%Y%m%d_%H%M%S).db"
          [ -f "$APP_DIR/data/accounting.db" ] && \
            cp "$APP_DIR/data/accounting.db" "$BF" && log_ok "Бэкап: $BF" || log_err "БД не найдена"
          sleep 2 ;;
      13) ls /opt/accounting-backups/*.db 2>/dev/null || log_warn "Нет бэкапов"
          read -rp "  Путь к файлу: " RF
          [ -f "$RF" ] && systemctl stop "$SERVICE_NAME" && \
            cp "$RF" "$APP_DIR/data/accounting.db" && \
            systemctl start "$SERVICE_NAME" && log_ok "Восстановлено" || log_err "Файл не найден"
          sleep 2 ;;
      14) [ -f "$APP_DIR/data/accounting.db" ] && {
            log_info "Размер: $(du -sh "$APP_DIR/data/accounting.db" | cut -f1)"
            sqlite3 "$APP_DIR/data/accounting.db" \
              "SELECT 'daily_entries: '||COUNT(*) FROM daily_entries;
               SELECT 'account_expenses: '||COUNT(*) FROM account_expenses;
               SELECT 'ads: '||COUNT(*) FROM ads;" 2>/dev/null
          } || log_err "БД не найдена"
          sleep 3 ;;
      0)  echo ""; exit 0 ;;
      *)  log_warn "Неверный пункт"; sleep 1 ;;
    esac
  done
}

# ── ENTRY POINT ──────────────────────────────────────────────
case "${1:-}" in
  --install)  require_root; ensure_repo; install_all ;;
  --update)   require_root; update_from_git ;;
  --restart)  require_root; systemctl restart "$SERVICE_NAME" ;;
  --logs)     tail -f "$LOG_FILE" ;;
  --ssl)      renew_ssl ;;
  --status)   systemctl status "$SERVICE_NAME" ;;
  *)          show_menu ;;
esac
