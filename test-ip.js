/**
 * Round-Robin IP Test Script
 * Her interface'den çıkış IP'sini kontrol eder
 */

const https = require('https');
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

        const key = trimmed.substring(0, eqIndex).trim();
        const value = trimmed.substring(eqIndex + 1).trim();
        env[key] = value;
    }

    return env;
}

const env = loadEnv();

// Interface'leri al
const INTERFACES = env.INTERFACES
    ? env.INTERFACES.split(',').map(ip => ip.trim()).filter(ip => ip)
    : [];

console.log('='.repeat(60));
console.log('Round-Robin IP Test');
console.log('='.repeat(60));

if (INTERFACES.length === 0) {
    console.log('\n⚠️  .env dosyasında INTERFACES tanımlı değil!');
    console.log('   Varsayılan interface ile test yapılacak...\n');
}

// IP kontrol servisleri (birden fazla, yedek olarak)
const IP_CHECK_SERVICES = [
    { url: 'https://api.ipify.org?format=json', parser: (data) => JSON.parse(data).ip },
    { url: 'https://httpbin.org/ip', parser: (data) => JSON.parse(data).origin },
    { url: 'https://icanhazip.com', parser: (data) => data.trim() },
];

function checkExternalIP(localAddress = null) {
    return new Promise((resolve, reject) => {
        const service = IP_CHECK_SERVICES[0]; // ipify kullan
        const urlObj = new URL(service.url);
        
        const options = {
            hostname: urlObj.hostname,
            port: 443,
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
            timeout: 10000,
            headers: {
                'User-Agent': 'curl/7.68.0'
            }
        };

        if (localAddress) {
            options.localAddress = localAddress;
        }

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const ip = service.parser(data);
                    resolve({ localAddress, externalIP: ip, status: 'OK' });
                } catch (e) {
                    reject(new Error(`Parse hatası: ${e.message}`));
                }
            });
        });

        req.on('error', (err) => {
            reject(new Error(`${err.code || err.message}`));
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Timeout'));
        });

        req.end();
    });
}

async function testAllInterfaces() {
    console.log(`\n📡 IP Kontrol Servisi: ${IP_CHECK_SERVICES[0].url}\n`);

    // Önce varsayılan interface'i test et
    console.log('🔍 Varsayılan Interface:');
    try {
        const result = await checkExternalIP(null);
        console.log(`   ✅ Çıkış IP: ${result.externalIP}\n`);
    } catch (err) {
        console.log(`   ❌ Hata: ${err.message}\n`);
    }

    // Tanımlı interface'leri test et
    if (INTERFACES.length > 0) {
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
                results.push({ local: localIP, external: null, ok: false, error: err.message });
            }
            
            // Rate limit önleme için kısa bekleme
            await new Promise(r => setTimeout(r, 500));
        }

        // Özet
        console.log('\n' + '='.repeat(60));
        console.log('📊 ÖZET');
        console.log('='.repeat(60));
        
        const uniqueExternalIPs = new Set(results.filter(r => r.ok).map(r => r.external));
        const successCount = results.filter(r => r.ok).length;
        const failCount = results.filter(r => !r.ok).length;
        
        console.log(`   Başarılı: ${successCount}/${INTERFACES.length}`);
        console.log(`   Başarısız: ${failCount}/${INTERFACES.length}`);
        console.log(`   Benzersiz çıkış IP sayısı: ${uniqueExternalIPs.size}`);
        
        if (uniqueExternalIPs.size === 1 && successCount > 1) {
            console.log('\n   ⚠️  UYARI: Tüm interface\'ler AYNI çıkış IP\'sini kullanıyor!');
            console.log('   Bu, NAT/routing yapılandırmasından kaynaklanıyor olabilir.');
        } else if (uniqueExternalIPs.size > 1) {
            console.log('\n   ✅ Farklı çıkış IP\'leri doğrulandı - Round-robin çalışıyor!');
        }
        
        console.log('\n   Çıkış IP\'leri:');
        uniqueExternalIPs.forEach(ip => console.log(`   • ${ip}`));
        
    } else {
        console.log('💡 İpucu: .env dosyasına INTERFACES ekleyin:');
        console.log('   INTERFACES=10.11.13.62,10.11.13.63,10.11.13.64,...\n');
    }
}

// Çalıştır
testAllInterfaces().catch(err => {
    console.error('❌ Kritik hata:', err.message);
    process.exit(1);
});
