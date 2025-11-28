/**
 * USOM Zararlı URL Arşiv Botu
 * Tüm sayfaları tarar ve FILE veya REDIS'e kaydeder
 * Duplicate kontrolü ile mükerrer kayıtları önler
 */

const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');

// ============================================================================
// .ENV OKUYUCU
// ============================================================================

function loadEnv() {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return {};

    const env = {};
    const content = fs.readFileSync(envPath, 'utf8');

    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        const eqIndex = trimmed.indexOf('=');
        if (eqIndex === -1) continue;

        const key = trimmed.substring(0, eqIndex).trim();
        const value = trimmed.substring(eqIndex + 1).trim();
        env[key] = value;
    }

    return env;
}

const env = loadEnv();

// ============================================================================
// YAPILANDIRMA SABİTLERİ
// ============================================================================

const BASE_URL = env.BASE_URL || 'https://www.usom.gov.tr/api/address/index';
const OUTPUT_TYPE = (env.OUTPUT_TYPE || 'FILE').toUpperCase();
const OUTPUT_FILE = env.OUTPUT_FILE || 'usom-archive.json';
const TEMP_FILE = env.TEMP_FILE || 'usom-archive-temp.json';
const PARALLEL_REQUESTS = parseInt(env.PARALLEL_REQUESTS, 10) || 1;
const DELAY_MS = parseInt(env.DELAY_MS, 10) || 1500;
const SAVE_INTERVAL = parseInt(env.SAVE_INTERVAL, 10) || 10;

// Redis yapılandırması
const REDIS_HOST = env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(env.REDIS_PORT, 10) || 6379;
const REDIS_PASSWORD = env.REDIS_PASSWORD || '';
const REDIS_DB = parseInt(env.REDIS_DB, 10) || 0;
const REDIS_TLS = env.REDIS_TLS === 'true';
const REDIS_KEY_PREFIX = env.REDIS_KEY_PREFIX || 'usom:';

// Network interface'leri
const INTERFACES = env.INTERFACES
    ? env.INTERFACES.split(',').map(ip => ip.trim()).filter(ip => ip)
    : [];

// Webhook yapılandırması
const WEBHOOK_ENABLED = env.WEBHOOK_ENABLED === 'true';
const WEBHOOK_URL = env.WEBHOOK_URL || '';
const WEBHOOK_TYPE = (env.WEBHOOK_TYPE || 'generic').toLowerCase(); // generic, telegram, discord
const TELEGRAM_CHAT_ID = env.TELEGRAM_CHAT_ID || '';

// ============================================================================
// WEBHOOK BİLDİRİM SİSTEMİ
// ============================================================================

class WebhookNotifier {
    constructor(enabled, url, type, options = {}) {
        this.url = url;
        this.type = type;
        this.chatId = options.chatId || '';
        this.enabled = enabled && !!url; // WEBHOOK_ENABLED=true VE URL dolu olmalı
    }

    // HTTP POST isteği gönder
    _post(url, data) {
        return new Promise((resolve, reject) => {
            const urlObj = new URL(url);
            const postData = JSON.stringify(data);

            const options = {
                hostname: urlObj.hostname,
                port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
                path: urlObj.pathname + urlObj.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                }
            };

            const protocol = urlObj.protocol === 'https:' ? https : require('http');
            const req = protocol.request(options, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve({ status: res.statusCode, body });
                    } else {
                        reject(new Error(`HTTP ${res.statusCode}: ${body}`));
                    }
                });
            });

            req.on('error', reject);
            req.write(postData);
            req.end();
        });
    }

    // Telegram formatında mesaj oluştur
    _formatTelegram(title, message, stats) {
        let text = `🔔 *${this._escapeMarkdown(title)}*\n\n`;
        text += `${this._escapeMarkdown(message)}\n\n`;
        if (stats) {
            text += `📊 *İstatistikler:*\n`;
            text += `• Yeni kayıt: \`${stats.added.toLocaleString()}\`\n`;
            text += `• Atlanan: \`${stats.skipped.toLocaleString()}\`\n`;
            text += `• Toplam: \`${stats.total.toLocaleString()}\`\n`;
            if (stats.duration) text += `• Süre: \`${stats.duration}\`\n`;
        }
        return text;
    }

    // Telegram Markdown escape
    _escapeMarkdown(text) {
        return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
    }

    // Discord embed formatı
    _formatDiscord(title, message, stats) {
        const embed = {
            title: `🔔 ${title}`,
            description: message,
            color: 0x00ff00, // Yeşil
            timestamp: new Date().toISOString()
        };

        if (stats) {
            embed.fields = [
                { name: '📥 Yeni Kayıt', value: stats.added.toLocaleString(), inline: true },
                { name: '⏭️ Atlanan', value: stats.skipped.toLocaleString(), inline: true },
                { name: '📊 Toplam', value: stats.total.toLocaleString(), inline: true }
            ];
            if (stats.duration) {
                embed.fields.push({ name: '⏱️ Süre', value: stats.duration, inline: true });
            }
        }

        return { embeds: [embed] };
    }

    // Generic webhook formatı
    _formatGeneric(title, message, stats) {
        return {
            event: 'usom_scraper',
            title,
            message,
            stats,
            timestamp: new Date().toISOString()
        };
    }

    // Bildirim gönder
    async send(title, message, stats = null) {
        if (!this.enabled) return false;

        try {
            let payload;
            let url = this.url;

            switch (this.type) {
                case 'telegram':
                    // Telegram Bot API formatı
                    payload = {
                        chat_id: this.chatId,
                        text: this._formatTelegram(title, message, stats),
                        parse_mode: 'MarkdownV2'
                    };
                    break;

                case 'discord':
                    payload = this._formatDiscord(title, message, stats);
                    break;

                default: // generic
                    payload = this._formatGeneric(title, message, stats);
            }

            await this._post(url, payload);
            return true;
        } catch (err) {
            // Webhook hatası sessizce logla, ana işlemi durdurma
            console.error(`\n   ⚠️ Webhook hatası: ${err.message}`);
            return false;
        }
    }

    // Başarılı tamamlanma bildirimi
    async notifyComplete(stats) {
        return this.send(
            'USOM Tarama Tamamlandı',
            `Tarama başarıyla tamamlandı.`,
            stats
        );
    }

    // Hata bildirimi
    async notifyError(error) {
        return this.send(
            'USOM Tarama Hatası',
            `Kritik hata oluştu: ${error.message}`,
            null
        );
    }
}

// Global webhook instance
const webhook = new WebhookNotifier(WEBHOOK_ENABLED, WEBHOOK_URL, WEBHOOK_TYPE, {
    chatId: TELEGRAM_CHAT_ID
});

// ============================================================================
// REDIS CLIENT (RESP Protokolü - Harici Bağımlılık Yok)
// ============================================================================

class SimpleRedisClient {
    constructor(options = {}) {
        this.host = options.host || 'localhost';
        this.port = options.port || 6379;
        this.password = options.password || '';
        this.db = options.db || 0;
        this.useTls = options.tls || false;
        this.socket = null;
        this.connected = false;
        this.connecting = false;
        this.responseBuffer = '';
        this.responseQueue = [];

        // Reconnect yapılandırması
        this.maxReconnectAttempts = options.maxReconnectAttempts || 10;
        this.reconnectDelay = options.reconnectDelay || 1000; // ms
        this.reconnectAttempts = 0;
    }

    // RESP protokolü ile komut oluştur
    _buildCommand(args) {
        let cmd = `*${args.length}\r\n`;
        for (const arg of args) {
            const str = String(arg);
            cmd += `$${Buffer.byteLength(str)}\r\n${str}\r\n`;
        }
        return cmd;
    }

    // RESP yanıtını parse et
    _parseResponse(data) {
        const type = data[0];
        const content = data.slice(1);

        switch (type) {
            case '+': // Simple string
                return content.split('\r\n')[0];
            case '-': // Error
                throw new Error(content.split('\r\n')[0]);
            case ':': // Integer
                return parseInt(content.split('\r\n')[0], 10);
            case '$': // Bulk string
                const len = parseInt(content.split('\r\n')[0], 10);
                if (len === -1) return null;
                const start = content.indexOf('\r\n') + 2;
                return content.slice(start, start + len);
            case '*': // Array
                const count = parseInt(content.split('\r\n')[0], 10);
                if (count === -1) return null;
                const results = [];
                let remaining = content.slice(content.indexOf('\r\n') + 2);
                for (let i = 0; i < count; i++) {
                    const parsed = this._parseResponse(remaining);
                    results.push(parsed.value);
                    remaining = parsed.remaining;
                }
                return { value: results, remaining };
            default:
                return content;
        }
    }

    // Tek bir RESP yanıtını parse et ve kalan veriyi döndür
    _parseSingleResponse(data) {
        const type = data[0];
        const content = data.slice(1);

        switch (type) {
            case '+': {
                const end = content.indexOf('\r\n');
                return { value: content.slice(0, end), remaining: content.slice(end + 2) };
            }
            case '-': {
                const end = content.indexOf('\r\n');
                throw new Error(content.slice(0, end));
            }
            case ':': {
                const end = content.indexOf('\r\n');
                return { value: parseInt(content.slice(0, end), 10), remaining: content.slice(end + 2) };
            }
            case '$': {
                const lenEnd = content.indexOf('\r\n');
                const len = parseInt(content.slice(0, lenEnd), 10);
                if (len === -1) return { value: null, remaining: content.slice(lenEnd + 2) };
                const start = lenEnd + 2;
                return { value: content.slice(start, start + len), remaining: content.slice(start + len + 2) };
            }
            case '*': {
                const countEnd = content.indexOf('\r\n');
                const count = parseInt(content.slice(0, countEnd), 10);
                if (count === -1) return { value: null, remaining: content.slice(countEnd + 2) };
                const results = [];
                let remaining = content.slice(countEnd + 2);
                for (let i = 0; i < count; i++) {
                    const parsed = this._parseSingleResponse(remaining);
                    results.push(parsed.value);
                    remaining = parsed.remaining;
                }
                return { value: results, remaining };
            }
            default:
                return { value: null, remaining: '' };
        }
    }

    async connect() {
        if (this.connecting) {
            // Zaten bağlanma işlemi devam ediyor
            await this._waitForConnection();
            return;
        }

        this.connecting = true;

        return new Promise((resolve, reject) => {
            const connectOptions = { host: this.host, port: this.port };

            const onConnect = () => {
                this.connected = true;
                this.connecting = false;
                this.reconnectAttempts = 0; // Başarılı bağlantıda sıfırla
                this._authenticate().then(resolve).catch(reject);
            };

            if (this.useTls) {
                this.socket = tls.connect(connectOptions, onConnect);
            } else {
                this.socket = net.connect(connectOptions, onConnect);
            }

            this.socket.on('error', (err) => {
                this.connected = false;
                this.connecting = false;
                reject(err);
            });

            this.socket.on('close', () => {
                this.connected = false;
                this.connecting = false;
            });

            this.socket.setEncoding('utf8');
        });
    }

    // Bağlantının tamamlanmasını bekle
    async _waitForConnection(timeout = 5000) {
        const start = Date.now();
        while (this.connecting && Date.now() - start < timeout) {
            await new Promise(r => setTimeout(r, 100));
        }
        if (!this.connected) {
            throw new Error('Bağlantı zaman aşımı');
        }
    }

    // Otomatik yeniden bağlanma
    async reconnect() {
        if (this.connected || this.connecting) return true;

        this.reconnectAttempts++;

        if (this.reconnectAttempts > this.maxReconnectAttempts) {
            throw new Error(`Redis: Maksimum yeniden bağlanma denemesi aşıldı (${this.maxReconnectAttempts})`);
        }

        const delay = this.reconnectDelay * this.reconnectAttempts;
        console.log(`\n   🔄 Redis yeniden bağlanıyor... (deneme ${this.reconnectAttempts}/${this.maxReconnectAttempts}, ${delay}ms bekleniyor)`);

        await new Promise(r => setTimeout(r, delay));

        try {
            // Eski socket'i temizle
            if (this.socket) {
                this.socket.removeAllListeners();
                this.socket.destroy();
                this.socket = null;
            }

            await this.connect();
            console.log(`   ✅ Redis yeniden bağlandı.`);
            return true;
        } catch (err) {
            console.error(`   ❌ Yeniden bağlanma başarısız: ${err.message}`);
            return this.reconnect(); // Recursive retry
        }
    }

    // Bağlantıyı kontrol et ve gerekirse yeniden bağlan
    async ensureConnection() {
        if (!this.connected && !this.connecting) {
            await this.reconnect();
        }
    }

    async _authenticate() {
        if (this.password) {
            await this._sendCommand(['AUTH', this.password]);
        }
        if (this.db !== 0) {
            await this._sendCommand(['SELECT', this.db]);
        }
    }

    async _sendCommand(args, retryOnDisconnect = true) {
        // Bağlantıyı kontrol et
        if (!this.connected && !this.connecting) {
            if (retryOnDisconnect) {
                await this.ensureConnection();
            } else {
                throw new Error('Redis bağlantısı yok');
            }
        }

        return new Promise((resolve, reject) => {
            if (!this.connected || !this.socket) {
                return reject(new Error('Redis bağlantısı yok'));
            }

            const cmd = this._buildCommand(args);
            let responseData = '';

            const onData = (data) => {
                responseData += data;
                try {
                    const parsed = this._parseSingleResponse(responseData);
                    this.socket.removeListener('data', onData);
                    this.socket.removeListener('error', onError);
                    resolve(parsed.value);
                } catch (e) {
                    // Henüz tam yanıt gelmedi, beklemeye devam et
                    if (!e.message.includes('Redis')) {
                        // Parse hatası değilse bekle
                    } else {
                        this.socket.removeListener('data', onData);
                        this.socket.removeListener('error', onError);
                        reject(e);
                    }
                }
            };

            const onError = async (err) => {
                this.socket.removeListener('data', onData);
                this.socket.removeListener('error', onError);
                this.connected = false;

                // Bağlantı hatası - yeniden bağlanmayı dene
                if (retryOnDisconnect) {
                    try {
                        await this.reconnect();
                        // Yeniden bağlandıktan sonra komutu tekrar dene
                        const result = await this._sendCommand(args, false);
                        resolve(result);
                    } catch (reconnectErr) {
                        reject(reconnectErr);
                    }
                } else {
                    reject(err);
                }
            };

            this.socket.on('data', onData);
            this.socket.once('error', onError);
            this.socket.write(cmd);
        });
    }

    async disconnect() {
        if (this.socket) {
            this.socket.end();
            this.connected = false;
        }
    }

    // Redis komutları
    async ping() {
        return this._sendCommand(['PING']);
    }

    async set(key, value) {
        return this._sendCommand(['SET', key, value]);
    }

    async get(key) {
        return this._sendCommand(['GET', key]);
    }

    async del(...keys) {
        return this._sendCommand(['DEL', ...keys]);
    }

    async sadd(key, ...members) {
        return this._sendCommand(['SADD', key, ...members]);
    }

    async sismember(key, member) {
        const result = await this._sendCommand(['SISMEMBER', key, member]);
        return result === 1;
    }

    async smembers(key) {
        return this._sendCommand(['SMEMBERS', key]);
    }

    async scard(key) {
        return this._sendCommand(['SCARD', key]);
    }

    async hset(key, ...fieldValues) {
        return this._sendCommand(['HSET', key, ...fieldValues]);
    }

    async hgetall(key) {
        const result = await this._sendCommand(['HGETALL', key]);
        if (!result || result.length === 0) return null;
        const obj = {};
        for (let i = 0; i < result.length; i += 2) {
            obj[result[i]] = result[i + 1];
        }
        return obj;
    }

    async keys(pattern) {
        return this._sendCommand(['KEYS', pattern]);
    }

    async dbsize() {
        return this._sendCommand(['DBSIZE']);
    }

    // Gerçek Pipeline desteği - tüm komutları tek seferde gönder, yanıtları toplu al
    async pipeline(commands, retryOnDisconnect = true) {
        if (commands.length === 0) return [];

        // Bağlantıyı kontrol et
        if (!this.connected && !this.connecting) {
            if (retryOnDisconnect) {
                await this.ensureConnection();
            } else {
                throw new Error('Redis bağlantısı yok');
            }
        }

        return new Promise((resolve, reject) => {
            if (!this.connected || !this.socket) {
                return reject(new Error('Redis bağlantısı yok'));
            }

            // Tüm komutları birleştir
            let batch = '';
            for (const cmd of commands) {
                batch += this._buildCommand(cmd);
            }

            const results = [];
            let responseData = '';
            let expectedCount = commands.length;

            const onData = (data) => {
                responseData += data;

                // Tüm yanıtları parse etmeye çalış
                try {
                    let remaining = responseData;
                    while (results.length < expectedCount && remaining.length > 0) {
                        const parsed = this._parseSingleResponse(remaining);
                        results.push(parsed.value);
                        remaining = parsed.remaining;
                    }

                    // Tüm yanıtlar alındı
                    if (results.length === expectedCount) {
                        this.socket.removeListener('data', onData);
                        resolve(results);
                    }
                } catch (e) {
                    // Henüz tam yanıt gelmedi, beklemeye devam et
                    if (e.message && e.message.includes('Redis')) {
                        this.socket.removeListener('data', onData);
                        reject(e);
                    }
                }
            };

            this.socket.on('data', onData);
            this.socket.write(batch);
        });
    }

    // Batch SMEMBERS - birden fazla key için üyelik kontrolü
    async smismember(key, ...members) {
        // Redis 6.2+ SMISMEMBER komutu, düşük versiyonlar için pipeline ile SISMEMBER
        const commands = members.map(m => ['SISMEMBER', key, m]);
        const results = await this.pipeline(commands);
        return results.map(r => r === 1);
    }
}

// ============================================================================
// STORAGE ABSTRACTION LAYER
// ============================================================================

// FILE Storage
class FileStorage {
    constructor(outputFile, tempFile) {
        this.outputFile = outputFile;
        this.tempFile = tempFile;
        this.existingIds = new Set();
        this.records = [];
        this.metadata = null;
        this.stats = { added: 0, skipped: 0 };
    }

    async init() {
        // Mevcut dosyadan ID'leri yükle
        if (fs.existsSync(this.outputFile)) {
            try {
                const content = fs.readFileSync(this.outputFile, 'utf8');
                const data = JSON.parse(content);
                if (data.models) {
                    for (const m of data.models) {
                        this.existingIds.add(m.id);
                    }
                    this.records = data.models;
                    this.metadata = data;
                }
            } catch (e) {
                // Dosya bozuk, sıfırdan başla
            }
        }
    }

    async exists(id) {
        return this.existingIds.has(id);
    }

    async addRecord(record) {
        if (this.existingIds.has(record.id)) {
            this.stats.skipped++;
            return false;
        }
        this.existingIds.add(record.id);
        this.records.unshift(record); // En yeniler başta
        this.stats.added++;
        return true;
    }

    async addRecords(records) {
        let added = 0;
        for (const record of records) {
            if (await this.addRecord(record)) {
                added++;
            }
        }
        return added;
    }

    async getExistingIds() {
        return this.existingIds;
    }

    async getLastDate() {
        if (this.records.length === 0) return null;
        const sorted = [...this.records].sort((a, b) => new Date(b.date) - new Date(a.date));
        return sorted[0].date.split(' ')[0];
    }

    async getTotalCount() {
        return this.records.length;
    }

    async saveTemp(data) {
        fs.writeFileSync(this.tempFile, JSON.stringify(data, null, 2));
    }

    async loadTemp() {
        if (!fs.existsSync(this.tempFile)) return null;
        try {
            return JSON.parse(fs.readFileSync(this.tempFile, 'utf8'));
        } catch (e) {
            return null;
        }
    }

    async clearTemp() {
        if (fs.existsSync(this.tempFile)) {
            fs.unlinkSync(this.tempFile);
        }
    }

    async save(metadata) {
        const result = {
            ...metadata,
            totalCount: this.records.length,
            models: this.records
        };
        fs.writeFileSync(this.outputFile, JSON.stringify(result, null, 2));
        return this.outputFile;
    }

    async getStats() {
        return this.stats;
    }

    async close() {
        // FILE storage için kapatma işlemi yok
    }
}

// REDIS Storage
class RedisStorage {
    constructor(options) {
        this.client = new SimpleRedisClient(options);
        this.prefix = options.prefix || 'usom:';
        this.stats = { added: 0, skipped: 0 };
    }

    async init() {
        await this.client.connect();
        console.log(`   ✓ Redis bağlantısı kuruldu (${REDIS_HOST}:${REDIS_PORT})`);
    }

    async exists(id) {
        return this.client.sismember(`${this.prefix}ids`, id);
    }

    async addRecord(record) {
        const id = record.id;

        // Duplicate kontrolü
        if (await this.exists(id)) {
            this.stats.skipped++;
            return false;
        }

        // ID'yi set'e ekle
        await this.client.sadd(`${this.prefix}ids`, id);

        // Kaydı hash olarak kaydet
        await this.client.hset(
            `${this.prefix}record:${id}`,
            'id', id,
            'url', record.url || '',
            'type', record.type || '',
            'desc', record.desc || '',
            'source', record.source || '',
            'date', record.date || '',
            'criticality_level', record.criticality_level || 0,
            'connectiontype', record.connectiontype || ''
        );

        this.stats.added++;
        return true;
    }

    // Pipeline ile toplu kayıt ekleme - 10-50x daha hızlı
    async addRecords(records) {
        if (records.length === 0) return 0;

        // Önce tüm ID'lerin varlığını toplu kontrol et
        const ids = records.map(r => r.id);
        const existsResults = await this.client.smismember(`${this.prefix}ids`, ...ids);

        // Yeni kayıtları filtrele
        const newRecords = [];
        for (let i = 0; i < records.length; i++) {
            if (existsResults[i]) {
                this.stats.skipped++;
            } else {
                newRecords.push(records[i]);
            }
        }

        if (newRecords.length === 0) return 0;

        // Pipeline ile toplu ekleme
        const commands = [];

        // Tüm yeni ID'leri tek SADD ile ekle
        const newIds = newRecords.map(r => r.id);
        commands.push(['SADD', `${this.prefix}ids`, ...newIds]);

        // Her kayıt için HSET komutu
        for (const record of newRecords) {
            commands.push([
                'HSET',
                `${this.prefix}record:${record.id}`,
                'id', record.id,
                'url', record.url || '',
                'type', record.type || '',
                'desc', record.desc || '',
                'source', record.source || '',
                'date', record.date || '',
                'criticality_level', record.criticality_level || 0,
                'connectiontype', record.connectiontype || ''
            ]);
        }

        // Tüm komutları tek seferde gönder
        await this.client.pipeline(commands);

        this.stats.added += newRecords.length;
        return newRecords.length;
    }

    async getExistingIds() {
        const ids = await this.client.smembers(`${this.prefix}ids`);
        return new Set(ids ? ids.map(id => parseInt(id, 10)) : []);
    }

    async getLastDate() {
        const meta = await this.client.get(`${this.prefix}meta`);
        if (meta) {
            const data = JSON.parse(meta);
            return data.lastDate || null;
        }
        return null;
    }

    async getTotalCount() {
        return this.client.scard(`${this.prefix}ids`);
    }

    async saveTemp(data) {
        await this.client.set(`${this.prefix}temp:data`, JSON.stringify(data));
    }

    async loadTemp() {
        const data = await this.client.get(`${this.prefix}temp:data`);
        return data ? JSON.parse(data) : null;
    }

    async clearTemp() {
        await this.client.del(`${this.prefix}temp:data`);
    }

    async save(metadata) {
        // Metadata'yı kaydet
        const meta = {
            ...metadata,
            totalCount: await this.getTotalCount(),
            lastDate: new Date().toISOString()
        };
        await this.client.set(`${this.prefix}meta`, JSON.stringify(meta));
        return `Redis (${this.prefix}*)`;
    }

    async getStats() {
        return this.stats;
    }

    async getRedisStats() {
        const stats = {
            totalRecords: 0,
            totalKeys: 0,
            memoryUsage: 'N/A',
            oldestRecord: null,
            newestRecord: null,
            typeBreakdown: {}
        };

        // Toplam kayıt sayısı
        stats.totalRecords = await this.client.scard(`${this.prefix}ids`);

        // Toplam key sayısı (SCAN ile)
        let cursor = '0';
        let keyCount = 0;
        do {
            const scanResult = await this.client._sendCommand(['SCAN', cursor, 'MATCH', `${this.prefix}*`, 'COUNT', '1000']);
            cursor = scanResult[0];
            keyCount += scanResult[1].length;
        } while (cursor !== '0');
        stats.totalKeys = keyCount;

        // Bellek kullanımı
        try {
            const info = await this.client._sendCommand(['INFO', 'memory']);
            const match = info.match(/used_memory_human:([^\r\n]+)/);
            if (match) stats.memoryUsage = match[1];
        } catch (e) { /* ignore */ }

        // Örnek kayıtlardan tarih ve tür bilgisi al
        if (stats.totalRecords > 0) {
            const sampleIds = await this.client._sendCommand(['SRANDMEMBER', `${this.prefix}ids`, '100']);

            let oldest = null;
            let newest = null;
            const types = {};

            for (const id of sampleIds) {
                const record = await this.client.hgetall(`${this.prefix}record:${id}`);
                if (record) {
                    // Tarih kontrolü
                    if (record.date) {
                        const date = new Date(record.date);
                        if (!oldest || date < oldest) oldest = date;
                        if (!newest || date > newest) newest = date;
                    }
                    // Tür sayımı
                    if (record.type) {
                        types[record.type] = (types[record.type] || 0) + 1;
                    }
                }
            }

            if (oldest) stats.oldestRecord = oldest.toISOString().split('T')[0];
            if (newest) stats.newestRecord = newest.toISOString().split('T')[0];
            stats.typeBreakdown = types;
        }

        return stats;
    }

    async clearAll() {
        // Mevcut DB'deki key sayısını al
        const beforeCount = await this.client.dbsize();

        // FLUSHDB ile tüm DB'yi temizle
        await this.client._sendCommand(['FLUSHDB']);

        return beforeCount;
    }

    // Redis'ten tüm kayıtları çek ve JSON dosyasına export et
    async exportToFile(outputFile, showProgress = null) {
        const ids = await this.client.smembers(`${this.prefix}ids`);
        if (!ids || ids.length === 0) {
            return { count: 0, file: outputFile };
        }

        const totalCount = ids.length;
        const records = [];
        const startTime = Date.now();

        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            const record = await this.client.hgetall(`${this.prefix}record:${id}`);
            if (record) {
                // Tipleri düzelt
                record.id = parseInt(record.id, 10);
                record.criticality_level = parseInt(record.criticality_level, 10) || 0;
                records.push(record);
            }

            // Progress göster
            if (showProgress && (i + 1) % 1000 === 0) {
                const percent = (((i + 1) / totalCount) * 100).toFixed(1);
                const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
                process.stdout.write(`\r   [${i + 1}/${totalCount}] %${percent} | Geçen: ${elapsedSec}s    `);
            }
        }

        // Tarihe göre sırala (en yeniler başta)
        records.sort((a, b) => new Date(b.date) - new Date(a.date));

        // Metadata'yı al
        const metaStr = await this.client.get(`${this.prefix}meta`);
        const meta = metaStr ? JSON.parse(metaStr) : {};

        // JSON dosyasına kaydet
        const result = {
            exportDate: new Date().toISOString(),
            source: meta.source || 'USOM - Ulusal Siber Olaylara Müdahale Merkezi',
            apiUrl: meta.apiUrl || BASE_URL,
            dateFilter: meta.dateFilter || { from: null, to: null },
            totalCount: records.length,
            pageCount: meta.pageCount || 0,
            models: records
        };

        fs.writeFileSync(outputFile, JSON.stringify(result, null, 2));

        return { count: records.length, file: outputFile };
    }

    async close() {
        await this.client.disconnect();
    }
}

// Storage factory
function createStorage() {
    if (OUTPUT_TYPE === 'REDIS') {
        return new RedisStorage({
            host: REDIS_HOST,
            port: REDIS_PORT,
            password: REDIS_PASSWORD,
            db: REDIS_DB,
            tls: REDIS_TLS,
            prefix: REDIS_KEY_PREFIX
        });
    }
    return new FileStorage(OUTPUT_FILE, TEMP_FILE);
}

// ============================================================================
// NETWORK & UTILITY FONKSİYONLARI
// ============================================================================

let interfaceIndex = 0;

function getNextInterface() {
    if (INTERFACES.length === 0) return null;
    const ip = INTERFACES[interfaceIndex];
    interfaceIndex = (interfaceIndex + 1) % INTERFACES.length;
    return ip;
}

function shortIp(ip) {
    if (!ip) return null;
    const parts = ip.split('.');
    if (parts.length === 4) {
        return `*.${parts[2]}.${parts[3]}`;
    }
    return ip;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function formatTime(seconds) {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) {
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return `${m}dk ${s}s`;
    }
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}sa ${m}dk`;
}

function buildUrl(page, dateFrom, dateTo) {
    let url = `${BASE_URL}?page=${page}`;
    if (dateFrom) url += `&date_gte=${dateFrom}`;
    if (dateTo) url += `&date_lte=${dateTo}`;
    return url;
}

// ============================================================================
// HTTP İSTEKLERİ
// ============================================================================

function fetchPage(page, localAddress, dateFrom, dateTo) {
    return new Promise((resolve, reject) => {
        const url = buildUrl(page, dateFrom, dateTo);

        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0',
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
                'Connection': 'keep-alive',
                'Cache-Control': 'no-cache',
            }
        };

        if (localAddress) {
            options.localAddress = localAddress;
        }

        https.get(url, options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode} sayfa ${page}`));
                    return;
                }

                if (data.trim().startsWith('<')) {
                    reject(new Error(`Rate limit sayfa ${page}`));
                    return;
                }

                try {
                    const json = JSON.parse(data);
                    resolve(json);
                } catch (err) {
                    reject(new Error(`JSON parse hatası sayfa ${page}: ${err.message}`));
                }
            });
        }).on('error', (err) => {
            reject(new Error(`HTTP hatası sayfa ${page}: ${err.message}`));
        });
    });
}

async function fetchPageWithRetry(page, dateFrom, dateTo) {
    let attempt = 0;
    const localAddress = getNextInterface();

    while (true) {
        attempt++;
        try {
            const data = await fetchPage(page, localAddress, dateFrom, dateTo);
            return { data, page, ip: localAddress };
        } catch (err) {
            let waitTime;
            const ipInfo = localAddress ? ` [${localAddress}]` : '';
            if (err.message.includes('429') || err.message.includes('Rate limit')) {
                waitTime = Math.min(5000 * attempt, 30000);
                process.stdout.write(`\n   ⏳ Sayfa ${page}${ipInfo} - Rate limit (deneme ${attempt}) - ${waitTime / 1000}s bekleniyor...`);
            } else {
                waitTime = Math.min(3000 * attempt, 15000);
                process.stdout.write(`\n   ⚠️ Sayfa ${page}${ipInfo} - ${err.message} (deneme ${attempt}) - ${waitTime / 1000}s bekleniyor...`);
            }
            await sleep(waitTime);
        }
    }
}

async function fetchBatch(pages, dateFrom, dateTo) {
    const promises = pages.map(page => fetchPageWithRetry(page, dateFrom, dateTo));
    return Promise.all(promises);
}

// ============================================================================
// PROGRESS BAR
// ============================================================================

function showProgress(current, total, startTime, pageIpMap, stats, redisCount = null) {
    const percent = ((current / total) * 100).toFixed(1);
    const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
    const etaSec = current > 0 ? Math.floor((elapsedSec / current) * (total - current)) : 0;

    // Basit progress bar
    const barWidth = 20;
    const filled = Math.round((current / total) * barWidth);
    const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);

    let output = `\r[${bar}] %${percent} | ${current.toLocaleString()}/${total.toLocaleString()} | ${formatTime(etaSec)} kaldı`;

    // Redis kayıt sayısı
    if (redisCount !== null) {
        output += ` | Redis: ${redisCount.toLocaleString()}`;
    }

    // Duplicate istatistikleri
    if (stats) {
        output += ` | +${stats.added.toLocaleString()}`;
        if (stats.skipped > 0) {
            output += ` (${stats.skipped.toLocaleString()} atlandı)`;
        }
    }

    // Satırı temizle ve yaz
    output += '          ';
    process.stdout.write(output);
}

// ============================================================================
// IP TEST FONKSİYONU
// ============================================================================

async function testInterfaces() {
    console.log('='.repeat(60));
    console.log('Network Interface IP Testi');
    console.log('='.repeat(60));

    const checkExternalIP = (localAddress = null) => {
        return new Promise((resolve, reject) => {
            const options = {
                hostname: 'api.ipify.org',
                port: 443,
                path: '/?format=json',
                method: 'GET',
                timeout: 10000,
                headers: { 'User-Agent': 'curl/7.68.0' }
            };

            if (localAddress) {
                options.localAddress = localAddress;
            }

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const ip = JSON.parse(data).ip;
                        resolve({ localAddress, externalIP: ip });
                    } catch (e) {
                        reject(new Error(`Parse hatası: ${e.message}`));
                    }
                });
            });

            req.on('error', (err) => reject(new Error(err.code || err.message)));
            req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
            req.end();
        });
    };

    console.log(`\n📡 IP Kontrol Servisi: https://api.ipify.org\n`);

    // Varsayılan interface
    console.log('🔍 Varsayılan Interface:');
    try {
        const result = await checkExternalIP(null);
        console.log(`   ✅ Çıkış IP: ${result.externalIP}\n`);
    } catch (err) {
        console.log(`   ❌ Hata: ${err.message}\n`);
    }

    // Tanımlı interface'ler
    if (INTERFACES.length === 0) {
        console.log('⚠️  .env dosyasında INTERFACES tanımlı değil!');
        console.log('   💡 Örnek: INTERFACES=10.11.13.61,10.11.13.62,10.11.13.63\n');
        return;
    }

    console.log(`📋 Tanımlı Interface'ler (${INTERFACES.length} adet):\n`);

    const results = [];

    for (let i = 0; i < INTERFACES.length; i++) {
        const localIP = INTERFACES[i];
        process.stdout.write(`   [${i + 1}/${INTERFACES.length}] ${localIP} → `);

        try {
            const result = await checkExternalIP(localIP);
            console.log(`✅ ${result.externalIP}`);
            results.push({ local: localIP, external: result.externalIP, ok: true });
        } catch (err) {
            console.log(`❌ ${err.message}`);
            results.push({ local: localIP, external: null, ok: false });
        }

        await sleep(500);
    }

    // Özet
    console.log('\n' + '='.repeat(60));
    console.log('📊 ÖZET');
    console.log('='.repeat(60));

    const uniqueIPs = new Set(results.filter(r => r.ok).map(r => r.external));
    const successCount = results.filter(r => r.ok).length;

    console.log(`   Başarılı: ${successCount}/${INTERFACES.length}`);
    console.log(`   Benzersiz çıkış IP: ${uniqueIPs.size}`);

    if (uniqueIPs.size === 1 && successCount > 1) {
        console.log('\n   ⚠️  UYARI: Tüm interface\'ler AYNI çıkış IP\'sini kullanıyor!');
    } else if (uniqueIPs.size > 1) {
        console.log('\n   ✅ Farklı çıkış IP\'leri doğrulandı!');
    }

    console.log('\n   Çıkış IP\'leri:');
    uniqueIPs.forEach(ip => console.log(`   • ${ip}`));
    console.log('');
}

// ============================================================================
// YARDIM MESAJI
// ============================================================================

function showHelp() {
    console.log(`
╔════════════════════════════════════════════════════════════════╗
║           USOM Zararlı URL Arşiv Botu                          ║
╚════════════════════════════════════════════════════════════════╝

Kullanım:
  node usom-scraper.js [seçenek]

Seçenekler:
  --full                     Tüm arşivi çek
  --resume                   Yarıda kalan indirmeye devam et
  --update                   Sadece yeni kayıtları çek
  --date <başlangıç>         Belirli tarihten bugüne kadar
  --date <başlangıç> <bitiş> Tarih aralığı
  --export [dosya]           Redis'ten JSON dosyasına export et
  --clear-redis              Redis'teki tüm USOM verilerini sil
  --test-ip                  Network interface'lerin çıkış IP'lerini test et
  --stats                    Redis'teki kayıtların istatistiklerini göster

Tarih formatı: YYYY-MM-DD

Örnekler:
  node usom-scraper.js --full
  node usom-scraper.js --resume
  node usom-scraper.js --update
  node usom-scraper.js --date 2025-11-01
  node usom-scraper.js --export                    # ${OUTPUT_FILE} dosyasına
  node usom-scraper.js --export my-archive.json    # Belirtilen dosyaya
  node usom-scraper.js --clear-redis
  node usom-scraper.js --test-ip
  node usom-scraper.js --stats

Çıktı: ${OUTPUT_TYPE === 'REDIS' ? `Redis (${REDIS_HOST}:${REDIS_PORT})` : OUTPUT_FILE}
`);
}

// ============================================================================
// ANA FONKSİYON
// ============================================================================

async function main() {
    const args = process.argv.slice(2);

    // Argümanları parse et
    let MODE = null;
    let DATE_FROM = null;
    let DATE_TO = null;
    let EXPORT_FILE = null;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--full') {
            MODE = 'full';
        } else if (args[i] === '--resume') {
            MODE = 'resume';
        } else if (args[i] === '--update') {
            MODE = 'update';
        } else if (args[i] === '--clear-redis') {
            MODE = 'clear-redis';
        } else if (args[i] === '--test-ip') {
            MODE = 'test-ip';
        } else if (args[i] === '--stats') {
            MODE = 'stats';
        } else if (args[i] === '--export') {
            MODE = 'export';
            const nextArg = args[i + 1];
            if (nextArg && !nextArg.startsWith('--')) {
                EXPORT_FILE = nextArg;
                i++;
            }
        } else if (args[i] === '--date') {
            MODE = 'date';
            const nextArg = args[i + 1];
            const nextNextArg = args[i + 2];
            if (nextArg && !nextArg.startsWith('--')) {
                DATE_FROM = nextArg;
                i++;
                if (nextNextArg && !nextNextArg.startsWith('--')) {
                    DATE_TO = nextNextArg;
                    i++;
                }
            }
        } else if (args[i] === '--help' || args[i] === '-h') {
            showHelp();
            process.exit(0);
        }
    }

    if (!MODE) {
        showHelp();
        process.exit(0);
    }

    // --test-ip komutu (storage gerektirmez)
    if (MODE === 'test-ip') {
        await testInterfaces();
        process.exit(0);
    }

    if (MODE === 'date' && !DATE_FROM) {
        console.error('❌ Hata: --date seçeneği için en az bir tarih gerekli.');
        process.exit(1);
    }

    console.log('='.repeat(60));
    console.log('USOM Zararlı URL Arşiv Botu');
    console.log('='.repeat(60));

    // Storage oluştur
    const storage = createStorage();
    currentStorage = storage; // Graceful shutdown için global referans

    try {
        console.log(`\n📦 Çıktı tipi: ${OUTPUT_TYPE}`);
        await storage.init();

        // --clear-redis komutu
        if (MODE === 'clear-redis') {
            if (OUTPUT_TYPE !== 'REDIS') {
                console.error('❌ Hata: --clear-redis sadece REDIS modunda çalışır.');
                process.exit(1);
            }
            console.log('\n🗑️  Redis verileri siliniyor...');
            const deleted = await storage.clearAll();
            console.log(`✅ ${deleted} key silindi.`);
            await storage.close();
            process.exit(0);
        }

        // --stats komutu
        if (MODE === 'stats') {
            if (OUTPUT_TYPE !== 'REDIS') {
                console.error('❌ Hata: --stats sadece REDIS modunda çalışır.');
                process.exit(1);
            }
            console.log('\n📊 Redis İstatistikleri\n');
            const redisStats = await storage.getRedisStats();

            console.log(`   Toplam kayıt sayısı: ${redisStats.totalRecords.toLocaleString()}`);
            console.log(`   Toplam key sayısı: ${redisStats.totalKeys.toLocaleString()}`);
            console.log(`   Bellek kullanımı: ${redisStats.memoryUsage}`);

            if (redisStats.oldestRecord) {
                console.log(`\n   En eski kayıt: ${redisStats.oldestRecord}`);
            }
            if (redisStats.newestRecord) {
                console.log(`   En yeni kayıt: ${redisStats.newestRecord}`);
            }

            if (redisStats.typeBreakdown && Object.keys(redisStats.typeBreakdown).length > 0) {
                console.log('\n   Tür dağılımı:');
                for (const [type, count] of Object.entries(redisStats.typeBreakdown)) {
                    console.log(`   • ${type}: ${count.toLocaleString()}`);
                }
            }

            console.log('');
            await storage.close();
            process.exit(0);
        }

        // --export komutu
        if (MODE === 'export') {
            if (OUTPUT_TYPE !== 'REDIS') {
                console.error('❌ Hata: --export sadece REDIS modunda çalışır.');
                console.error('   OUTPUT_TYPE=FILE ise veriler zaten JSON dosyasında.');
                process.exit(1);
            }

            const exportFile = EXPORT_FILE || OUTPUT_FILE;
            const totalCount = await storage.getTotalCount();

            console.log(`\n📤 Redis'ten export ediliyor...`);
            console.log(`   Kaynak: Redis (${REDIS_HOST}:${REDIS_PORT})`);
            console.log(`   Hedef: ${exportFile}`);
            console.log(`   Toplam kayıt: ${totalCount.toLocaleString()}\n`);

            if (totalCount === 0) {
                console.log('⚠️  Redis\'te kayıt bulunamadı.');
                await storage.close();
                process.exit(0);
            }

            const startTime = Date.now();
            const result = await storage.exportToFile(exportFile, true);
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

            console.log(`\n\n✅ Export tamamlandı!`);
            console.log(`   Dosya: ${result.file}`);
            console.log(`   Kayıt sayısı: ${result.count.toLocaleString()}`);
            console.log(`   Süre: ${elapsed}s`);
            console.log(`   Boyut: ${(fs.statSync(result.file).size / 1024 / 1024).toFixed(2)} MB`);

            await storage.close();
            process.exit(0);
        }

        // Resume modu kontrolü
        let resumeData = null;
        if (MODE === 'resume') {
            resumeData = await storage.loadTemp();
            if (!resumeData) {
                console.error('❌ Hata: Devam edilecek indirme bulunamadı.');
                process.exit(1);
            }
            console.log(`📊 Kaldığı yer: Sayfa ${resumeData.lastBatch}`);
        }

        // Update modu: son tarihi al
        if (MODE === 'update') {
            const lastDate = await storage.getLastDate();
            if (lastDate) {
                DATE_FROM = lastDate;
                console.log(`📅 Son kayıt tarihi: ${lastDate}`);
            }
        }

        // İlk sayfayı al
        console.log('\n📡 İlk sayfa alınıyor...');
        const firstPageResult = await fetchPageWithRetry(0, DATE_FROM, DATE_TO);
        const firstPage = firstPageResult.data;

        const totalCount = firstPage.totalCount;
        const pageCount = firstPage.pageCount;

        console.log(`\n📊 İstatistikler:`);
        console.log(`   - API'deki toplam kayıt: ${totalCount.toLocaleString()}`);
        console.log(`   - Toplam sayfa: ${pageCount.toLocaleString()}`);
        console.log(`   - Mevcut kayıt: ${(await storage.getTotalCount()).toLocaleString()}`);
        if (DATE_FROM || DATE_TO) {
            console.log(`   - Tarih filtresi: ${DATE_FROM || 'Başlangıç'} → ${DATE_TO || 'Bugün'}`);
        }
        console.log(`   - Paralel istek: ${PARALLEL_REQUESTS}`);
        if (INTERFACES.length > 0) {
            console.log(`   - Network interface: ${INTERFACES.length} adet (round-robin)`);
        }

        // Tahmini süre
        const estimatedMinutes = Math.ceil((pageCount / PARALLEL_REQUESTS) * DELAY_MS / 1000 / 60);
        const estimatedTimeText = estimatedMinutes >= 60
            ? `${Math.floor(estimatedMinutes / 60)} saat ${estimatedMinutes % 60} dakika`
            : `${estimatedMinutes} dakika`;
        console.log(`   - Tahmini süre: ~${estimatedTimeText}`);

        // İlk sayfadaki kayıtları ekle
        let startBatch = 1;
        if (MODE === 'resume' && resumeData) {
            startBatch = resumeData.lastBatch + 1;
            console.log(`\n🔄 Sayfa ${startBatch}'den devam ediliyor...\n`);
        } else {
            await storage.addRecords(firstPage.models);
            console.log(`\n🚀 Tarama başlıyor...\n`);
        }

        const startTime = Date.now();

        // Graceful shutdown için global değişkenleri güncelle
        currentPageCount = pageCount;

        // Tüm sayfaları tara
        for (let batchStart = startBatch; batchStart < pageCount; batchStart += PARALLEL_REQUESTS) {
            // Graceful shutdown kontrolü
            if (isShuttingDown) {
                console.log('\n   ⏹️  Döngü durduruldu.');
                break;
            }

            // Global batch değerini güncelle (graceful shutdown için)
            currentBatch = batchStart;

            const batchPages = [];
            for (let i = 0; i < PARALLEL_REQUESTS && (batchStart + i) < pageCount; i++) {
                batchPages.push(batchStart + i);
            }

            const results = await fetchBatch(batchPages, DATE_FROM, DATE_TO);

            // Kayıtları storage'a ekle (duplicate kontrolü ile)
            for (const result of results) {
                await storage.addRecords(result.data.models);
            }

            // İlerlemeyi göster
            const currentPage = Math.min(batchStart + PARALLEL_REQUESTS, pageCount);
            const pageIpMap = results.map(r => ({ page: r.page, ip: r.ip }));
            const stats = await storage.getStats();
            const redisCount = OUTPUT_TYPE === 'REDIS' ? await storage.getTotalCount() : null;
            showProgress(currentPage, pageCount, startTime, pageIpMap, stats, redisCount);

            // Ara kayıt
            if (batchStart % SAVE_INTERVAL < PARALLEL_REQUESTS) {
                await storage.saveTemp({
                    lastBatch: batchStart,
                    pageCount: pageCount,
                    timestamp: new Date().toISOString()
                });
            }

            await sleep(DELAY_MS);
        }

        // Final kayıt
        const metadata = {
            exportDate: new Date().toISOString(),
            source: 'USOM - Ulusal Siber Olaylara Müdahale Merkezi',
            apiUrl: BASE_URL,
            dateFilter: { from: DATE_FROM, to: DATE_TO },
            pageCount: pageCount
        };

        console.log(`\n\n💾 Kaydediliyor...`);
        const savedTo = await storage.save(metadata);

        // Temp dosyasını temizle
        if (MODE === 'full' || MODE === 'resume') {
            await storage.clearTemp();
        }

        const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
        const finalStats = await storage.getStats();
        const finalCount = await storage.getTotalCount();

        console.log('\n' + '='.repeat(60));
        console.log('✅ TAMAMLANDI!');
        console.log('='.repeat(60));
        console.log(`📁 Çıktı: ${savedTo}`);
        console.log(`📊 Yeni kayıt: ${finalStats.added.toLocaleString()}`);
        console.log(`📊 Atlanan (mükerrer): ${finalStats.skipped.toLocaleString()}`);
        console.log(`📊 Toplam kayıt: ${finalCount.toLocaleString()}`);
        console.log(`⏱️  Toplam süre: ${totalTime} dakika`);

        if (OUTPUT_TYPE === 'FILE') {
            console.log(`📦 Dosya boyutu: ${(fs.statSync(OUTPUT_FILE).size / 1024 / 1024).toFixed(2)} MB`);
        }

        // Webhook bildirimi gönder
        await webhook.notifyComplete({
            added: finalStats.added,
            skipped: finalStats.skipped,
            total: finalCount,
            duration: `${totalTime} dakika`
        });

    } catch (err) {
        console.error('\n❌ Kritik hata:', err.message);
        // Hata bildirimi gönder
        await webhook.notifyError(err);
        process.exit(1);
    } finally {
        await storage.close();
    }

    // İşlem başarıyla tamamlandı, programı sonlandır
    process.exit(0);
}

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

// Global state for graceful shutdown
let isShuttingDown = false;
let currentStorage = null;
let shutdownReason = null;
let currentBatch = 0; // Ana döngüdeki mevcut batch
let currentPageCount = 0; // Toplam sayfa sayısı

async function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    shutdownReason = signal;

    console.log(`\n\n⚠️  ${signal} alındı, güvenli kapatma başlatılıyor...`);

    try {
        if (currentStorage) {
            // Mevcut ilerlemeyi kaydet
            console.log('   💾 Son durum kaydediliyor...');
            const stats = await currentStorage.getStats();
            const totalCount = await currentStorage.getTotalCount();

            // Temp dosyasına kaydet (resume için)
            await currentStorage.saveTemp({
                lastBatch: currentBatch,
                pageCount: currentPageCount,
                interrupted: true,
                signal: signal,
                timestamp: new Date().toISOString()
            });

            // Storage'ı kapat
            await currentStorage.close();
            console.log('   ✅ Storage kapatıldı.');

            // Webhook bildirimi
            await webhook.send(
                'USOM Tarama Durduruldu',
                `İşlem ${signal} sinyali ile durduruldu.`,
                {
                    added: stats.added,
                    skipped: stats.skipped,
                    total: totalCount,
                    duration: 'Yarıda kesildi'
                }
            );
        }
    } catch (err) {
        console.error(`   ❌ Kapatma hatası: ${err.message}`);
    }

    console.log('   👋 Program sonlandırılıyor.\n');
    process.exit(0);
}

// Signal handlers
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Windows için CTRL+C handler
if (process.platform === 'win32') {
    const readline = require('readline');
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    rl.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

// Uncaught exception handler
process.on('uncaughtException', async (err) => {
    console.error('\n❌ Yakalanmamış hata:', err.message);
    await webhook.notifyError(err);
    if (currentStorage) {
        try {
            await currentStorage.close();
        } catch (e) {
            // ignore
        }
    }
    process.exit(1);
});

// Unhandled rejection handler
process.on('unhandledRejection', async (reason, promise) => {
    console.error('\n❌ İşlenmeyen promise reddi:', reason);
    const err = reason instanceof Error ? reason : new Error(String(reason));
    await webhook.notifyError(err);
    if (currentStorage) {
        try {
            await currentStorage.close();
        } catch (e) {
            // ignore
        }
    }
    process.exit(1);
});

// Programı başlat
main();
