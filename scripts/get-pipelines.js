/**
 * Скрипт для получения списка воронок и статусов из amoCRM
 * 
 * Запуск: node scripts/get-pipelines.js
 * 
 * Перед запуском установите переменные окружения:
 * - AMOCRM_DOMAIN
 * - AMOCRM_ACCESS_TOKEN
 */

require('dotenv').config();
const axios = require('axios');

const AMOCRM_DOMAIN = process.env.AMOCRM_DOMAIN || 'https://stavgeo26.amocrm.ru';
const AMOCRM_ACCESS_TOKEN = process.env.AMOCRM_ACCESS_TOKEN;

async function getPipelines() {
  if (!AMOCRM_ACCESS_TOKEN) {
    console.error('❌ Ошибка: Не указан AMOCRM_ACCESS_TOKEN');
    console.log('\nУстановите токен:');
    console.log('  export AMOCRM_ACCESS_TOKEN="ваш_токен"');
    console.log('\nИли создайте файл .env с переменной AMOCRM_ACCESS_TOKEN');
    process.exit(1);
  }

  try {
    console.log(`\n🔍 Получаем воронки из ${AMOCRM_DOMAIN}...\n`);
    
    const response = await axios.get(
      `${AMOCRM_DOMAIN}/api/v4/leads/pipelines`,
      {
        headers: {
          'Authorization': `Bearer ${AMOCRM_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    const pipelines = response.data._embedded?.pipelines || [];
    
    console.log('═══════════════════════════════════════════════════════════');
    console.log('                    ВОРОНКИ И СТАТУСЫ                       ');
    console.log('═══════════════════════════════════════════════════════════\n');
    
    pipelines.forEach(pipeline => {
      console.log(`📂 ВОРОНКА: ${pipeline.name}`);
      console.log(`   ID воронки (AMOCRM_SPAM_PIPELINE_ID): ${pipeline.id}`);
      console.log('');
      console.log('   Статусы:');
      
      const statuses = pipeline._embedded?.statuses || [];
      statuses.forEach(status => {
        const emoji = status.name.toLowerCase().includes('спам') ? '🚫' : 
                      status.name.toLowerCase().includes('закрыт') ? '❌' :
                      status.name.toLowerCase().includes('успеш') ? '✅' : '📋';
        console.log(`   ${emoji} ${status.name}`);
        console.log(`      ID статуса (AMOCRM_SPAM_STATUS_ID): ${status.id}`);
      });
      
      console.log('\n───────────────────────────────────────────────────────────\n');
    });
    
    console.log('💡 Скопируйте нужные ID в переменные окружения Railway:');
    console.log('   AMOCRM_SPAM_PIPELINE_ID = ID воронки');
    console.log('   AMOCRM_SPAM_STATUS_ID = ID статуса "СПАМ"');
    console.log('');
    
    // Ищем статус со словом "спам"
    const spamStatus = pipelines
      .flatMap(p => (p._embedded?.statuses || []).map(s => ({ ...s, pipelineId: p.id, pipelineName: p.name })))
      .find(s => s.name.toLowerCase().includes('спам'));
    
    if (spamStatus) {
      console.log('🎯 Найден статус со словом "СПАМ":');
      console.log(`   Воронка: ${spamStatus.pipelineName} (ID: ${spamStatus.pipelineId})`);
      console.log(`   Статус: ${spamStatus.name} (ID: ${spamStatus.id})`);
      console.log('');
      console.log('   Добавьте в Railway:');
      console.log(`   AMOCRM_SPAM_PIPELINE_ID=${spamStatus.pipelineId}`);
      console.log(`   AMOCRM_SPAM_STATUS_ID=${spamStatus.id}`);
    } else {
      console.log('⚠️  Статус "СПАМ" не найден. Создайте его в воронке amoCRM.');
    }
    
  } catch (error) {
    console.error('❌ Ошибка:', error.response?.data || error.message);
    
    if (error.response?.status === 401) {
      console.log('\n🔐 Ошибка авторизации. Проверьте токен доступа.');
    }
  }
}

getPipelines();

