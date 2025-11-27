/**
 * USOM Zararlı URL Arşiv Botu
 * Tüm sayfaları tarar ve tek JSON dosyasında birleştirir
 */

const https = require('https');
const fs = require('fs');

const BASE_URL = 'https://www.usom.gov.tr/api/address/index';
const OUTPUT_FILE = 'usom-archive.json';
const PARALLEL_REQUESTS = 1; // Tek tek istek (sunucu çok hassas)
const DELAY_MS = 1500; // Her istek arasında 1.5 saniye bekleme
const SAVE_INTERVAL = 10; // Kaç sayfada bir ara kayıt yapılacak

// Komut satırı argümanlarını parse et
const args = process.argv.slice(2);

// Yardım mesajını göster
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
  --update                   Sadece yeni kayıtları çek (mevcut arşivi güncelle)
  --date <başlangıç>         Belirli tarihten bugüne kadar
  --date <başlangıç> <bitiş> Tarih aralığı

Tarih formatı: YYYY-MM-DD

Örnekler:
  node usom-scraper.js --full
  node usom-scraper.js --resume
  node usom-scraper.js --update
  node usom-scraper.js --date 2025-11-01
  node usom-scraper.js --date 2025-11-01 2025-11-26

Çıktı dosyası: ${OUTPUT_FILE}
`);
}

// Argümanları parse et
let MODE = null;
let DATE_FROM = null;
let DATE_TO = null;

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--full') {
        MODE = 'full';
    } else if (args[i] === '--resume') {
        MODE = 'resume';
    } else if (args[i] === '--update') {
        MODE = 'update';
    } else if (args[i] === '--date') {
        MODE = 'date';
        // BUG-003 FIX: Tarih değerlerini doğrula, -- ile başlayanları kabul etme
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

// Argüman kontrolü
if (!MODE) {
    showHelp();
    process.exit(0);
}

// Tarih modu seçilmişse tarih kontrolü
if (MODE === 'date' && !DATE_FROM) {
    console.error('❌ Hata: --date seçeneği için en az bir tarih gerekli.');
    console.error('   Örnek: node usom-scraper.js --date 2025-11-01');
    process.exit(1);
}

// Resume modu için geçici dosya kontrolü
const TEMP_FILE = 'usom-archive-temp.json';
let resumeData = null;
if (MODE === 'resume') {
    if (!fs.existsSync(TEMP_FILE)) {
        console.error('❌ Hata: Devam edilecek indirme bulunamadı.');
        console.error(`   Geçici dosya (${TEMP_FILE}) mevcut değil.`);
        console.error('   Yeni indirme başlatmak için: node usom-scraper.js --full');
        process.exit(1);
    }

    console.log('📂 Yarıda kalan indirme okunuyor...');
    // BUG-004 FIX: JSON parse hatası için try-catch ekle
    try {
        const fileContent = fs.readFileSync(TEMP_FILE, 'utf8');
        resumeData = JSON.parse(fileContent);
    } catch (err) {
        console.error('❌ Hata: Geçici dosya bozuk veya okunamıyor.');
        console.error(`   ${err.message}`);
        console.error('   Yeni indirme başlatmak için: node usom-scraper.js --full');
        process.exit(1);
    }

    console.log(`📊 Kaldığı yer: Sayfa ${resumeData.lastBatch}`);
    console.log(`   Mevcut kayıt: ${resumeData.totalCount.toLocaleString()}`);
    console.log(`   Devam ediliyor...\n`);
}

// Update modu için mevcut arşivi oku
let existingData = null;
if (MODE === 'update') {
    if (!fs.existsSync(OUTPUT_FILE)) {
        console.error('❌ Hata: Güncellenecek arşiv bulunamadı.');
        console.error(`   Önce --full ile arşivi oluşturun: node usom-scraper.js --full`);
        process.exit(1);
    }

    console.log('📂 Mevcut arşiv okunuyor...');
    // BUG-005 FIX: JSON parse hatası için try-catch ekle
    try {
        const fileContent = fs.readFileSync(OUTPUT_FILE, 'utf8');
        existingData = JSON.parse(fileContent);
    } catch (err) {
        console.error('❌ Hata: Arşiv dosyası bozuk veya okunamıyor.');
        console.error(`   ${err.message}`);
        console.error('   Yeni arşiv oluşturmak için: node usom-scraper.js --full');
        process.exit(1);
    }

    // En son kaydın tarihini bul
    if (existingData.models && existingData.models.length > 0) {
        // BUG-001 FIX: Orijinal diziyi mutasyona uğratma, kopya oluştur
        const sortedModels = [...existingData.models].sort((a, b) =>
            new Date(b.date) - new Date(a.date)
        );
        const lastDate = sortedModels[0].date.split(' ')[0]; // "2025-11-26 16:09:34" -> "2025-11-26"
        DATE_FROM = lastDate;
        console.log(`📅 Son kayıt tarihi: ${lastDate}`);
        console.log(`   Bu tarihten sonraki kayıtlar çekilecek.\n`);
    }
}

// URL oluştur (tarih filtresi varsa ekle)
function buildUrl(page) {
    let url = `${BASE_URL}?page=${page}`;
    if (DATE_FROM) url += `&date_gte=${DATE_FROM}`;
    if (DATE_TO) url += `&date_lte=${DATE_TO}`;
    return url;
}

// HTTPS isteği yapan fonksiyon
function fetchPage(page) {
    return new Promise((resolve, reject) => {
        const url = buildUrl(page);

        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0',
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
                'Connection': 'keep-alive',
                'Cache-Control': 'no-cache',
            }
        };

        https.get(url, options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                // Rate limit veya hata sayfası kontrolü
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode} sayfa ${page}`));
                    return;
                }

                // HTML döndüyse rate limit var demektir
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

// Tekrar deneme mekanizmalı fetch - BAŞARILI OLANA KADAR DENE
async function fetchPageWithRetry(page) {
    let attempt = 0;
    while (true) {
        attempt++;
        try {
            return await fetchPage(page);
        } catch (err) {
            // Rate limit (429) ise çok daha uzun bekle
            let waitTime;
            if (err.message.includes('429') || err.message.includes('Rate limit')) {
                waitTime = Math.min(5000 * attempt, 30000); // Maksimum 30 saniye
                process.stdout.write(`\n   ⏳ Sayfa ${page} - Rate limit (deneme ${attempt}) - ${waitTime / 1000}s bekleniyor...`);
            } else {
                waitTime = Math.min(3000 * attempt, 15000); // Maksimum 15 saniye
                process.stdout.write(`\n   ⚠️ Sayfa ${page} - ${err.message} (deneme ${attempt}) - ${waitTime / 1000}s bekleniyor...`);
            }
            await sleep(waitTime);
        }
    }
}

// Bekleme fonksiyonu
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Saniyeyi okunabilir formata çevir
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

// İlerleme çubuğu göster
function showProgress(current, total, startTime) {
    const percent = ((current / total) * 100).toFixed(1);
    const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
    const etaSec = current > 0 ? Math.floor((elapsedSec / current) * (total - current)) : 0;

    process.stdout.write(`\r[${current}/${total}] %${percent} | Geçen: ${formatTime(elapsedSec)} | Kalan: ${formatTime(etaSec)}    `);
}

// Toplu istek işlemi (başarılı olana kadar dener, hata atmaz)
async function fetchBatch(pages) {
    const promises = pages.map(page => fetchPageWithRetry(page));
    return Promise.all(promises);
}

// Ana fonksiyon
async function main() {
    console.log('='.repeat(60));
    console.log('USOM Zararlı URL Arşiv Botu');
    console.log('='.repeat(60));

    try {
        // İlk sayfayı al ve toplam sayfa sayısını öğren
        console.log('\n📡 İlk sayfa alınıyor...');
        // BUG-002 FIX: İlk sayfa için de retry mekanizması kullan
        const firstPage = await fetchPageWithRetry(0);

        const totalCount = firstPage.totalCount;
        const pageCount = firstPage.pageCount;

        console.log(`\n📊 İstatistikler:`);
        console.log(`   - Toplam kayıt: ${totalCount.toLocaleString()}`);
        console.log(`   - Toplam sayfa: ${pageCount.toLocaleString()}`);
        if (DATE_FROM || DATE_TO) {
            const fromText = DATE_FROM || 'Başlangıç';
            const toText = DATE_TO || 'Bugün';
            console.log(`   - Tarih filtresi: ${fromText} → ${toText}`);
        }
        console.log(`   - Paralel istek: ${PARALLEL_REQUESTS}`);

        // Tahmini süreyi hesapla ve formatla
        const estimatedMinutes = Math.ceil((pageCount / PARALLEL_REQUESTS) * DELAY_MS / 1000 / 60);
        let estimatedTimeText;
        if (estimatedMinutes >= 60) {
            const hours = Math.floor(estimatedMinutes / 60);
            const minutes = estimatedMinutes % 60;
            estimatedTimeText = minutes > 0 ? `${hours} saat ${minutes} dakika` : `${hours} saat`;
        } else {
            estimatedTimeText = `${estimatedMinutes} dakika`;
        }
        console.log(`   - Tahmini süre: ~${estimatedTimeText}`);

        // Tüm verileri toplayacağımız dizi
        let allModels = [];
        let startBatch = 1;

        // Resume modunda kaldığı yerden devam et
        if (MODE === 'resume' && resumeData) {
            allModels = resumeData.models;
            startBatch = resumeData.lastBatch + 1;
            console.log(`\n🔄 Sayfa ${startBatch}'den devam ediliyor...\n`);
        } else {
            allModels = [...firstPage.models];
            console.log(`\n🚀 Tarama başlıyor...\n`);
        }

        const startTime = Date.now();

        // Tüm sayfaları toplu halde tara
        for (let batchStart = startBatch; batchStart < pageCount; batchStart += PARALLEL_REQUESTS) {
            // Bu toplu istek için sayfa numaralarını oluştur
            const batchPages = [];
            for (let i = 0; i < PARALLEL_REQUESTS && (batchStart + i) < pageCount; i++) {
                batchPages.push(batchStart + i);
            }

            // İstekleri yap
            const results = await fetchBatch(batchPages);

            // Sonuçları işle (artık hepsi başarılı)
            for (const result of results) {
                allModels = allModels.concat(result.models);
            }

            // İlerlemeyi göster
            const currentPage = Math.min(batchStart + PARALLEL_REQUESTS, pageCount);
            showProgress(currentPage, pageCount, startTime);

            // Her SAVE_INTERVAL değeri kadar sayfada bir kaydet (veri kaybını önlemek için)
            if (batchStart % SAVE_INTERVAL < PARALLEL_REQUESTS) {
                fs.writeFileSync(TEMP_FILE, JSON.stringify({
                    exportDate: new Date().toISOString(),
                    totalCount: allModels.length,
                    lastBatch: batchStart,
                    pageCount: pageCount,
                    models: allModels
                }, null, 2));
            }

            // İstekler arası bekleme
            await sleep(DELAY_MS);
        }

        // Update modunda yeni kayıtları mevcut arşive ekle
        let finalModels = allModels;
        let newRecordsCount = allModels.length;

        if (MODE === 'update' && existingData) {
            // Mevcut ID'leri set olarak al (hızlı arama için)
            const existingIds = new Set(existingData.models.map(m => m.id));

            // Sadece yeni kayıtları filtrele
            const newModels = allModels.filter(m => !existingIds.has(m.id));
            newRecordsCount = newModels.length;

            // Yeni kayıtları mevcut verilerin başına ekle (en yeniler üstte)
            finalModels = [...newModels, ...existingData.models];

            console.log(`\n\n📊 Güncelleme özeti:`);
            console.log(`   - Yeni kayıt: ${newRecordsCount.toLocaleString()}`);
            console.log(`   - Mevcut kayıt: ${existingData.models.length.toLocaleString()}`);
            console.log(`   - Toplam kayıt: ${finalModels.length.toLocaleString()}`);
        }

        // Sonuçları kaydet
        const result = {
            exportDate: new Date().toISOString(),
            source: 'USOM - Ulusal Siber Olaylara Müdahale Merkezi',
            apiUrl: BASE_URL,
            dateFilter: {
                from: MODE === 'update' ? null : DATE_FROM,
                to: MODE === 'update' ? null : DATE_TO
            },
            totalCount: finalModels.length,
            pageCount: pageCount,
            models: finalModels
        };

        console.log(`\n\n💾 Dosya kaydediliyor: ${OUTPUT_FILE}`);
        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));

        // BUG-006 FIX: Geçici dosyayı sadece full/resume modlarında temizle
        if ((MODE === 'full' || MODE === 'resume') && fs.existsSync(TEMP_FILE)) {
            fs.unlinkSync(TEMP_FILE);
        }

        const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(2);

        console.log('\n' + '='.repeat(60));
        console.log('✅ TAMAMLANDI!');
        console.log('='.repeat(60));
        console.log(`📁 Dosya: ${OUTPUT_FILE}`);
        if (MODE === 'update') {
            console.log(`📊 Yeni kayıt: ${newRecordsCount.toLocaleString()}`);
            console.log(`📊 Toplam kayıt: ${finalModels.length.toLocaleString()}`);
        } else {
            console.log(`📊 Toplam kayıt: ${finalModels.length.toLocaleString()}`);
        }
        console.log(`⏱️  Toplam süre: ${totalTime} dakika`);
        console.log(`📦 Dosya boyutu: ${(fs.statSync(OUTPUT_FILE).size / 1024 / 1024).toFixed(2)} MB`);

    } catch (err) {
        console.error('\n❌ Kritik hata:', err.message);
        process.exit(1);
    }
}

// Programı başlat
main();
