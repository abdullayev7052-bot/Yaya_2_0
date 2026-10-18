# Yaya — ishga tushirish (qadamma-qadam)

## 1. Railway'ga server joylash (≈10 daqiqa)
1. https://railway.com → **New Project** → **Deploy from GitHub repo** → `abdullayev7052-bot/Yaya`.
2. Service → **Settings → Source → Branch**: `claude/dreamy-euler-syspqn` (keyinchalik `main`).
   Railway `Dockerfile` va `railway.json` ni o'zi topadi.
3. Service → **Settings → Volumes → + Add Volume** → Mount path: **`/data`**.
   ⚠️ Volume'siz har deployda baza o'chib ketadi.
4. Service → **Variables** → qo'shing:
   | Nomi | Qiymati |
   |---|---|
   | `ADMIN_LOGIN` | masalan `admin` |
   | `ADMIN_PASSWORD` | kuchli parol (kamida 12 belgi) |

   `JWT_SECRET` shart emas — server o'zi yaratib, bazada saqlaydi.
5. Service → **Settings → Networking → Generate Domain** → masalan `yaya-production.up.railway.app`.
6. Tekshirish: `https://<domen>/health` → `{"ok":true}`; admin panel: `https://<domen>/admin/`.
7. Kirgandan so'ng **Sozlamalar → Admin parolini o'zgartirish** (ixtiyoriy) va Railway'dagi
   `ADMIN_PASSWORD` ni o'chirib qo'yishingiz mumkin — admin bazada saqlangan.

## 2. GitHub Secrets (APK imzosi) — bir marta
GitHub → repo → **Settings → Secrets and variables → Actions**.

**Secrets** tabida → **New repository secret** (4 marta), qiymatlar `yaya-github-secrets.txt` faylida:
- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

Server manzili ilova kodiga yozilgan (`mobile/app.config.js`). Boshqa serverga o'tilsa,
**Variables** tabida `YAYA_API_URL` = `https://<domen>` qo'shiladi.

Keyin **Actions → Android APK → Run workflow** → branch tanlang → **Run**.
~10 daqiqadan so'ng run sahifasida **Artifacts → yaya-apk-N** paydo bo'ladi.
Imzo to'g'ri bo'lsa, logda "Sign with Yaya release key" qadamida sertifikat chiqadi (ogohlantirish emas).

## 3. Telefonga o'rnatish
1. APK zipni kompyuterga yuklab oling, ochib `yaya.apk` ni Telegram (o'zingizga "Saved Messages")
   yoki USB orqali telefonga o'tkazing.
2. Telefonda faylni bosing → "Noma'lum manbalardan o'rnatish"ga **faqat shu ilova (Telegram/Fayllar)** uchun ruxsat bering.
3. Play Protect ogohlantirsa: **Batafsil → Baribir o'rnatish** (ilova Play Market'da emasligi uchun).
4. O'rnatgach, o'sha ruxsatni qayta o'chirib qo'ying (Sozlamalar → Ilovalar → Telegram → Noma'lum ilovalarni o'rnatish → O'chirish).
5. Yangilash: yangi APK'ni xuddi shunday o'rnating — eski ma'lumotlar saqlanib qoladi (imzo bir xil bo'lgani uchun).
   ⚠️ Ilovani **o'chirmang** va "Ma'lumotlarni tozalash"ni bosmang — yuborilmagan yozuvlar yo'qoladi.

## 4. Birinchi sozlash (boshqaruv paneli)
1. **Sozlamalar** → kompaniya nomi va **logo** (PNG/JPG). Panel va ilovada darhol ko'rinadi;
   telefon ikonkasi keyingi APK yig'ishda logoga almashadi.
2. **Mahsulotlar** → Yog'li sut, Yog'siz sut va hokazo.
3. **Yetkazib beruvchilar** → bittalab qo'shing yoki **⬇ Excel shablon** → to'ldirib → **⬆ Excel'dan import**.
   Shablon ustunlari: ism, telefon, manzil, mahsulot, narx, hozirgi qarz, **sut yig'uvchilar** (login, vergul bilan; bir nechta bo'lishi mumkin).
   Import oldidan tekshiruv natijasi ko'rsatiladi.
4. **Rollar va ruxsatlar** → har bir rol ilovada nimani qila olishini belgilang.
5. **Xodimlar** → har bir xodim uchun login, parol va rol. Sut yig'uvchiga **Biriktirish** bosib yetkazib beruvchilarni tanlang (tartib = yo'nalish).
6. **Qurilmalar** → har bir xodim nechta telefondan kira olishini belgilang. Telefon almashsa, "Bo'shatish" bosiladi.
7. **Ilovani sinash** → test xodim bilan noutbukda sinab ko'ring.
8. Telefonda hamma bir xil kiradi: **login + parol**. Ilova rolga qarab kerakli bo'limlarni ochadi.
   "Men" bo'limida PIN, barmoq izi va avtomatik qulflashni yoqing.

### 1-versiyadan o'tish
Server yangilanganda baza avtomatik o'tkaziladi:
- Sut yig'uvchilar **login = telefon raqami**, **parol = eski PIN** bilan kiradi. Keyin admin parolni almashtirishi mumkin.
- Omborlar olib tashlanadi.
- Eski "tasdiqlangan" smenalar "qabul qilingan", "rad etilgan" smenalar "bekor qilingan" bo'ladi.
- Telefonlardagi yuborilmagan yozuvlar yo'qolmaydi: yangi ilovaga kirgach, ular yuboriladi.
