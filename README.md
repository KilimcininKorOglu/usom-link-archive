# USOM Zararlı URL Arşiv Botu

[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![USOM](https://img.shields.io/badge/Kaynak-USOM-red.svg)](https://www.usom.gov.tr/)

USOM (Ulusal Siber Olaylara Müdahale Merkezi) API'sinden zararlı URL, domain ve IP adreslerini toplayan ve arşivleyen Node.js botu.

## 🚀 Özellikler

- **Tam Arşiv**: 444,000+ zararlı URL kaydını tek seferde indir
- **Devam Ettirme**: Yarıda kalan indirmeyi kaldığı yerden devam ettir
- **Akıllı Güncelleme**: Sadece yeni kayıtları çek, mevcut arşivi koru
- **Duplicate Kontrolü**: Mükerrer kayıtları otomatik atla
- **FILE veya REDIS**: JSON dosyasına veya Redis'e kaydet
- **Tarih Filtresi**: Belirli tarih aralığındaki kayıtları çek
- **Rate Limit Yönetimi**: HTTP 429 hatalarını otomatik algıla ve bekle
- **Multi-Interface**: Birden fazla IP ile paralel istek (round-robin)
- **Kesintiye Dayanıklı**: Ara kayıt ile veri kaybını önle
- **Sıfır Bağımlılık**: Sadece Node.js yeterli

## 📦 Kurulum

```bash
git clone https://github.com/KilimcininKorOglu/usom-link-archive.git
cd usom-link-archive
```

> **Not**: Harici bağımlılık yok, `npm install` gerekmez.

## 🔧 Kullanım

```bash
# Yardım göster
node usom-scraper.js

# Tüm arşivi çek (~444,000+ kayıt)
node usom-scraper.js --full

# Yarıda kalan indirmeye devam et
node usom-scraper.js --resume

# Mevcut arşivi güncelle (sadece yeni kayıtlar)
node usom-scraper.js --update

# Belirli tarihten itibaren
node usom-scraper.js --date 2025-11-01

# Tarih aralığı
node usom-scraper.js --date 2025-11-01 2025-11-26

# Redis verilerini sil (OUTPUT_TYPE=REDIS ise)
node usom-scraper.js --clear-redis
```

## 📊 Çıktı Formatı

Bot, `usom-archive.json` dosyası oluşturur:

```json
{
  "exportDate": "2025-11-26T18:30:00.000Z",
  "source": "USOM - Ulusal Siber Olaylara Müdahale Merkezi",
  "apiUrl": "https://www.usom.gov.tr/api/address/index",
  "dateFilter": { "from": null, "to": null },
  "totalCount": 444950,
  "pageCount": 22248,
  "models": [
    {
      "id": 1049758,
      "url": "zararli-site.com",
      "type": "domain",
      "desc": "PH",
      "source": "US",
      "date": "2025-11-26 16:09:34.604613",
      "criticality_level": 4,
      "connectiontype": "PH"
    }
  ]
}
```

### Veri Alanları

| Alan | Açıklama | Değerler |
|------|----------|----------|
| `type` | Kayıt türü | `domain`, `url`, `ip` |
| `desc` | Kategori | `PH` (Phishing), `BP` (Banka Phishing), `MW` (Malware) |
| `source` | Kaynak | `US` (USOM), `IH` (İhbar) |
| `criticality_level` | Kritiklik | 1-4 (4 = En yüksek) |
| `connectiontype` | Bağlantı türü | `PH`, `OT` (Other) |

## ⚙️ Yapılandırma

`.env.example` dosyasını `.env` olarak kopyalayın ve düzenleyin:

```bash
cp .env.example .env
```

### Temel Ayarlar

```env
# Çıktı Tipi: FILE veya REDIS
OUTPUT_TYPE=FILE

# Dosya ayarları (OUTPUT_TYPE=FILE)
OUTPUT_FILE=usom-archive.json
TEMP_FILE=usom-archive-temp.json

# İstek ayarları
PARALLEL_REQUESTS=1
DELAY_MS=1500
SAVE_INTERVAL=10
INTERFACES=
```

### 🗄️ Redis Kullanımı

Redis'e kaydetmek için:

```env
OUTPUT_TYPE=REDIS
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=your_password
REDIS_DB=0
REDIS_TLS=false
REDIS_KEY_PREFIX=usom:
```

Redis veri yapısı:
- `usom:ids` → SET (tüm ID'ler, duplicate kontrolü için)
- `usom:record:{id}` → HASH (kayıt detayları)
- `usom:meta` → STRING (metadata)

### 🌐 Multi-Interface Kullanımı

Rate limit'ten kaçınmak için birden fazla IP kullanabilirsiniz:

```env
INTERFACES=10.0.0.5,10.0.0.6
PARALLEL_REQUESTS=2
```

Progress bar'da duplicate istatistikleri de gösterilir:

```
[150/22248] %0.7 | Geçen: 3dk 45s | Kalan: 8sa 32dk | 149→*.0.5, 150→*.0.6 | Yeni: 2847, Atlandı: 153
```

> 💡 **İpucu**: `PARALLEL_REQUESTS` değerini interface sayısına eşitleyin.

## 📈 Performans

| Mod | Tahmini Süre | Kayıt Sayısı |
|-----|--------------|--------------|
| `--full` | ~9 saat | ~444,000+ |
| `--resume` | Kaldığı yerden | Değişir |
| `--update` | Birkaç dakika | Değişir |
| `--date` (1 ay) | ~10-30 dakika | ~5,000-15,000 |

## 🔄 Güncelleme Stratejisi

İlk kez çalıştırma:

```bash
node usom-scraper.js --full
```

Yarıda kaldıysa devam et:

```bash
node usom-scraper.js --resume
```

Günlük/haftalık güncelleme:

```bash
node usom-scraper.js --update
```

## 🛡️ Rate Limit

USOM API'si rate limiting uygulamaktadır. Bot otomatik olarak:

1. HTTP 429 veya HTML yanıt algılar
2. Artan süreyle bekler (5s → 10s → 15s → ... max 30s)
3. Başarılı olana kadar tekrar dener
4. **Hiçbir sayfa atlanmaz**

## 📁 Dosya Yapısı

```bash
usom-link-archive/
├── usom-scraper.js        # Ana bot
├── .env.example           # Yapılandırma şablonu
├── .env                   # Yapılandırma dosyası (oluşturulur, .gitignore'da)
├── usom-archive.json      # Çıktı dosyası (oluşturulur)
├── usom-archive-temp.json # Geçici dosya (--resume için, tamamlanınca silinir)
└── README.md
```

---

**⚠️ Sorumluluk Reddi**: Bu araç yalnızca güvenlik araştırması ve eğitim amaçlıdır. Toplanan veriler USOM'un kamuya açık API'sinden elde edilmektedir.
