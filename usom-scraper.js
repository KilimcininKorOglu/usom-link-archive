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
        this.responseBuffer = '';
        this.responseQueue = [];
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
        return new Promise((resolve, reject) => {
            const connectOptions = { host: this.host, port: this.port };

            if (this.useTls) {
                this.socket = tls.connect(connectOptions, () => {
                    this.connected = true;
                    this._authenticate().then(resolve).catch(reject);
                });
            } else {
                this.socket = net.connect(connectOptions, () => {
                    this.connected = true;
                    this._authenticate().then(resolve).catch(reject);
                });
            }

            this.socket.on('error', (err) => {
                this.connected = false;
                reject(err);
            });

            this.socket.on('close', () => {
                this.connected = false;
            });

            this.socket.setEncoding('utf8');
        });
    }

    async _authenticate() {
        if (this.password) {
            await this._sendCommand(['AUTH', this.password]);
        }
        if (this.db !== 0) {
            await this._sendCommand(['SELECT', this.db]);
        }
    }

    async _sendCommand(args) {
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
                    resolve(parsed.value);
                } catch (e) {
                    // Henüz tam yanıt gelmedi, beklemeye devam et
                    if (!e.message.includes('Redis')) {
                        // Parse hatası değilse bekle
                    } else {
                        this.socket.removeListener('data', onData);
                        reject(e);
                    }
                }
            };

            this.socket.on('data', onData);
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
    async pipeline(commands) {
        if (commands.length === 0) return [];

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

    async clearAll() {
        // Tüm USOM key'lerini sil
        const keys = await this.client.keys(`${this.prefix}*`);
        if (keys && keys.length > 0) {
            await this.client.del(...keys);
        }
        return keys ? keys.length : 0;
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

function showProgress(current, total, startTime, pageIpMap, stats) {
    const percent = ((current / total) * 100).toFixed(1);
    const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
    const etaSec = current > 0 ? Math.floor((elapsedSec / current) * (total - current)) : 0;

    let output = `\r[${current}/${total}] %${percent} | Geçen: ${formatTime(elapsedSec)} | Kalan: ${formatTime(etaSec)}`;

    // Sayfa-IP eşleşmeleri
    if (pageIpMap && pageIpMap.length > 0 && pageIpMap[0].ip) {
        const ipMappings = pageIpMap.map(m => `${m.page}→${shortIp(m.ip)}`).join(', ');
        output += ` | ${ipMappings}`;
    }

    // Duplicate istatistikleri
    if (stats) {
        output += ` | Yeni: ${stats.added}, Atlandı: ${stats.skipped}`;
    }

    output += '    ';
    process.stdout.write(output);
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

Tarih formatı: YYYY-MM-DD

Örnekler:
  node usom-scraper.js --full
  node usom-scraper.js --resume
  node usom-scraper.js --update
  node usom-scraper.js --date 2025-11-01
  node usom-scraper.js --export                    # ${OUTPUT_FILE} dosyasına
  node usom-scraper.js --export my-archive.json    # Belirtilen dosyaya
  node usom-scraper.js --clear-redis

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

    if (MODE === 'date' && !DATE_FROM) {
        console.error('❌ Hata: --date seçeneği için en az bir tarih gerekli.');
        process.exit(1);
    }

    console.log('='.repeat(60));
    console.log('USOM Zararlı URL Arşiv Botu');
    console.log('='.repeat(60));

    // Storage oluştur
    const storage = createStorage();

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

        // Tüm sayfaları tara
        for (let batchStart = startBatch; batchStart < pageCount; batchStart += PARALLEL_REQUESTS) {
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
            showProgress(currentPage, pageCount, startTime, pageIpMap, stats);

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

    } catch (err) {
        console.error('\n❌ Kritik hata:', err.message);
        process.exit(1);
    } finally {
        await storage.close();
    }
}

// Programı başlat
main();
