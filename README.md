# 📊 AccountingOS

> Веб-сервис финансового учёта с автоотчётами в Telegram

![Node.js](https://img.shields.io/badge/Node.js-20.x-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express-4.x-000000?style=flat-square&logo=express)
![SQLite](https://img.shields.io/badge/SQLite-3-003B57?style=flat-square&logo=sqlite)
![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)

**Ведёт учёт доходов, расходов и инкассации. Каждый день автоматически отправляет отчёт в Telegram в виде PDF + Excel.**

---

## ⚡ Установка одной командой

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/ChernOvOne/buh_baza/main/setup.sh)
```

> Скрипт сам установит Node.js, Nginx, выпустит SSL-сертификат и запустит сервис.

---

## 📸 Что выглядит

| Вход | Дашборд | Расходы |
|---|---|---|
| Страница с паролем | KPI-карточки + графики | Таблица с категориями |

---

## 🗂 Структура проекта

```
buh_baza/
├── app.js                   # Express-сервер + cron-расписание
├── setup.sh                 # Скрипт установки и CLI-меню
├── package.json
├── database/
│   └── db.js                # SQLite: таблицы daily, expenses, ads, investments
├── middleware/
│   └── auth.js              # JWT-аутентификация
├── routes/
│   └── api.js               # REST API с JWT-защитой
├── services/
│   ├── telegram.js          # Отправка отчётов в Telegram
│   ├── pdf.js               # Генерация PDF (тёмная тема, кириллица)
│   └── excel.js             # Генерация Excel (3 листа, стили)
└── public/
    ├── login.html           # Страница входа
    └── index.html           # SPA-дашборд (Chart.js)
```

---

## ✅ Функционал

### Сайт
- 🔐 Защита паролем (bcrypt + JWT, сессия 30 дней)
- 🏠 **Дашборд** — KPI-карточки, графики выручки и расходов по категориям
- 📅 **Ежедневник** — ввод дохода / расхода / инкассации (Артём, Роман, Михаил)
- 💸 **Расходы со счёта** — категории: Реклама, Сервера, LeadTex, ФНС, ТГ Прем, СКАМ
- 📣 **Реклама** — трекер кампаний (формат, канал, подписчики, цена/подп.)
- 📈 **Статистика** — сравнение месяцев, рост выручки

### Telegram-отчёты
- 📄 **PDF** — красивый отчёт с KPI-карточками (тёмная тема)
- 📊 **Excel** — 3 листа: ежедневные данные, расходы, сводка за месяц
- ⏰ **Автоматически** — каждый день в заданное время
- ⚡ **По кнопке** — отправить прямо с сайта в любой момент

---

## 🚀 Установка вручную

```bash
# 1. Клонируй репозиторий
git clone https://github.com/ChernOvOne/buh_baza.git
cd buh_baza

# 2. Запусти установщик
chmod +x setup.sh
sudo ./setup.sh

# В меню выбери [1] Установить
```

### Что спросит установщик

| Параметр | Где взять |
|---|---|
| Порт | По умолчанию 3000 |
| Пароль | Придумай любой |
| Bot Token | [@BotFather](https://t.me/BotFather) → `/newbot` |
| Channel ID | Добавь бота в канал как admin → [@getidsbot](https://t.me/getidsbot) |
| Поддомен | Например `buh.mysite.ru` (DNS → IP сервера) |
| Email | Для Let's Encrypt уведомлений |

---

## 🛠 CLI-меню управления

```bash
sudo ./setup.sh
```

```
  ╔══════════════════════════════════════════════╗
  ║         AccountingOS  •  v1.0                ║
  ╚══════════════════════════════════════════════╝

  Статус:  ● Работает
  Сайт:    https://buh.mysite.ru

  Сервис:
  [1]  Установить / Переустановить
  [2]  Обновить с GitHub
  [3]  Запустить
  [4]  Остановить
  [5]  Перезапустить
  [6]  Просмотр логов

  Конфигурация:
  [7]  Изменить пароль
  [8]  Изменить Telegram настройки
  [9]  Выпустить / обновить SSL-сертификат
  [10] Изменить порт
  [11] Показать конфиг

  База данных:
  [12] Бэкап
  [13] Восстановить
  [14] Статистика
```

### Быстрые команды

```bash
sudo ./setup.sh --install    # Установка
sudo ./setup.sh --update     # Обновить с GitHub
sudo ./setup.sh --restart    # Перезапустить
sudo ./setup.sh --logs       # Логи в реальном времени
sudo ./setup.sh --ssl        # Выпустить/обновить SSL
sudo ./setup.sh --status     # Статус сервиса
```

---

## 🌐 Настройка DNS

Перед выпуском SSL у регистратора домена добавь A-запись:

```
Тип:  A
Имя:  buh        (или любой поддомен)
IP:   XX.XX.XX.XX   (IP твоего VPS)
TTL:  300
```

После этого запусти пункт **[9] Выпустить SSL** или:

```bash
sudo certbot --nginx -d buh.mysite.ru --redirect
```

---

## 📋 Требования к VPS

| | Минимум |
|---|---|
| ОС | Ubuntu 20.04 / Debian 11 |
| RAM | 512 MB |
| Диск | 1 GB |
| Порты | 80, 443 |

---

## 📁 База данных

SQLite, хранится в `/opt/accounting-service/data/accounting.db`

```bash
# Бэкап вручную
cp /opt/accounting-service/data/accounting.db ~/backup_$(date +%Y%m%d).db

# Просмотр логов
tail -f /var/log/accounting-service.log
```

---

## 📬 Пример Telegram-сообщения

```
📊 ЕЖЕДНЕВНЫЙ ОТЧЁТ
━━━━━━━━━━━━━━━━━━━━━
📅 Дата: 2026-03-21

💰 Доход:     19 761.45 ₽
💸 Расход:     1 500.00 ₽
✅ Чистый:    18 261.45 ₽

👥 Инкассация:
  • Артём:     5 000.00 ₽
  • Роман:    28 000.00 ₽
  • Михаил:   12 000.00 ₽
  ━━ Итого:   45 000.00 ₽

🧾 Расходы со счёта (1 шт.):
  • Сервера: Fornex — 737.10 ₽
━━━━━━━━━━━━━━━━━━━━━
🤖 AccountingService
```

> + прикрепляется PDF и Excel файлы

---

## 🔄 Обновление

```bash
sudo ./setup.sh --update
# или в меню: [2] Обновить с GitHub
```

БД и `.env` сохраняются при обновлении автоматически.

---

## License

MIT
