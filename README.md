# Arquivo NF-e — Notas de Entrada (Node.js)

Brezilya NF-e (model 55) / NFC-e (65) alış faturalarını **XML** veya **DANFE PDF** olarak içe aktarıp
faturayı kesen şirkete (fornecedor), ürüne ve kalemlere göre saklayan, arayan ve listeleyen web uygulaması.
Arayüz Portekizce, kullanıcı adı/şifre ile giriş korumalıdır.

- Node.js **18.17 veya üstü** (önerilen: 20 ya da 22)
- Ek veritabanı sunucusu gerekmez: veriler tek bir SQLite dosyasında (`dados/notas.db`) tutulur.
- Derleme gerektiren paket yoktur; paylaşımlı hostingde `npm install` sorunsuz çalışır.

## Hosting'e kurulum (cPanel → "Setup Node.js App")

1. cPanel → **Git Version Control** → **Create** → "Clone a Repository":
   - Clone URL: `https://github.com/bariscagriyuce/entrada-xml-pdf.git`
   - Repository Path: örn. `arquivo-nfe` (`public_html` içine **koymayın**)

   Repo özel (private) ise GitHub'da bir erişim anahtarı (token) ya da cPanel'in SSH anahtarını
   repoya "Deploy key" olarak eklemeniz gerekir. Güncelleme için aynı ekranda **Update from Remote**,
   ardından Node.js uygulamasında **Restart**.
2. cPanel → **Setup Node.js App** → **Create Application**:
   - Node.js version: 20 veya 22 (en az 18.17)
   - Application mode: Production
   - Application root: `arquivo-nfe`
   - Application URL: alan adınız veya bir alt alan adı (örn. `notas.siteniz.com`)
   - Application startup file: **`server.cjs`**
3. **Create** → ardından **Run NPM Install** → **Restart**.
4. Adresi açın. İlk açılışta **yönetici kullanıcısını oluşturma** ekranı gelir; ondan sonra sistem
   yalnızca giriş ile açılır. Ek kullanıcıları sağ üstteki kullanıcı adınıza tıklayıp ekleyebilirsiniz.
5. Sitede **SSL (https)** açık olsun (cPanel → SSL/TLS Status → AutoSSL).

Uygulamayı alt klasöre koyarsanız (örn. `siteniz.com/notas`), aynı ekranda ortam değişkeni ekleyin:
`BASE_PATH` = `/notas`.

### İsteğe bağlı ortam değişkenleri

| Değişken | Anlamı |
|---|---|
| `BASE_PATH` | Uygulama alt klasördeyse yolu (örn. `/notas`) |
| `NFE_DADOS` | Veri klasörü (varsayılan: uygulama içindeki `dados/`) |
| `PORT` | Port (hosting genelde kendisi verir; yerelde varsayılan 3000) |

## Kendi bilgisayarınızda çalıştırma

```bash
npm install
npm start
```

Ardından http://localhost:3000

## Neler yapar

- **Importar**: XML, PDF ve ZIP dosyalarını sürükle-bırak ile toplu yükleme; ya da dosyaları FTP ile
  `dados/entrada/` klasörüne atıp "Importar da pasta". Aynı dosya/aynı chave tekrar eklenmez.
- **XML** = tam veri: emitente, destinatário, tüm kalemler (kod, EAN, NCM, CFOP, miktar, birim fiyat,
  ICMS/IPI/PIS/COFINS), toplamlar, taşıma, duplicatas, ödeme, ek bilgiler, SEFAZ protokolü.
  Fatura sayfasında XML'in tüm alanları ağaç olarak da görünür.
- **PDF (DANFE)**: aynı chave'li nota varsa PDF ona eklenir. Yalnızca PDF varsa okunabilen bilgilerle
  "só PDF" notası oluşturulur (yaklaşık veri); XML yüklenince otomatik tamamlanır.
  Taranmış (resim) PDF'ler için OCR yalnızca sunucuda `tesseract` kuruluysa çalışır (paylaşımlı hostingde genelde yoktur).
- **Notas / Itens / Produtos / Fornecedores**: aksan duyarsız arama; tedarikçi, kendi şirketiniz
  (destinatário), tarih aralığı, tutar, NCM, CFOP filtreleri; sıralama; **CSV dışa aktarma** (Excel uyumlu).
- **Produto** sayfası: ürünün tüm alış geçmişi, fiyat grafiği, aynı EAN'ı satan diğer tedarikçiler.

## Yedekleme

Tüm veriler `dados/` klasöründedir (`notas.db` + `arquivos/` içindeki orijinal XML/PDF'ler).
Bu klasörü düzenli olarak indirip saklayın.
