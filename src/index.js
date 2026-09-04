/**
 * amoCRM Spam Checker
 * 
 * Сервис для проверки входящих звонков на спам через SpravPortal API.
 * При обнаружении спама - переводит сделку в статус "СПАМ" в amoCRM.
 * 
 * @author Автоматизация amoCRM
 * @version 1.0.0
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Виджет в карточке сделки живёт на домене amoCRM и ходит сюда кросс-доменно
app.use((req, res, next) => {
  const origin = req.get('Origin') || '';
  if (/^https:\/\/[a-z0-9-]+\.amocrm\.(ru|com)$/i.test(origin) || /^https:\/\/[a-z0-9-]+\.kommo\.com$/i.test(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ==================== КОНФИГУРАЦИЯ ====================
const config = {
  // SpravPortal API
  spravportal: {
    url: 'https://b2b-api-stage-05.spravportal.ru/whocalls/check',
    apiKey: process.env.SPRAVPORTAL_API_KEY || 'test-X1R7B8VQM2KC',
    // Версия ML-модели: 2.11-ent — enterprise-preview, открыта для нашего аккаунта (август 2026).
    // Откат на стабильную '2.7' — через переменную SPRAVPORTAL_ML_MODEL, без правки кода
    mlModelVer: process.env.SPRAVPORTAL_ML_MODEL || '2.11-ent'
  },
  // amoCRM
  amocrm: {
    domain: process.env.AMOCRM_DOMAIN || 'https://stavgeo26.amocrm.ru',
    accessToken: process.env.AMOCRM_ACCESS_TOKEN,
    // ID статуса "на удаление" для спама (опционально)
    spamStatusId: parseInt(process.env.AMOCRM_SPAM_STATUS_ID) || 0,
    spamPipelineId: parseInt(process.env.AMOCRM_SPAM_PIPELINE_ID) || 0,
    // Название тега для спама
    spamTagName: process.env.AMOCRM_SPAM_TAG_NAME || 'спам',
    // Режим обработки спама: 'tag' (только тег), 'status' (только статус), 'both' (и тег и статус)
    spamAction: process.env.AMOCRM_SPAM_ACTION || 'tag'
  },
  // Проверка по базе Kaspersky Who Calls силами воркера на маке
  whocalls: {
    workerKey: process.env.WHOCALLS_WORKER_KEY || '',
    widgetKey: process.env.WHOCALLS_WIDGET_KEY || ''
  },
  // Порог спама (0-100). Если spamScore > этого значения, считаем спамом
  spamThreshold: parseInt(process.env.SPAM_THRESHOLD) || 50,
  port: process.env.PORT || 3000
};

// ==================== ЛОГИРОВАНИЕ ====================
const log = {
  info: (msg, data = '') => console.log(`[${new Date().toISOString()}] ℹ️  ${msg}`, data),
  success: (msg, data = '') => console.log(`[${new Date().toISOString()}] ✅ ${msg}`, data),
  error: (msg, data = '') => console.error(`[${new Date().toISOString()}] ❌ ${msg}`, data),
  spam: (msg, data = '') => console.log(`[${new Date().toISOString()}] 🚫 ${msg}`, data),
  clean: (msg, data = '') => console.log(`[${new Date().toISOString()}] 📞 ${msg}`, data)
};

// ==================== ФУНКЦИИ ====================

/**
 * Очистка номера телефона от лишних символов
 * @param {string} phone - Номер телефона
 * @returns {string} - Очищенный номер (только цифры)
 */
function cleanPhone(phone) {
  if (!phone) return '';
  let cleaned = phone.toString().replace(/\D/g, '');
  // Если номер начинается с 8, заменяем на 7 (Россия)
  if (cleaned.length === 11 && cleaned.startsWith('8')) {
    cleaned = '7' + cleaned.slice(1);
  }
  return cleaned;
}

/**
 * Проверка номера на спам через SpravPortal API
 * @param {string} phone - Номер телефона для проверки
 * @returns {Object} - Результат проверки
 */
async function checkSpam(phone) {
  const phoneClean = cleanPhone(phone);
  
  log.info(`Проверяем номер: ${phoneClean}`);
  
  try {
    const response = await axios.post(
      `${config.spravportal.url}?apiKey=${config.spravportal.apiKey}`,
      {
        phones: [phoneClean],
        params: {
          allowOrganizations: true,
          showPhoneInfo: true,
          showOrganization: true,
          mlModelVer: config.spravportal.mlModelVer
        }
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000 // 10 секунд таймаут
      }
    );
    
    // SpravPortal API возвращает данные в формате: { phones: [...] }
    const result = response.data?.phones?.[0] || {};

    const mlVersion = response.headers['x-api-mlversion'];
    if (mlVersion) log.info(`ML-модель SpravPortal: ${mlVersion}`);
    const mlWarning = response.headers['x-api-mlversionwarning'];
    if (mlWarning) log.info(`⚠️ X-API-MLVersionWarning: ${mlWarning}`);

    log.info('Ответ SpravPortal API:', JSON.stringify(result));
    
    // Определяем спам по полю action
    // action может быть: "Block", "Spam", "Allow", "Unknown"
    const isSpamAction = ['Block', 'Spam', 'block', 'spam'].includes(result.action);
    
    // Категории спама (массив строк)
    const categories = result.categories || [];
    const categoryName = categories.length > 0 ? categories.join(', ') : 'Неизвестно';
    
    // Информация о телефоне
    const phoneInfo = result.phoneInfo || {};
    
    const spamResult = {
      phone: phoneClean,
      isSpam: isSpamAction,
      action: result.action || 'Unknown',
      spamScore: isSpamAction ? 100 : 0, // Если Block/Spam - 100%, иначе 0%
      category: categories[0] || 'unknown',
      categoryName: categoryName,
      reviewsCount: result.reviewsCount || 0,
      organization: result.organization || null,
      region: phoneInfo.regionTranslit || phoneInfo.region || null,
      operator: phoneInfo.operatorTranslit || phoneInfo.operator || null,
      raw: result
    };
    
    if (spamResult.isSpam) {
      log.spam(`🚫 СПАМ обнаружен! Action: ${spamResult.action}, Категория: ${spamResult.categoryName}`);
    } else {
      log.clean(`✅ Номер чистый. Action: ${spamResult.action}`);
    }
    
    return spamResult;
    
  } catch (error) {
    log.error('Ошибка SpravPortal API:', error.response?.data || error.message);
    throw new Error(`SpravPortal API error: ${error.message}`);
  }
}

/**
 * Добавить тег "спам" к сделке в amoCRM
 * @param {number} leadId - ID сделки
 */
async function addSpamTagToLead(leadId) {
  log.info(`Добавляем тег "${config.amocrm.spamTagName}" к сделке ${leadId}...`);
  
  try {
    // PATCH перезаписывает список тегов целиком, поэтому сначала читаем текущие,
    // иначе теряются рабочие пометки менеджеров
    const current = await axios.get(
      `${config.amocrm.domain}/api/v4/leads/${leadId}`,
      { headers: { 'Authorization': `Bearer ${config.amocrm.accessToken}` }, timeout: 10000 }
    );
    const existing = (current.data?._embedded?.tags || []).map(t => ({ name: t.name }));
    if (existing.some(t => t.name === config.amocrm.spamTagName)) {
      log.info(`Тег "${config.amocrm.spamTagName}" уже стоит на сделке ${leadId}`);
      return true;
    }

    await axios.patch(
      `${config.amocrm.domain}/api/v4/leads/${leadId}`,
      {
        _embedded: {
          tags: [...existing, { name: config.amocrm.spamTagName }]
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${config.amocrm.accessToken}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    
    log.success(`Тег "${config.amocrm.spamTagName}" добавлен к сделке ${leadId}`);
    return true;
    
  } catch (error) {
    log.error('Ошибка добавления тега:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Перевести сделку в статус "на удаление" в amoCRM
 * @param {number} leadId - ID сделки
 * @param {Object} spamInfo - Информация о спаме
 */
async function moveLeadToSpamStatus(leadId, spamInfo) {
  log.info(`Переводим сделку ${leadId} в статус "на удаление"...`);
  
  try {
    // Проверяем, что у нас есть необходимые ID
    if (!config.amocrm.spamStatusId || !config.amocrm.spamPipelineId) {
      log.info('ID статуса/воронки не настроены, пропускаем изменение статуса');
      return false;
    }
    
    // 1. Обновляем статус сделки
    await axios.patch(
      `${config.amocrm.domain}/api/v4/leads/${leadId}`,
      {
        status_id: config.amocrm.spamStatusId,
        pipeline_id: config.amocrm.spamPipelineId
      },
      {
        headers: {
          'Authorization': `Bearer ${config.amocrm.accessToken}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    
    log.success(`Статус сделки ${leadId} обновлён на "на удаление"`);
    return true;
    
  } catch (error) {
    log.error('Ошибка amoCRM API:', error.response?.data || error.message);
    throw new Error(`amoCRM API error: ${error.message}`);
  }
}

/**
 * Обработать спам-сделку (добавить тег, изменить статус, переименовать, добавить примечание)
 * @param {number} leadId - ID сделки
 * @param {Object} spamInfo - Информация о спаме
 */
async function handleSpamLead(leadId, spamInfo) {
  const action = config.amocrm.spamAction;
  
  log.info(`Обрабатываем спам для сделки ${leadId}, режим: ${action}`);
  
  // 1. Переименовываем сделку → "СПАМ: [старое имя]"
  await renameLeadAsSpam(leadId, spamInfo);
  
  // 2. Добавляем тег "спам"
  if (action === 'tag' || action === 'both') {
    await addSpamTagToLead(leadId);
  }
  
  // 3. Переводим в статус "на удаление"
  if (action === 'status' || action === 'both') {
    await moveLeadToSpamStatus(leadId, spamInfo);
  }
  
  // 4. Добавляем примечание с информацией о спаме
  await addNoteToLead(leadId, formatSpamNote(spamInfo));
  
  return true;
}

/**
 * Переименовать сделку как СПАМ
 * @param {number} leadId - ID сделки
 * @param {Object} spamInfo - Информация о спаме
 */
async function renameLeadAsSpam(leadId, spamInfo) {
  try {
    log.info(`Переименовываем сделку ${leadId}...`);
    
    // Сначала получаем текущее название сделки
    const response = await axios.get(
      `${config.amocrm.domain}/api/v4/leads/${leadId}`,
      {
        headers: {
          'Authorization': `Bearer ${config.amocrm.accessToken}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    
    const currentName = response.data.name || '';
    
    // Проверяем, не переименована ли уже
    if (currentName.startsWith('СПАМ:') || currentName.startsWith('СПАМ :')) {
      log.info(`Сделка ${leadId} уже помечена как СПАМ`);
      return true;
    }
    
    // Новое имя: "СПАМ: +79001234567 (старое имя)"
    const newName = `СПАМ: +${spamInfo.phone} (${currentName})`;
    
    // Обновляем название
    await axios.patch(
      `${config.amocrm.domain}/api/v4/leads/${leadId}`,
      {
        name: newName
      },
      {
        headers: {
          'Authorization': `Bearer ${config.amocrm.accessToken}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    
    log.success(`Сделка ${leadId} переименована: "${newName}"`);
    return true;
    
  } catch (error) {
    log.error('Ошибка переименования сделки:', error.response?.data || error.message);
    // Не бросаем ошибку, продолжаем обработку
    return false;
  }
}

/**
 * Добавить примечание к сделке в amoCRM
 * @param {number} leadId - ID сделки
 * @param {string} noteText - Текст примечания
 */
async function addNoteToLead(leadId, noteText) {
  try {
    await axios.post(
      `${config.amocrm.domain}/api/v4/leads/${leadId}/notes`,
      [{
        note_type: 'common',
        params: { text: noteText }
      }],
      {
        headers: {
          'Authorization': `Bearer ${config.amocrm.accessToken}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    
    log.success(`Примечание добавлено к сделке ${leadId}`);
    return true;
    
  } catch (error) {
    log.error('Ошибка добавления примечания:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Ссылка на карточку номера в Kaspersky Who Calls.
 *
 * База Касперского наполняется независимо от SpravPortal и нередко знает
 * свежий спам-номер раньше. Автоматически её опросить нельзя — сайт закрыт
 * капчей, а REST API продаётся только по договору. Поэтому даём менеджеру
 * ссылку: одно нажатие вместо звонка спамеру.
 */
function kasperskyCheckUrl(phone) {
  return `https://whocalls.kaspersky.ru/info/${phone}`;
}

/**
 * Форматирование примечания для СПАМ-номера
 */
function formatSpamNote(spamInfo) {
  return `🚫 СПАМ-НОМЕР ОБНАРУЖЕН

📞 Номер: +${spamInfo.phone}
⛔ Статус: ${spamInfo.action} (ЗАБЛОКИРОВАТЬ)
📁 Категория: ${spamInfo.categoryName}
${spamInfo.organization ? `🏢 Организация: ${spamInfo.organization}` : ''}
${spamInfo.region ? `📍 Регион: ${spamInfo.region}` : ''}
${spamInfo.operator ? `📱 Оператор: ${spamInfo.operator}` : ''}

⏰ Проверено: ${new Date().toLocaleString('ru-RU')}
🔍 Источник: SpravPortal API`;
}

/**
 * Форматирование примечания для чистого номера
 */
function formatCleanNote(phoneInfo) {
  return `✅ НОМЕР ПРОВЕРЕН

📞 Номер: +${phoneInfo.phone}
📊 Оценка спама: ${phoneInfo.spamScore}%
${phoneInfo.organization ? `🏢 Организация: ${phoneInfo.organization}` : ''}
${phoneInfo.region ? `📍 Регион: ${phoneInfo.region}` : ''}
${phoneInfo.operator ? `📱 Оператор: ${phoneInfo.operator}` : ''}

⏰ Проверено: ${new Date().toLocaleString('ru-RU')}
🔍 Источник: SpravPortal API

━━━━━━━━━━━━━━━━━━━━
❓ ВТОРОЕ МНЕНИЕ — ПЕРЕД ТЕМ КАК ПЕРЕЗВАНИВАТЬ

База SpravPortal узнаёт свежие спам-номера не сразу, поэтому
«чисто» здесь ещё не гарантия. Проверьте номер у Касперского:

${kasperskyCheckUrl(phoneInfo.phone)}

Если там «СПАМ» — не перезванивайте, переведите сделку в статус «Спам».`;
}

// ==================== ENDPOINTS ====================

/**
 * Главный webhook - принимает данные от amoCRM или Make.com
 * POST /webhook/check-spam
 * 
 * Body: { phone: "79001234567", lead_id: 12345 }
 */
app.post('/webhook/check-spam', async (req, res) => {
  const startTime = Date.now();
  
  try {
    log.info('📨 Получен webhook запрос', req.body);
    
    const { phone, lead_id } = req.body;
    
    // Валидация входных данных
    if (!phone) {
      return res.status(400).json({
        success: false,
        error: 'Отсутствует обязательное поле: phone'
      });
    }
    
    if (!lead_id) {
      return res.status(400).json({
        success: false,
        error: 'Отсутствует обязательное поле: lead_id'
      });
    }
    
    // 1. Проверяем номер на спам
    const spamResult = await checkSpam(phone);
    
    // 2. Обрабатываем результат
    if (spamResult.isSpam) {
      // СПАМ - переводим сделку в статус СПАМ
      await handleSpamLead(lead_id, spamResult);
      
      return res.json({
        success: true,
        status: 'SPAM',
        phone: spamResult.phone,
        spamScore: spamResult.spamScore,
        category: spamResult.categoryName,
        message: `Сделка ${lead_id} переведена в статус СПАМ`,
        processingTime: `${Date.now() - startTime}ms`
      });
    }
    
    // НЕ СПАМ - добавляем примечание
    await addNoteToLead(lead_id, formatCleanNote(spamResult));
    
    return res.json({
      success: true,
      status: 'CLEAN',
      phone: spamResult.phone,
      spamScore: spamResult.spamScore,
      message: 'Номер чистый, примечание добавлено',
      processingTime: `${Date.now() - startTime}ms`
    });
    
  } catch (error) {
    log.error('Ошибка обработки webhook:', error.message);
    
    res.status(500).json({
      success: false,
      error: error.message,
      processingTime: `${Date.now() - startTime}ms`
    });
  }
});

/**
 * Webhook для amoCRM Digital Pipeline (формат amoCRM)
 * POST /webhook/amocrm
 */
app.post('/webhook/amocrm', async (req, res) => {
  try {
    log.info('📨 Получен webhook от amoCRM', req.body);
    
    // amoCRM отправляет данные в разных форматах
    const leads = req.body.leads;
    
    if (!leads) {
      return res.status(200).json({ status: 'ok', message: 'No leads data' });
    }
    
    // Обрабатываем все возможные типы событий
    const leadsToProcess = leads.add || leads.update || leads.status || [];
    
    // Преобразуем в массив если это объект
    const leadsArray = Array.isArray(leadsToProcess) ? leadsToProcess : [leadsToProcess];
    
    for (const lead of leadsArray) {
      // Извлекаем ID сделки (может быть в разных полях)
      const leadId = lead.id || lead.lead_id;
      
      if (!leadId) {
        log.info('Lead ID не найден, пропускаем');
        continue;
      }
      
      // Пытаемся найти телефон из разных источников
      let phone = null;
      
      // 1. Из custom_fields (массив объектов)
      if (lead.custom_fields && Array.isArray(lead.custom_fields)) {
        const phoneField = lead.custom_fields.find(f => 
          f.name === 'Телефон' || f.code === 'PHONE' || f.id === 'phone'
        );
        phone = phoneField?.values?.[0]?.value;
      }
      
      // 2. Из custom_fields_values (новый формат API v4)
      if (!phone && lead.custom_fields_values && Array.isArray(lead.custom_fields_values)) {
        const phoneField = lead.custom_fields_values.find(f => 
          f.field_name === 'Телефон' || f.field_code === 'PHONE'
        );
        phone = phoneField?.values?.[0]?.value;
      }
      
      // 3. Напрямую из поля phone
      if (!phone && lead.phone) {
        phone = lead.phone;
      }
      
      // 4. Из контактов (если есть)
      if (!phone && lead.contacts && lead.contacts.length > 0) {
        const contact = lead.contacts[0];
        if (contact.phone) {
          phone = contact.phone;
        }
      }
      
      // Если телефон не найден, попробуем получить из amoCRM API
      if (!phone) {
        log.info(`Телефон не найден в webhook для сделки ${leadId}, пробуем получить из API...`);
        try {
          phone = await getPhoneFromLead(leadId);
        } catch (err) {
          log.error(`Не удалось получить телефон для сделки ${leadId}:`, err.message);
        }
      }
      
      if (phone && leadId) {
        log.info(`Проверяем номер: ${phone} для сделки ${leadId}`);
        
        // Проверяем асинхронно
        checkSpam(phone).then(async (spamResult) => {
          if (spamResult.isSpam) {
            await handleSpamLead(leadId, spamResult);
          } else {
            await addNoteToLead(leadId, formatCleanNote(spamResult));
          }
        }).catch(err => log.error('Async processing error:', err.message));
      } else {
        log.info(`Недостаточно данных: phone=${phone}, leadId=${leadId}`);
      }
    }
    
    // Отвечаем быстро, обработка идёт асинхронно
    res.status(200).json({ status: 'ok' });
    
  } catch (error) {
    log.error('Ошибка обработки amoCRM webhook:', error.message);
    res.status(200).json({ status: 'error', message: error.message });
  }
});

/**
 * Получить телефон из сделки через API amoCRM
 */
async function getPhoneFromLead(leadId) {
  try {
    // Получаем сделку с контактами
    const response = await axios.get(
      `${config.amocrm.domain}/api/v4/leads/${leadId}?with=contacts`,
      {
        headers: {
          'Authorization': `Bearer ${config.amocrm.accessToken}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    
    const lead = response.data;
    const contacts = lead._embedded?.contacts || [];
    
    if (contacts.length > 0) {
      // Получаем первый контакт
      const contactId = contacts[0].id;
      const contactResponse = await axios.get(
        `${config.amocrm.domain}/api/v4/contacts/${contactId}`,
        {
          headers: {
            'Authorization': `Bearer ${config.amocrm.accessToken}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );
      
      const contact = contactResponse.data;
      const phoneField = contact.custom_fields_values?.find(f => 
        f.field_code === 'PHONE' || f.field_name === 'Телефон'
      );
      
      if (phoneField && phoneField.values && phoneField.values.length > 0) {
        return phoneField.values[0].value;
      }
    }
    
    return null;
  } catch (error) {
    log.error('Ошибка получения телефона из API:', error.message);
    return null;
  }
}

/**
 * Тестовый endpoint - проверить номер без записи в amoCRM
 * GET /test/check?phone=79001234567
 */
app.get('/test/check', async (req, res) => {
  try {
    const { phone } = req.query;
    
    if (!phone) {
      return res.status(400).json({
        error: 'Укажите номер телефона',
        example: '/test/check?phone=79001234567'
      });
    }
    
    const result = await checkSpam(phone);
    
    res.json({
      success: true,
      result: {
        phone: result.phone,
        isSpam: result.isSpam,
        spamScore: result.spamScore,
        category: result.categoryName,
        reviewsCount: result.reviewsCount,
        organization: result.organization,
        region: result.region,
        operator: result.operator
      }
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Получить список воронок и статусов из amoCRM
 * GET /api/pipelines
 */
app.get('/api/pipelines', async (req, res) => {
  try {
    if (!config.amocrm.accessToken) {
      return res.status(400).json({ error: 'AMOCRM_ACCESS_TOKEN не настроен' });
    }
    
    const response = await axios.get(
      `${config.amocrm.domain}/api/v4/leads/pipelines`,
      {
        headers: {
          'Authorization': `Bearer ${config.amocrm.accessToken}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    
    const pipelines = response.data._embedded?.pipelines || [];
    
    const result = pipelines.map(pipeline => ({
      pipeline_id: pipeline.id,
      pipeline_name: pipeline.name,
      statuses: (pipeline._embedded?.statuses || []).map(status => ({
        status_id: status.id,
        status_name: status.name
      }))
    }));
    
    res.json({
      success: true,
      pipelines: result,
      hint: 'Найдите нужный статус и добавьте в Railway: AMOCRM_SPAM_PIPELINE_ID и AMOCRM_SPAM_STATUS_ID'
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.response?.data || error.message
    });
  }
});

/**
 * Health check / Status
 * GET /
 */
// ==================== ПРОВЕРКА ПО БАЗЕ KASPERSKY WHO CALLS ====================

/**
 * Сайт Касперского отдаёт вердикт только настоящему браузеру: в headless
 * капча не проходит и данные не подгружаются вовсе. Поэтому сама проверка
 * живёт на маке (воркер с обычным Chrome), а Railway работает почтовым
 * ящиком: кнопка в карточке кладёт задание, воркер его забирает и возвращает
 * вердикт, разбор последствий снова здесь.
 *
 * Очередь держим в памяти: задания живут минуты, а перезапуск сервиса
 * означает лишь то, что менеджеру надо нажать кнопку ещё раз.
 */
const JOB_TTL_MS = 15 * 60 * 1000;
const jobs = new Map();

function pruneJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) jobs.delete(id);
  }
}

function keyOk(req, expected) {
  if (!expected) return true; // ключ не задан — не мешаем локальной отладке
  const given = req.get('X-Api-Key') || req.query.key || req.body?.key;
  return given === expected;
}

/**
 * Завершить все открытые задачи сделки — чтобы спам не висел у менеджера в делах
 */
async function closeLeadTasks(leadId) {
  const auth = { 'Authorization': `Bearer ${config.amocrm.accessToken}`, 'Content-Type': 'application/json' };
  const res = await axios.get(`${config.amocrm.domain}/api/v4/tasks`, {
    headers: auth,
    params: { 'filter[entity_type]': 'leads', 'filter[entity_id]': leadId, 'filter[is_completed]': 0, limit: 250 },
    timeout: 10000,
    validateStatus: st => st === 200 || st === 204
  });

  const tasks = res.data?._embedded?.tasks || [];
  if (!tasks.length) {
    log.info(`Открытых задач по сделке ${leadId} нет`);
    return 0;
  }

  await axios.patch(
    `${config.amocrm.domain}/api/v4/tasks`,
    tasks.map(t => ({ id: t.id, is_completed: true, result: { text: 'Спам-номер, сделка закрыта' } })),
    { headers: auth, timeout: 10000 }
  );

  log.success(`Закрыто задач по сделке ${leadId}: ${tasks.length}`);
  return tasks.length;
}

function formatKasperskyNote(phone, verdict, category) {
  const stamp = `⏰ Проверено: ${new Date().toLocaleString('ru-RU')}\n🔍 Источник: Kaspersky Who Calls`;
  if (verdict === 'spam') {
    return `🚫 СПАМ ПО БАЗЕ КАСПЕРСКОГО\n\n📞 Номер: +${phone}\n` +
           `${category ? `📁 Категория: ${category}\n` : ''}` +
           `\nСделка закрыта, задачи завершены, статус изменён на «на удаление».\n\n${stamp}`;
  }
  if (verdict === 'clean') {
    return `✅ НЕ СПАМ ПО БАЗЕ КАСПЕРСКОГО\n\n📞 Номер: +${phone}\n` +
           `${category ? `📁 Категория: ${category}\n` : ''}` +
           `\nЖалоб на номер нет — можно работать со сделкой.\n\n${stamp}`;
  }
  return `❔ КАСПЕРСКИЙ НЕ ЗНАЕТ ЭТОТ НОМЕР\n\n📞 Номер: +${phone}\n\n` +
         `Жалоб не поступало, но и подтверждения тоже нет — решение за вами.\n\n${stamp}`;
}

/**
 * Разбор вердикта: при спаме гасим сделку целиком, иначе просто пишем результат
 */
async function applyKasperskyVerdict(leadId, phone, verdict, category) {
  if (verdict === 'spam') {
    await renameLeadAsSpam(leadId, { phone });
    await addSpamTagToLead(leadId);
    await moveLeadToSpamStatus(leadId, { phone });
    await closeLeadTasks(leadId);
    await addNoteToLead(leadId, formatKasperskyNote(phone, verdict, category));
    return 'Спам. Сделка закрыта и переведена в статус «на удаление»';
  }

  await addNoteToLead(leadId, formatKasperskyNote(phone, verdict, category));
  return verdict === 'clean'
    ? 'Жалоб на номер нет — можно работать'
    : 'Касперский не знает этот номер, решение за вами';
}

/**
 * Кнопка в карточке сделки: поставить номер в очередь на проверку
 * POST /api/whocalls/check  { lead_id, phone? }
 */
app.post('/api/whocalls/check', async (req, res) => {
  if (!keyOk(req, config.whocalls.widgetKey)) {
    return res.status(403).json({ success: false, error: 'Неверный ключ' });
  }

  const leadId = parseInt(req.body.lead_id);
  if (!leadId) return res.status(400).json({ success: false, error: 'Не передан lead_id' });

  try {
    const phone = cleanPhone(req.body.phone) || cleanPhone(await getPhoneFromLead(leadId));
    if (!phone) return res.status(404).json({ success: false, error: 'У сделки не найден номер телефона' });

    pruneJobs();

    // Тот же номер уже в работе — не плодим задания на повторные нажатия
    for (const [id, job] of jobs) {
      if (job.leadId === leadId && (job.status === 'pending' || job.status === 'in_progress')) {
        return res.json({ success: true, job_id: id, status: job.status, phone });
      }
    }

    const jobId = `${leadId}-${Date.now().toString(36)}`;
    jobs.set(jobId, { leadId, phone, status: 'pending', createdAt: Date.now(), verdict: null, message: null });
    log.info(`📋 Задание на проверку у Касперского: сделка ${leadId}, номер ${phone}`);

    return res.json({ success: true, job_id: jobId, status: 'pending', phone });
  } catch (error) {
    log.error('Ошибка постановки задания:', error.response?.data || error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Воркер на маке забирает очередное задание
 * GET /api/whocalls/next?key=...
 */
app.get('/api/whocalls/next', (req, res) => {
  if (!keyOk(req, config.whocalls.workerKey)) {
    return res.status(403).json({ success: false, error: 'Неверный ключ' });
  }

  pruneJobs();
  for (const [id, job] of jobs) {
    if (job.status === 'pending') {
      job.status = 'in_progress';
      job.takenAt = Date.now();
      return res.json({ success: true, job: { job_id: id, phone: job.phone, lead_id: job.leadId } });
    }
  }
  return res.json({ success: true, job: null });
});

/**
 * Воркер вернул вердикт: spam | clean | unknown
 * POST /api/whocalls/result  { job_id, verdict, category?, error? }
 */
app.post('/api/whocalls/result', async (req, res) => {
  if (!keyOk(req, config.whocalls.workerKey)) {
    return res.status(403).json({ success: false, error: 'Неверный ключ' });
  }

  const { job_id, verdict, category, error } = req.body;
  const job = jobs.get(job_id);
  if (!job) return res.status(404).json({ success: false, error: 'Задание не найдено или устарело' });

  if (error) {
    job.status = 'error';
    job.message = `Проверка не удалась: ${error}`;
    log.error(`Воркер вернул ошибку по сделке ${job.leadId}: ${error}`);
    return res.json({ success: true });
  }

  try {
    job.verdict = verdict;
    job.message = await applyKasperskyVerdict(job.leadId, job.phone, verdict, category);
    job.status = 'done';
    log[verdict === 'spam' ? 'spam' : 'success'](`Касперский по сделке ${job.leadId}: ${job.message}`);
    return res.json({ success: true });
  } catch (e) {
    job.status = 'error';
    job.message = `Вердикт получен (${verdict}), но amoCRM не принял изменения: ${e.message}`;
    log.error('Ошибка применения вердикта:', e.response?.data || e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * Виджет опрашивает статус задания
 * GET /api/whocalls/status/:jobId
 */
app.get('/api/whocalls/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: 'Задание не найдено или устарело' });
  return res.json({
    success: true,
    status: job.status,
    verdict: job.verdict,
    phone: job.phone,
    message: job.message
  });
});

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'amoCRM Spam Checker',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    config: {
      spravportal: config.spravportal.url,
      mlModelVer: config.spravportal.mlModelVer,
      amocrm: config.amocrm.domain,
      spamThreshold: config.spamThreshold,
      spamStatusConfigured: !!(config.amocrm.spamStatusId && config.amocrm.spamPipelineId)
    },
    endpoints: {
      'POST /webhook/check-spam': 'Основной webhook (phone, lead_id)',
      'POST /webhook/amocrm': 'Webhook в формате amoCRM',
      'GET /test/check?phone=X': 'Тест проверки номера',
      'GET /api/pipelines': 'Список воронок и статусов amoCRM',
      'GET /': 'Health check (эта страница)',
      'GET /health': 'Health check (для мониторинга)'
    }
  });
});

/**
 * Health check для мониторинга
 * GET /health
 */
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// ==================== ЗАПУСК СЕРВЕРА ====================
app.listen(config.port, () => {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║                                                                ║
║   🚀 amoCRM Spam Checker запущен!                              ║
║                                                                ║
╠════════════════════════════════════════════════════════════════╣
║                                                                ║
║   📍 Порт: ${String(config.port).padEnd(48)}║
║   📞 SpravPortal API: ${config.spravportal.url.substring(0, 35).padEnd(35)}║
║   🧠 ML-модель: ${String(config.spravportal.mlModelVer).padEnd(43)}║
║   🏢 amoCRM: ${config.amocrm.domain.padEnd(45)}║
║   🎯 Порог спама: ${String(config.spamThreshold + '%').padEnd(42)}║
║                                                                ║
╠════════════════════════════════════════════════════════════════╣
║                                                                ║
║   📌 Endpoints:                                                ║
║      POST /webhook/check-spam - Webhook для amoCRM/Make        ║
║      POST /webhook/amocrm     - Webhook в формате amoCRM       ║
║      GET  /test/check?phone=X - Тест проверки номера           ║
║      GET  /                   - Статус сервиса                 ║
║                                                                ║
╚════════════════════════════════════════════════════════════════╝
  `);
});

