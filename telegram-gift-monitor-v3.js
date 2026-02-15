/**
 * Telegram Gift Monitor v6.3 - FINAL VERSION
 * Формат уведомлений как на скриншотах пользователя
 */

import TelegramBot from 'node-telegram-bot-api';
import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';

// ====== НАСТРОЙКИ ======
const CONFIG = {
    botToken: '8591649030:AAFVVtyIlWTeIdGuoAcxWi-KXIz5gSl2OnM',
    notificationChatId: '-1003863003390',
    checkInterval: 5000,
    apiUrl: 'https://api.changes.tg/gifts',
    stateFile: 'gifts-state.json',
    useTelegramClient: false
};

const TELEGRAM_CLIENT_CONFIG = {
    apiId: 0,
    apiHash: '',
    phoneNumber: '',
    sessionFile: 'session.txt'
};
// =======================

class GiftMonitor {
    constructor(config) {
        this.config = config;
        this.bot = null;
        this.client = null;
        this.knownGifts = new Map();
        this.isRunning = false;
        this.isFirstCheck = true;
        this.stateFilePath = path.resolve(process.cwd(), this.config.stateFile);
    }

    async initialize() {
        if (this.config.useTelegramClient) {
            const { TelegramClient } = await import('telegram');
            const { StringSession } = await import('telegram/sessions/index.js');
            const input = (await import('input')).default;

            let session;
            try {
                const sessionString = await fs.readFile(TELEGRAM_CLIENT_CONFIG.sessionFile, 'utf-8');
                session = new StringSession(sessionString.trim());
            } catch {
                session = new StringSession('');
            }

            this.client = new TelegramClient(
                session,
                TELEGRAM_CLIENT_CONFIG.apiId,
                TELEGRAM_CLIENT_CONFIG.apiHash,
                { connectionRetries: 5 }
            );

            await this.client.start({
                phoneNumber: async () => TELEGRAM_CLIENT_CONFIG.phoneNumber || await input.text('Номер: '),
                password: async () => await input.text('Пароль 2FA: '),
                phoneCode: async () => await input.text('Код: '),
                onError: (err) => console.error('❌', err),
            });

            const sessionString = this.client.session.save();
            await fs.writeFile(TELEGRAM_CLIENT_CONFIG.sessionFile, sessionString);
            console.log('✅ TelegramClient авторизован');
        } else {
            this.bot = new TelegramBot(this.config.botToken, { polling: false });
            const me = await this.bot.getMe();
            console.log(`✅ Бот подключен: @${me.username}`);
        }
    }

    async loadState() {
        try {
            await fs.access(this.stateFilePath);
            const data = await fs.readFile(this.stateFilePath, 'utf-8');
            const gifts = JSON.parse(data);
            this.knownGifts = new Map(Object.entries(gifts));
            console.log(`📦 Загружено ${this.knownGifts.size} подарков из состояния`);
            this.isFirstCheck = false;
        } catch {
            console.log('📝 Начинаем с пустого состояния (первый запуск)');
            this.knownGifts = new Map();
            this.isFirstCheck = true;
        }
    }

    async saveState() {
        try {
            const giftsObject = Object.fromEntries(this.knownGifts);
            await fs.writeFile(this.stateFilePath, JSON.stringify(giftsObject, null, 2), 'utf-8');
            console.log(`💾 Состояние сохранено (${this.knownGifts.size} подарков)`);
        } catch (error) {
            console.error('❌ Ошибка сохранения:', error.message);
        }
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
            if (this.client) {
                await this.client.sendMessage(this.config.notificationChatId, {
                    message,
                    parseMode: 'html'
                });
            } else if (this.bot) {
                await this.bot.sendMessage(this.config.notificationChatId, message, {
                    parse_mode: 'HTML'
                });
            }
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
                
                for (const gift of data.gifts) {
                    const giftData = this.giftToObject(gift);
                    currentGifts.set(giftData.id.toString(), giftData);
                }
                
                this.knownGifts = currentGifts;
                await this.saveState();
                this.isFirstCheck = false;
                console.log('✅ Начальное состояние сохранено\n');
                return;
            }

            // Проверка новых подарков
            for (const gift of data.gifts) {
                const giftData = this.giftToObject(gift);
                const giftId = giftData.id.toString();
                currentGifts.set(giftId, giftData);

                if (!this.knownGifts.has(giftId)) {
                    console.log(`🎁 НОВЫЙ ПОДАРОК! ID: ${giftId}`);
                    await this.notifyNewGift(giftData);
                } else {
                    await this.checkGiftChanges(giftId, giftData);
                }
            }

            // Проверка удалённых
            for (const [giftId, oldGift] of this.knownGifts.entries()) {
                if (!currentGifts.has(giftId)) {
                    console.log(`🗑️ УДАЛЁН: ${giftId}`);
                    await this.notifyDeletedGift(oldGift);
                }
            }

            this.knownGifts = currentGifts;
            await this.saveState();

            console.log(`✅ Проверка OK (${currentGifts.size} подарков)`);

        } catch (error) {
            console.error('❌ Ошибка проверки:', error.message);
        }
    }

    // ФОРМАТ КАК НА СКРИНШОТЕ 1
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
        
        // Проверка появления апгрейда (ФОРМАТ КАК НА СКРИНШОТЕ 2)
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

    // ФОРМАТ КАК НА СКРИНШОТЕ 2
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
            console.log('🎁  Telegram Gift Monitor v6.3');
            console.log('    Powered by changes.tg API');
            console.log('═══════════════════════════════════════\n');

            await this.initialize();
            await this.loadState();

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
        } finally {
            if (this.client) {
                await this.client.disconnect();
            }
        }
    }

    stop() {
        console.log('\n⏹️ Остановка мониторинга...');
        this.isRunning = false;
    }
}

// Проверка настроек
function validateConfig() {
    if (CONFIG.useTelegramClient) {
        if (!TELEGRAM_CLIENT_CONFIG.apiId || TELEGRAM_CLIENT_CONFIG.apiId === 0) {
            console.error('❌ Укажите API_ID в TELEGRAM_CLIENT_CONFIG!');
            process.exit(1);
        }
        if (!TELEGRAM_CLIENT_CONFIG.apiHash) {
            console.error('❌ Укажите API_HASH в TELEGRAM_CLIENT_CONFIG!');
            process.exit(1);
        }
    } else {
        if (!CONFIG.botToken || CONFIG.botToken === '') {
            console.error('❌ Укажите токен бота!');
            process.exit(1);
        }
    }

    if (!CONFIG.notificationChatId || CONFIG.notificationChatId === '') {
        console.error('❌ Укажите ID чата для уведомлений!');
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
