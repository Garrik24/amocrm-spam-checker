# amoCRM Spam Checker 🚫📞

Сервис автоматической проверки входящих звонков на спам через SpravPortal API.

При обнаружении спама автоматически переводит сделку в статус "СПАМ" в amoCRM.

## 🎯 Что делает сервис?

```
Входящий звонок → Webhook → Проверка номера → СПАМ? → Да → Перевод в статус СПАМ
                                                  → Нет → Примечание "Номер чистый"
```

1. Получает webhook с номером телефона и ID сделки
2. Проверяет номер через [SpravPortal API](https://www.spravportal.ru/)
3. Если **СПАМ** → переводит сделку в статус "СПАМ" + добавляет примечание
4. Если **чистый** → добавляет примечание в карточку сделки

## 🚀 Быстрый старт на Railway

### 1. Форкните репозиторий на GitHub

### 2. Создайте проект на Railway
1. Зайдите на [railway.app](https://railway.app)
2. New Project → Deploy from GitHub repo
3. Выберите ваш репозиторий

### 3. Добавьте переменные окружения
В Railway: Settings → Variables → Add

| Переменная | Описание | Пример |
|------------|----------|--------|
| `SPRAVPORTAL_API_KEY` | Ключ API SpravPortal | `test-X1R7B8VQM2KC` |
| `AMOCRM_DOMAIN` | Домен amoCRM | `https://stavgeo26.amocrm.ru` |
| `AMOCRM_ACCESS_TOKEN` | Токен доступа amoCRM | `eyJ0eXAi...` |
| `AMOCRM_SPAM_STATUS_ID` | ID статуса СПАМ | `12345678` |
| `AMOCRM_SPAM_PIPELINE_ID` | ID воронки со статусом СПАМ | `1234567` |
| `SPAM_THRESHOLD` | Порог спама (0-100) | `50` |

### 4. Получите URL сервиса
После деплоя Railway даст вам URL вида:
```
https://your-app-name.up.railway.app
```

### 5. Настройте Webhook в amoCRM или Make.com
Используйте URL: `https://your-app.up.railway.app/webhook/check-spam`

## 📡 API Endpoints

### `POST /webhook/check-spam`
Основной webhook для проверки номера.

**Request:**
```json
{
  "phone": "79001234567",
  "lead_id": 12345
}
```

**Response (СПАМ):**
```json
{
  "success": true,
  "status": "SPAM",
  "phone": "79001234567",
  "spamScore": 85,
  "category": "Телефонное мошенничество",
  "message": "Сделка 12345 переведена в статус СПАМ"
}
```

**Response (Чистый):**
```json
{
  "success": true,
  "status": "CLEAN",
  "phone": "79001234567",
  "spamScore": 10,
  "message": "Номер чистый, примечание добавлено"
}
```

---

### `POST /webhook/amocrm`
Webhook в формате amoCRM Digital Pipeline.

---

### `GET /test/check?phone=79001234567`
Тестовая проверка номера (без записи в amoCRM).

**Response:**
```json
{
  "success": true,
  "result": {
    "phone": "79001234567",
    "isSpam": false,
    "spamScore": 10,
    "category": "unknown",
    "reviewsCount": 0,
    "organization": null,
    "region": "Краснодарский край",
    "operator": "МегаФон"
  }
}
```

---

### `GET /`
Статус сервиса и информация о конфигурации.

---

### `GET /health`
Health check для мониторинга.

## 🔧 Как узнать ID статуса и воронки в amoCRM

### ID воронки (pipeline_id):
1. Откройте amoCRM → Сделки
2. Выберите нужную воронку
3. Посмотрите URL: `/leads/pipeline/**1234567**/`

### ID статуса (status_id):
1. Откройте любую сделку в нужном статусе
2. В URL найдите: `?status_id=**12345678**`

Или через API:
```bash
curl "https://your-domain.amocrm.ru/api/v4/leads/pipelines" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

## 🔐 Как получить Access Token amoCRM

1. amoCRM → Настройки → Интеграции
2. Создать интеграцию
3. Заполните:
   - Название: "Spam Checker"
   - Ссылка для перенаправления: `https://your-app.up.railway.app`
4. После создания получите:
   - Client ID
   - Client Secret
   - Код авторизации
5. Обменяйте код на Access Token через OAuth

Подробнее: [Документация amoCRM API](https://www.amocrm.ru/developers/content/oauth/step-by-step)

## 📱 Интеграция с Make.com

Добавьте HTTP модуль в ваш сценарий:

1. **Модуль:** HTTP → Make a request
2. **URL:** `https://your-app.up.railway.app/webhook/check-spam`
3. **Method:** POST
4. **Body type:** JSON
5. **Request content:**
```json
{
  "phone": "{{phone}}",
  "lead_id": {{lead_id}}
}
```

## 📊 Категории спама SpravPortal

| Категория | Описание |
|-----------|----------|
| `spam` | Общий спам |
| `fraud` | Мошенничество |
| `advertising` | Реклама |
| `survey` | Опросы |
| `collection` | Коллекторы |
| `unknown` | Неизвестно |

## 🛠 Локальная разработка

```bash
# Клонировать репозиторий
git clone https://github.com/your-repo/amocrm-spam-checker.git
cd amocrm-spam-checker

# Установить зависимости
npm install

# Скопировать и настроить переменные
cp env.example .env
# Отредактируйте .env

# Запустить сервер
npm start

# Или в режиме разработки (с авто-перезагрузкой)
npm run dev
```

## 📝 Лицензия

MIT

## 🤝 Поддержка

Если есть вопросы — создайте Issue в репозитории.










