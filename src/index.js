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

// ==================== КОНФИГУРАЦИЯ ====================
const config = {
  // SpravPortal API
  spravportal: {
    url: 'https://b2b-api-stage-05.spravportal.ru/whocalls/check',
    apiKey: process.env.SPRAVPORTAL_API_KEY || 'test-X1R7B8VQM2KC'
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
          showOrganization: true
        }
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000 // 10 секунд таймаут
      }
    );
    
    const result = response.data?.results?.[0] || {};
    
    const spamResult = {
      phone: phoneClean,
      isSpam: result.isSpam || false,
      spamScore: result.spamScore || 0,
      category: result.category || 'unknown',
      categoryName: result.categoryName || 'Неизвестно',
      reviewsCount: result.reviewsCount || 0,
      organization: result.organization?.name || null,
      region: result.phoneInfo?.region || null,
      operator: result.phoneInfo?.operator || null,
      raw: result
    };
    
    // Определяем статус на основе порога
    if (spamResult.spamScore >= config.spamThreshold) {
      spamResult.isSpam = true;
    }
    
    if (spamResult.isSpam) {
      log.spam(`СПАМ обнаружен! Score: ${spamResult.spamScore}%, Категория: ${spamResult.categoryName}`);
    } else {
      log.clean(`Номер чистый. Score: ${spamResult.spamScore}%`);
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
    await axios.patch(
      `${config.amocrm.domain}/api/v4/leads/${leadId}`,
      {
        _embedded: {
          tags: [
            { name: config.amocrm.spamTagName }
          ]
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
 * Обработать спам-сделку (добавить тег, изменить статус, добавить примечание)
 * @param {number} leadId - ID сделки
 * @param {Object} spamInfo - Информация о спаме
 */
async function handleSpamLead(leadId, spamInfo) {
  const action = config.amocrm.spamAction;
  
  log.info(`Обрабатываем спам для сделки ${leadId}, режим: ${action}`);
  
  // Добавляем тег "спам"
  if (action === 'tag' || action === 'both') {
    await addSpamTagToLead(leadId);
  }
  
  // Переводим в статус "на удаление"
  if (action === 'status' || action === 'both') {
    await moveLeadToSpamStatus(leadId, spamInfo);
  }
  
  // Добавляем примечание с информацией о спаме
  await addNoteToLead(leadId, formatSpamNote(spamInfo));
  
  return true;
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
 * Форматирование примечания для СПАМ-номера
 */
function formatSpamNote(spamInfo) {
  return `🚫 СПАМ-НОМЕР ОБНАРУЖЕН

📞 Номер: +${spamInfo.phone}
📊 Оценка спама: ${spamInfo.spamScore}%
📁 Категория: ${spamInfo.categoryName}
💬 Отзывов: ${spamInfo.reviewsCount}
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
🔍 Источник: SpravPortal API`;
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
    
    // amoCRM отправляет данные в формате leads[add][0], leads[update][0] и т.д.
    const leads = req.body.leads;
    
    if (!leads) {
      return res.status(200).json({ status: 'ok', message: 'No leads data' });
    }
    
    // Обрабатываем добавленные или обновленные лиды
    const leadsToProcess = leads.add || leads.update || [];
    
    for (const lead of leadsToProcess) {
      const leadId = lead.id;
      // Пытаемся найти телефон в кастомных полях или контактах
      // Это зависит от вашей настройки amoCRM
      const phone = lead.custom_fields?.find(f => f.name === 'Телефон')?.values?.[0]?.value;
      
      if (phone && leadId) {
        // Проверяем асинхронно
        checkSpam(phone).then(async (spamResult) => {
          if (spamResult.isSpam) {
            await handleSpamLead(leadId, spamResult);
          } else {
            await addNoteToLead(leadId, formatCleanNote(spamResult));
          }
        }).catch(err => log.error('Async processing error:', err.message));
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
 * Health check / Status
 * GET /
 */
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'amoCRM Spam Checker',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    config: {
      spravportal: config.spravportal.url,
      amocrm: config.amocrm.domain,
      spamThreshold: config.spamThreshold,
      spamStatusConfigured: !!(config.amocrm.spamStatusId && config.amocrm.spamPipelineId)
    },
    endpoints: {
      'POST /webhook/check-spam': 'Основной webhook (phone, lead_id)',
      'POST /webhook/amocrm': 'Webhook в формате amoCRM',
      'GET /test/check?phone=X': 'Тест проверки номера',
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

