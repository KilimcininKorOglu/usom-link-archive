/**
 * Redis durum kontrolü
 */

const net = require('net');
const tls = require('tls');
const path = require('path');
const fs = require('fs');

// .env okuyucu
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
        env[trimmed.substring(0, eqIndex).trim()] = trimmed.substring(eqIndex + 1).trim();
    }
    return env;
}

const env = loadEnv();
const REDIS_HOST = env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(env.REDIS_PORT, 10) || 6379;
const REDIS_PASSWORD = env.REDIS_PASSWORD || '';
const REDIS_DB = parseInt(env.REDIS_DB, 10) || 0;
const REDIS_KEY_PREFIX = env.REDIS_KEY_PREFIX || 'usom:';

class SimpleRedis {
    constructor() {
        this.socket = null;
    }

    connect() {
        return new Promise((resolve, reject) => {
            this.socket = net.connect({ host: REDIS_HOST, port: REDIS_PORT }, async () => {
                try {
                    if (REDIS_PASSWORD) await this.cmd(['AUTH', REDIS_PASSWORD]);
                    if (REDIS_DB !== 0) await this.cmd(['SELECT', REDIS_DB]);
                    resolve();
                } catch (e) { reject(e); }
            });
            this.socket.on('error', reject);
            this.socket.setEncoding('utf8');
        });
    }

    cmd(args) {
        return new Promise((resolve, reject) => {
            let cmd = `*${args.length}\r\n`;
            for (const arg of args) {
                const str = String(arg);
                cmd += `$${Buffer.byteLength(str)}\r\n${str}\r\n`;
            }
            let data = '';
            const onData = (chunk) => {
                data += chunk;
                if (data.includes('\r\n')) {
                    this.socket.removeListener('data', onData);
                    const type = data[0];
                    const content = data.slice(1);
                    if (type === '-') reject(new Error(content.split('\r\n')[0]));
                    else if (type === ':') resolve(parseInt(content.split('\r\n')[0], 10));
                    else if (type === '+') resolve(content.split('\r\n')[0]);
                    else if (type === '$') {
                        const len = parseInt(content.split('\r\n')[0], 10);
                        if (len === -1) resolve(null);
                        else resolve(content.slice(content.indexOf('\r\n') + 2, content.indexOf('\r\n') + 2 + len));
                    }
                    else if (type === '*') {
                        const count = parseInt(content.split('\r\n')[0], 10);
                        if (count === -1 || count === 0) resolve([]);
                        else {
                            // Basit array parse
                            const lines = data.split('\r\n');
                            const results = [];
                            let i = 1;
                            while (results.length < count && i < lines.length) {
                                if (lines[i].startsWith('$')) {
                                    const len = parseInt(lines[i].slice(1), 10);
                                    if (len === -1) results.push(null);
                                    else results.push(lines[i + 1]);
                                    i += 2;
                                } else if (lines[i].startsWith(':')) {
                                    results.push(parseInt(lines[i].slice(1), 10));
                                    i++;
                                } else {
                                    i++;
                                }
                            }
                            resolve(results);
                        }
                    }
                    else resolve(data);
                }
            };
            this.socket.on('data', onData);
            this.socket.write(cmd);
        });
    }

    close() {
        if (this.socket) this.socket.end();
    }
}

async function main() {
    console.log('='.repeat(60));
    console.log('Redis Durum Kontrolü');
    console.log('='.repeat(60));
    console.log(`\nHost: ${REDIS_HOST}:${REDIS_PORT}`);
    console.log(`DB: ${REDIS_DB}`);
    console.log(`Prefix: ${REDIS_KEY_PREFIX}\n`);

    const redis = new SimpleRedis();
    
    try {
        await redis.connect();
        console.log('✅ Bağlantı başarılı\n');

        // DBSIZE
        const dbSize = await redis.cmd(['DBSIZE']);
        console.log(`📊 Toplam key sayısı (DB ${REDIS_DB}): ${dbSize}`);

        // USOM key'leri
        const usomKeys = await redis.cmd(['KEYS', `${REDIS_KEY_PREFIX}*`]);
        console.log(`📊 USOM key sayısı (${REDIS_KEY_PREFIX}*): ${usomKeys.length}`);

        // usom:ids set boyutu
        const idsCount = await redis.cmd(['SCARD', `${REDIS_KEY_PREFIX}ids`]);
        console.log(`📊 usom:ids set boyutu: ${idsCount}`);

        // Örnek ID'ler
        if (idsCount > 0) {
            const sampleIds = await redis.cmd(['SRANDMEMBER', `${REDIS_KEY_PREFIX}ids`, '5']);
            console.log(`\n🔍 Örnek ID'ler: ${sampleIds.join(', ')}`);
        }

        // Diğer key tipleri
        console.log('\n📋 Key örnekleri:');
        const sampleKeys = usomKeys.slice(0, 10);
        for (const key of sampleKeys) {
            const type = await redis.cmd(['TYPE', key]);
            console.log(`   ${key} → ${type}`);
        }

        // Tüm DB'leri kontrol et
        console.log('\n📊 Diğer DB\'ler:');
        for (let db = 0; db <= 3; db++) {
            await redis.cmd(['SELECT', db]);
            const size = await redis.cmd(['DBSIZE']);
            const usomCount = (await redis.cmd(['KEYS', `${REDIS_KEY_PREFIX}*`])).length;
            if (size > 0 || db === REDIS_DB) {
                console.log(`   DB ${db}: ${size} key (${usomCount} usom)`);
            }
        }

    } catch (err) {
        console.error('❌ Hata:', err.message);
    } finally {
        redis.close();
    }
}

main();
