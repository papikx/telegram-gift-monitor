/**
 * Telegram Gift Monitor v6.4 - Railway Edition
 * Использует память вместо файлов (для Railway/облачных платформ)
 */

import TelegramBot from 'node-telegram-bot-api';
import fetch from 'node-fetch';

// ====== НАСТРОЙКИ ======
const CONFIG = {
    botToken: process.env.BOT_TOKEN || '8591649030:AAFVVtyIlWTeIdGuoAcxWi-KXIz5gSl2OnM',
    notificationChatId: process.env.CHAT_ID || '-1003863003390',
    checkInterval: parseInt(process.env.CHECK_INTERVAL || '5000'),
    apiUrl: 'https://api.changes.tg/gifts',
    // Начальное состояние из переменной окружения (если есть)
    initialState: process.env.GIFTS_STATE ? JSON.parse(process.env.GIFTS_STATE) : null
};
// =======================

class GiftMonitor {
    constructor(config) {
        this.config = config;
        this.bot = null;
        this.knownGifts = new Map();
        this.isRunning = false;
        this.isFirstCheck = true;
    }

    async initialize() {
        this.bot = new TelegramBot(this.config.botToken, { polling: false });
        const me = await this.bot.getMe();
        console.log(`✅ Бот подключен: @${me.username}`);
    }

    loadInitialState() {
        if (this.config.initialState) {
            this.knownGifts = new Map(Object.entries(this.config.initialState));
            console.log(`📦 Загружено ${this.knownGifts.size} подарков из переменных окружения`);
            this.isFirstCheck = false;
        } else {
            console.log('📝 Начинаем с пустого состояния (первый запуск)');
            this.knownGifts = new Map();
            this.isFirstCheck = true;
        }
    }

    // В Railway файлы не сохраняются, поэтому просто логируем состояние
    logState() {
        const giftsObject = Object.fromEntries(this.knownGifts);
        console.log('\n💾 ТЕКУЩЕЕ СОСТОЯНИЕ:');
        console.log(JSON.stringify(giftsObject, null, 2));
        console.log('\n📌 Для сохранения состояния между деплоями добавьте в Railway:');
        console.log('   Variable: GIFTS_STATE');
        console.log('   Value: ' + JSON.stringify(giftsObject));
        console.log('');
    }

    async fetchGifts() {
        try {
            const response = await fetch(this.config.apiUrl);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.json();
        } catch (error) {
            console.error('❌ Ошибка получения данных:', error.message);
            return null;
        }
    }

    async sendNotification(message) {
        try {
            await this.bot.sendMessage(this.config.notificationChatId, message, {
                parse_mode: 'HTML'
            });
            console.log('📨 Уведомление отправлено');
        } catch (error) {
            console.error('❌ Ошибка отправки:', error.message);
        }
    }

    giftToObject(gift) {
        return {
            id: gift.id || gift.document_id || '',
            stars: gift.stars || gift.price || 0,
            availabilityTotal: gift.availability_total || gift.limit || 0,
            availabilityRemains: gift.availability_remains || gift.remaining || 0,
            upgradeStars: gift.upgrade_stars || gift.upgrade_price || 0,
            soldOut: gift.sold_out || false,
            limited: gift.limited || false,
            premiumOnly: gift.premium_only || false,
            maxPerUser: gift.max_per_user || 0
        };
    }

    async checkGifts() {
        try {
            const data = await this.fetchGifts();
            
            if (!data || !data.gifts) {
                console.log('⚠️ Нет данных о подарках');
                return;
            }

            const currentGifts = new Map();

            if (this.isFirstCheck) {
                console.log(`\n📦 Первая загрузка: ${data.gifts.length} подарков`);
                console.log('─'.repeat(60));
                
                for (const gift of data.gifts) {
                    const giftData = this.giftToObject(gift);
                    const giftId = giftData.id.toString();
                    currentGifts.set(giftId, giftData);
                    console.log(`   🎁 ID: ${giftId.substring(0, 20).padEnd(20)} | ${String(giftData.stars).padStart(6)} ⭐`);
                }
                
                console.log('─'.repeat(60));
                this.knownGifts = currentGifts;
                this.isFirstCheck = false;
                this.logState(); // Показываем состояние для сохранения
                console.log('✅ Начальное состояние загружено. Теперь отслеживаем изменения!\n');
                return;
            }

            // Проверка новых подарков
            for (const gift of data.gifts) {
                const giftData = this.giftToObject(gift);
                const giftId = giftData.id.toString();
                currentGifts.set(giftId, giftData);

                if (!this.knownGifts.has(giftId)) {
                    console.log(`\n🎁 НОВЫЙ ПОДАРОК! ID: ${giftId}`);
                    await this.notifyNewGift(giftData);
                } else {
                    await this.checkGiftChanges(giftId, giftData);
                }
            }

            // Проверка удалённых
            for (const [giftId, oldGift] of this.knownGifts.entries()) {
                if (!currentGifts.has(giftId)) {
                    console.log(`\n🗑️ УДАЛЁН: ${giftId}`);
                    await this.notifyDeletedGift(oldGift);
                }
            }

            this.knownGifts = currentGifts;

            const now = new Date().toLocaleTimeString('ru-RU');
            console.log(`✅ Проверка OK (${currentGifts.size} подарков) | ${now}`);

        } catch (error) {
            console.error('❌ Ошибка проверки:', error.message);
        }
    }

    async notifyNewGift(gift) {
        let message = '<b>Gift Alerts</b>\n';
        message += '🎁 A new gift has been added.\n\n';
        
        message += '<b>Released by:</b> Telegram\n';
        message += `<b>Price:</b> ${gift.stars.toLocaleString()} ⭐\n`;
        
        if (gift.availabilityTotal > 0) {
            message += `<b>Limit:</b> ${gift.availabilityTotal.toLocaleString()}\n`;
        }
        
        if (gift.premiumOnly) {
            message += '<b>Premium only:</b> Yes\n';
        }
        
        if (gift.maxPerUser > 0) {
            message += `<b>Max per user:</b> ${gift.maxPerUser}\n`;
        }
        
        if (gift.upgradeStars > 0) {
            message += '<b>Upgrade:</b> available\n';
        } else {
            message += '<b>Upgrade:</b> unavailable\n';
        }
        
        await this.sendNotification(message);
    }

    async checkGiftChanges(giftId, newGift) {
        const oldGift = this.knownGifts.get(giftId);
        
        // Проверка появления апгрейда
        if (!oldGift.upgradeStars && newGift.upgradeStars > 0) {
            console.log(`⬆️ НОВЫЙ АПГРЕЙД! ID: ${giftId}`);
            await this.notifyUpgrade(newGift);
            return;
        }
        
        const changes = [];

        // Изменение доступности
        if (newGift.availabilityRemains !== oldGift.availabilityRemains) {
            const sold = (oldGift.availabilityRemains || 0) - (newGift.availabilityRemains || 0);
            if (sold > 0) {
                changes.push(`Sold: ${sold.toLocaleString()} (${newGift.availabilityRemains.toLocaleString()} remaining)`);
            }
        }

        // Изменение цены
        if (newGift.stars !== oldGift.stars) {
            changes.push(`Price: ${oldGift.stars.toLocaleString()} → ${newGift.stars.toLocaleString()} ⭐`);
        }

        // Изменение цены апгрейда
        if (newGift.upgradeStars !== oldGift.upgradeStars && oldGift.upgradeStars > 0) {
            changes.push(`Upgrade price: ${oldGift.upgradeStars.toLocaleString()} → ${newGift.upgradeStars.toLocaleString()} ⭐`);
        }

        // Распродано
        if (newGift.soldOut && !oldGift.soldOut) {
            changes.push('Status: SOLD OUT!');
        }

        if (changes.length > 0) {
            console.log(`🔄 ОБНОВЛЕНИЕ: ${giftId}`);
            await this.notifyGiftUpdate(newGift, changes);
        }
    }

    async notifyUpgrade(gift) {
        let message = '<b>Gift Alerts</b>\n';
        message += 'New NFT upgrades are available!\n\n';
        message += '💎 - can be upgraded to NFT';
        
        await this.sendNotification(message);
    }

    async notifyGiftUpdate(gift, changes) {
        let message = '<b>Gift Alerts</b>\n';
        message += '🔄 Gift status updated!\n\n';
        
        message += `<b>Price:</b> ${gift.stars.toLocaleString()} ⭐\n`;
        
        if (gift.upgradeStars > 0) {
            message += `<b>Upgrade price:</b> ${gift.upgradeStars.toLocaleString()} ⭐\n`;
        }
        
        message += '\n<b>Changes:</b>\n';
        for (const change of changes) {
            message += `• ${change}\n`;
        }
        
        await this.sendNotification(message);
    }

    async notifyDeletedGift(gift) {
        let message = '<b>Gift Alerts</b>\n';
        message += '❌ A gift has been removed.\n\n';
        message += `<b>Price:</b> ${gift.stars.toLocaleString()} ⭐\n`;
        
        if (gift.availabilityTotal > 0) {
            const sold = gift.availabilityTotal - (gift.availabilityRemains || 0);
            message += `<b>Total sold:</b> ${sold.toLocaleString()}\n`;
        }
        
        await this.sendNotification(message);
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async start() {
        try {
            console.log('═══════════════════════════════════════');
            console.log('🎁  Telegram Gift Monitor v6.4');
            console.log('    Railway Edition (Stateless)');
            console.log('═══════════════════════════════════════\n');

            await this.initialize();
            this.loadInitialState();

            // Уведомление о запуске
            await this.sendNotification(
                '<b>Gift Alerts</b>\n' +
                '✅ Monitoring system activated!\n\n' +
                `<b>Check interval:</b> ${this.config.checkInterval / 1000} seconds\n` +
                '<b>Status:</b> Online 🟢'
            );

            console.log(`✨ Мониторинг запущен! Проверка каждые ${this.config.checkInterval / 1000}с\n`);

            this.isRunning = true;

            while (this.isRunning) {
                await this.checkGifts();
                await this.sleep(this.config.checkInterval);
            }

        } catch (error) {
            console.error('❌ Критическая ошибка:', error);
        }
    }

    stop() {
        console.log('\n⏹️ Остановка мониторинга...');
        this.isRunning = false;
    }
}

// Проверка настроек
function validateConfig() {
    if (!CONFIG.botToken) {
        console.error('❌ Укажите BOT_TOKEN!');
        process.exit(1);
    }

    if (!CONFIG.notificationChatId) {
        console.error('❌ Укажите CHAT_ID!');
        process.exit(1);
    }
}

// Главная функция
async function main() {
    validateConfig();

    const monitor = new GiftMonitor(CONFIG);

    process.on('SIGINT', () => {
        monitor.stop();
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        monitor.stop();
        process.exit(0);
    });

    await monitor.start();
}

main().catch(console.error);
