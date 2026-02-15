/**
 * Telegram Gift Monitor v6.0 - Changes.TG API
 * Использует публичное API changes.tg для мониторинга подарков
 */

import TelegramBot from 'node-telegram-bot-api';
import fetch from 'node-fetch';
import fs from 'fs/promises';

// ====== НАСТРОЙКИ ======
const CONFIG = {
    botToken: '8591649030:AAFVVtyIlWTeIdGuoAcxWi-KXIz5gSl2OnM', // Токен бота от @BotFather (или оставьте пустым для TelegramClient)
    notificationChatId: '-1003863003390', // ID чата/группы для уведомлений
    checkInterval: 5000, // Интервал проверки в миллисекундах (5 секунд)
    apiUrl: 'https://api.changes.tg/gifts',
    cdnUrl: 'https://cdn.changes.tg/gifts/',
    stateFile: 'gifts-state.json',
    useTelegramClient: false // true = использовать TelegramClient, false = использовать Bot API
};

// Если используете TelegramClient вместо бота
const TELEGRAM_CLIENT_CONFIG = {
    apiId: 0, // Ваш API ID
    apiHash: '', // Ваш API Hash
    phoneNumber: '', // Ваш номер
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
    }

    /**
     * Инициализация клиента
     */
    async initialize() {
        if (this.config.useTelegramClient) {
            // Использование TelegramClient (для отправки без бота)
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
            // Использование Bot API
            this.bot = new TelegramBot(this.config.botToken, { polling: false });
            const me = await this.bot.getMe();
            console.log(`✅ Бот подключен: @${me.username}`);
        }
    }

    /**
     * Загрузка состояния
     */
    async loadState() {
        try {
            const data = await fs.readFile(this.config.stateFile, 'utf-8');
            const gifts = JSON.parse(data);
            this.knownGifts = new Map(Object.entries(gifts));
            console.log(`📦 Загружено ${this.knownGifts.size} подарков`);
        } catch (error) {
            console.log('📝 Начинаем с пустого состояния');
            this.knownGifts = new Map();
        }
    }

    /**
     * Сохранение состояния
     */
    async saveState() {
        try {
            const giftsObject = Object.fromEntries(this.knownGifts);
            await fs.writeFile(
                this.config.stateFile,
                JSON.stringify(giftsObject, null, 2)
            );
        } catch (error) {
            console.error('❌ Ошибка сохранения:', error.message);
        }
    }

    /**
     * Получение данных из API
     */
    async fetchGifts() {
        try {
            const response = await fetch(this.config.apiUrl);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const data = await response.json();
            console.log('Ответ от сервера:', JSON.stringify(data, null, 2));
            const freshGiftsList = data.gifts || [];
            return data;
        } catch (error) {
            console.error('❌ Ошибка получения данных:', error.message);
            return null;
        }
    }

    /**
     * Отправка уведомления
     */
    async sendNotification(message) {
        try {
            if (this.client) {
                await this.client.sendMessage(this.config.notificationChatId, {
                    message,
                    parseMode: 'html'
                });
            } else if (this.bot) {
                await this.bot.sendMessage(this.config.notificationChatId, message, {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                });
            }
            console.log('📨 Уведомление отправлено');
        } catch (error) {
            console.error('❌ Ошибка отправки:', error.message);
        }
    }

    /**
     * Форматирование заголовка
     */
    formatHeader(title, emoji = '🎁') {
        const line = '═'.repeat(40);
        return `${line}\n${emoji} ${title}\n${line}`;
    }

    /**
     * Форматирование времени
     */
    formatDateTime() {
        return new Date().toLocaleString('ru-RU', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    /**
     * Преобразование данных подарка
     */
    giftToObject(gift) {
        return {
            id: gift.id || gift.document_id || '',
            stars: gift.stars || gift.price || 0,
            availabilityTotal: gift.availability_total || gift.limit || 0,
            availabilityRemains: gift.availability_remains || gift.remaining || 0,
            upgradeStars: gift.upgrade_stars || gift.upgrade_price || 0,
            soldOut: gift.sold_out || false,
            limited: gift.limited || false
        };
    }

    /**
     * Проверка подарков
     */
    async checkGifts() {
        try {
            const data = await this.fetchGifts();
            
            if (!data || !data.gifts) {
                console.log('⚠️ Нет данных о подарках');
                return;
            }

            const currentGifts = new Map();

            // Обработка каждого подарка
            for (const gift of data.gifts) {
                const giftData = this.giftToObject(gift);
                const giftId = giftData.id.toString();
                currentGifts.set(giftId, giftData);

                if (!this.knownGifts.has(giftId)) {
                    // Новый подарок
                    await this.notifyNewGift(giftData);
                } else {
                    // Проверка изменений
                    await this.checkGiftChanges(giftId, giftData);
                }
            }

            // Проверка удалённых подарков
            for (const [giftId, oldGift] of this.knownGifts.entries()) {
                if (!currentGifts.has(giftId)) {
                    await this.notifyDeletedGift(oldGift);
                }
            }

            this.knownGifts = currentGifts;
            await this.saveState();

            console.log(`✅ Проверка OK. Подарков: ${currentGifts.size}`);

        } catch (error) {
            console.error('❌ Ошибка проверки:', error.message);
        }
    }

    /**
     * Уведомление о новом подарке
     */
    async notifyNewGift(gift) {
        let message = this.formatHeader('Gift Alerts', '🎁');
        message += '\n<b>🎉 A new gift has been added.</b>\n\n';
        message += `<b>Released by:</b> Telegram\n`;
        message += `<b>Price:</b> ${gift.stars.toLocaleString()} ⭐\n`;
        
        if (gift.availabilityTotal > 0) {
            message += `<b>Limit:</b> ${gift.availabilityTotal.toLocaleString()}\n`;
            
            if (gift.availabilityRemains !== gift.availabilityTotal) {
                message += `<b>Available:</b> ${gift.availabilityRemains.toLocaleString()}/${gift.availabilityTotal.toLocaleString()}\n`;
            }
        }
        
        if (gift.upgradeStars > 0) {
            message += `<b>Upgrade price:</b> ${gift.upgradeStars.toLocaleString()} ⭐\n`;
            message += `<b>Upgrade:</b> available\n`;
        } else {
            message += `<b>Upgrade:</b> unavailable\n`;
        }
        
        if (gift.limited) {
            message += `<b>Type:</b> Limited Edition ⭐\n`;
        }
        
        message += `\n<i>⏰ ${this.formatDateTime()}</i>`;
        
        await this.sendNotification(message);
        console.log(`🎁 Новый подарок! Цена: ${gift.stars} ⭐`);
    }

    /**
     * Проверка изменений в подарке
     */
    async checkGiftChanges(giftId, newGift) {
        const oldGift = this.knownGifts.get(giftId);
        const changes = [];

        // Изменение доступности
        if (newGift.availabilityRemains !== oldGift.availabilityRemains) {
            const sold = (oldGift.availabilityRemains || 0) - (newGift.availabilityRemains || 0);
            if (sold > 0) {
                changes.push({
                    icon: '📉',
                    text: `Sold: ${sold.toLocaleString()} (${newGift.availabilityRemains.toLocaleString()} remaining)`
                });
            }
        }

        // Изменение цены
        if (newGift.stars !== oldGift.stars) {
            const icon = newGift.stars < oldGift.stars ? '📉' : '📈';
            changes.push({
                icon: icon,
                text: `Price: ${oldGift.stars.toLocaleString()} → ${newGift.stars.toLocaleString()} ⭐`
            });
        }

        // Изменение цены апгрейда
        if (newGift.upgradeStars !== oldGift.upgradeStars) {
            if (!oldGift.upgradeStars && newGift.upgradeStars) {
                changes.push({
                    icon: '⬆️',
                    text: `NFT upgrade now available! (${newGift.upgradeStars.toLocaleString()} ⭐)`
                });
            } else if (oldGift.upgradeStars && newGift.upgradeStars) {
                const icon = newGift.upgradeStars < oldGift.upgradeStars ? '📉' : '📈';
                changes.push({
                    icon: icon,
                    text: `Upgrade price: ${oldGift.upgradeStars.toLocaleString()} → ${newGift.upgradeStars.toLocaleString()} ⭐`
                });
            }
        }

        // Статус распродажи
        if (newGift.soldOut && !oldGift.soldOut) {
            changes.push({
                icon: '🔴',
                text: 'Status: SOLD OUT!'
            });
        }

        if (changes.length > 0) {
            await this.notifyGiftUpdate(newGift, changes);
        }
    }

    /**
     * Уведомление об обновлении
     */
    async notifyGiftUpdate(gift, changes) {
        let message = this.formatHeader('Gift Alerts', '🔄');
        message += '\n<b>Gift status updated!</b>\n\n';
        message += `<b>Price:</b> ${gift.stars.toLocaleString()} ⭐\n`;
        
        if (gift.upgradeStars > 0) {
            message += `<b>Upgrade price:</b> ${gift.upgradeStars.toLocaleString()} ⭐\n`;
        }
        
        message += '\n<b>Changes:</b>\n';
        for (const change of changes) {
            message += `${change.icon} ${change.text}\n`;
        }
        
        message += `\n<i>⏰ ${this.formatDateTime()}</i>`;
        
        await this.sendNotification(message);
        console.log(`🔄 Обновление подарка`);
    }

    /**
     * Уведомление об удалении
     */
    async notifyDeletedGift(gift) {
        let message = this.formatHeader('Gift Alerts', '🗑️');
        message += '\n<b>❌ A gift has been removed.</b>\n\n';
        message += `<b>Price:</b> ${gift.stars.toLocaleString()} ⭐\n`;
        
        if (gift.availabilityTotal > 0) {
            const sold = gift.availabilityTotal - (gift.availabilityRemains || 0);
            message += `<b>Total sold:</b> ${sold.toLocaleString()}\n`;
        }
        
        message += `\n<i>⏰ ${this.formatDateTime()}</i>`;
        
        await this.sendNotification(message);
        console.log(`🗑️ Подарок удалён`);
    }

    /**
     * Задержка
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Запуск мониторинга
     */
    async start() {
        try {
            console.log('═══════════════════════════════════════');
            console.log('🎁  Telegram Gift Monitor v6.0');
            console.log('    Powered by changes.tg API');
            console.log('═══════════════════════════════════════\n');

            await this.initialize();
            await this.loadState();

            // Уведомление о запуске
            const startMessage = this.formatHeader('Gift Alerts', '🤖');
            await this.sendNotification(
                startMessage +
                '\n<b>✅ Monitoring system activated!</b>\n\n' +
                `<b>Check interval:</b> ${this.config.checkInterval / 1000} seconds\n` +
                `<b>API Source:</b> changes.tg\n` +
                `<b>Status:</b> Online 🟢\n\n` +
                `<i>⏰ ${this.formatDateTime()}</i>`
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

    /**
     * Остановка
     */
    stop() {
        console.log('\n⏹️  Остановка мониторинга...');
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
            console.error('   Получите у @BotFather');
            console.error('\n   ИЛИ установите useTelegramClient: true');
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
