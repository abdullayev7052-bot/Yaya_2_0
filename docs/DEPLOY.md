# Yaya 2.0 — ishga tushirish (qadamma-qadam)

Yaya 2.0 — asl Yaya loyihasining **mustaqil nusxasi**. O'z reposi, o'z serveri, o'z bazasi va o'z ilovasi bor;
asl Yaya bilan hech narsani bo'lishmaydi.

| Nima | Qiymat |
|---|---|
| GitHub repo | `abdullayev7052-bot/Yaya_2_0` |
| Branch | `main` (har bir push avtomatik deploy bo'ladi) |
| Railway loyihasi / servis | "Yaya 2.0" / `Yaya2` |
| Hudud | Yevropa (EU West, `europe-west4`) |
| Domen | https://yaya2-production.up.railway.app |
| Volume | `yaya2-data` → `/data` |
| Admin panel | https://yaya2-production.up.railway.app/admin/ |
| Ilova nomi / paketi | "Yaya 2.0" / `uz.yaya2.collector` (asl Yaya ilovasi yonida alohida o'rnatiladi) |

## 1. Railway'dagi server
Server allaqachon ishlab turibdi. Noldan qayta qurish kerak bo'lsa:

1. https://railway.com → **New Project** → **Deploy from GitHub repo** → `abdullayev7052-bot/Yaya_2_0`.
2. Service → **Settings → Source → Branch**: `main`.
   Railway `Dockerfile` va `railway.json` ni o'zi topadi.
3. Service → **Settings → Deploy → Regions**: Yevropa (**EU West**).
4. Service → **Settings → Volumes → + Add Volume** → Mount path: **`/data`**.
   ⚠️ Volume'siz har deployda baza o'chib ketadi.
5. Service → **Variables** → qo'shing:
   | Nomi | Qiymati |
   |---|---|
   | `ADMIN_LOGIN` | masalan `admin` |
   | `ADMIN_PASSWORD` | kuchli parol (kamida 12 belgi) |

   `JWT_SECRET` shart emas — server o'zi yaratib, bazada saqlaydi.
6. Service → **Settings → Networking → Generate Domain** → `yaya2-production.up.railway.app`.
7. Tekshirish: https://yaya2-production.up.railway.app/health → `{"ok":true}`;
   admin panel: https://yaya2-production.up.railway.app/admin/.
8. Kirgandan so'ng **Sozlamalar → Admin parolini o'zgartirish** (ixtiyoriy) va Railway'dagi
   `ADMIN_PASSWORD` ni o'chirib qo'yishingiz mumkin — admin bazada saqlangan.

### Yangilash
`main` branchga push qilinsa, Railway serverni o'zi qayta yig'adi va ishga tushiradi. Baza `/data` volume'da
qoladi. Sxema yangilanishidan oldin server baza faylining aniq nusxasini saqlab qo'yadi.

### Asl Yaya'dan ma'lumot ko'chirish (ixtiyoriy)
Asl Yaya panelida shifrlangan zaxira (`.yaya` fayl) yuklab olinadi va Yaya 2.0 panelida import qilinadi.
Shundan keyin ikki tizim bir-biridan mustaqil davom etadi — keyingi o'zgarishlar o'zaro o'tmaydi.

## 2. GitHub Secrets (APK imzosi) — bir marta
GitHub → `abdullayev7052-bot/Yaya_2_0` → **Settings → Secrets and variables → Actions**.

**Secrets** tabida → **New repository secret** (4 marta), qiymatlar `yaya-github-secrets.txt` faylida:
- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

Secrets har bir repo uchun alohida: asl Yaya reposidagilari bu repoga o'tmaydi. Ular qo'shilmasa, APK ochiq
"debug" kalit bilan imzolanadi — bunday APK'ni xodimlarga bermang.

Server manzili ilova kodiga yozilgan (`mobile/app.config.js` → `https://yaya2-production.up.railway.app`).
Boshqa serverga o'tilsa, **Variables** tabida `YAYA_API_URL` = `https://<domen>` qo'shiladi.

APK ikki holatda yig'iladi:
- `main` ga push qilinganda, agar `mobile/` ichida yoki workflow faylida o'zgarish bo'lsa — avtomatik;
- qo'lda: **Actions → Android APK → Run workflow** → branch `main` → **Run**.

~10 daqiqadan so'ng run sahifasida **Artifacts → yaya-apk-N** paydo bo'ladi (30 kun saqlanadi).
Imzo to'g'ri bo'lsa, logda "Sign with Yaya release key" qadamida sertifikat chiqadi (ogohlantirish emas).
Paneldagi logo yig'ish paytida serverdan olinib, ilova ikonkasiga aylanadi.

## 3. Telefonga o'rnatish
1. APK zipni kompyuterga yuklab oling, ochib `yaya.apk` ni Telegram (o'zingizga "Saved Messages")
   yoki USB orqali telefonga o'tkazing.
2. Telefonda faylni bosing → "Noma'lum manbalardan o'rnatish"ga **faqat shu ilova (Telegram/Fayllar)** uchun ruxsat bering.
3. Play Protect ogohlantirsa: **Batafsil → Baribir o'rnatish** (ilova Play Market'da emasligi uchun).
4. O'rnatgach, o'sha ruxsatni qayta o'chirib qo'ying (Sozlamalar → Ilovalar → Telegram → Noma'lum ilovalarni o'rnatish → O'chirish).
5. Yangilash: yangi APK'ni xuddi shunday o'rnating — eski ma'lumotlar saqlanib qoladi (imzo bir xil bo'lgani uchun).
   ⚠️ Ilovani **o'chirmang** va "Ma'lumotlarni tozalash"ni bosmang — yuborilmagan yozuvlar yo'qoladi.

"Yaya 2.0" ilovasi asl "Yaya" ilovasini almashtirmaydi: paketi boshqa, shuning uchun ikkalasi bitta telefonda
yonma-yon turadi va har biri o'z serveriga ulanadi.

## 4. Birinchi sozlash (boshqaruv paneli)
1. **Sozlamalar** → kompaniya nomi, **salomlashish matni** (`{ism}` ismga almashadi) va **logo** (PNG/JPG).
   Logo keyingi APK ikonkasiga aylanadi. Panelda "Kirish animatsiyasi" (video) yuklash ham bor, lekin
   2.8.2 dan boshlab ilova ochilganda video o'ynalmaydi — faqat logo ko'rsatiladi. "Mening hisobim" — admin o'z ism/login/parolini shu yerda o'zgartiradi.
2. **Mahsulotlar** → Yog'li sut, Yog'siz sut va hokazo.
3. **Xonadonlar** (yetkazib beruvchilar) → bittalab qo'shing yoki **⬇ Excel shablon** → to'ldirib → **⬆ Excel'dan import**.
   Shablon ustunlari: ism, telefon, manzil, mahsulot, narx, hozirgi qarz, **sut yig'uvchilar** (login, vergul bilan; bir nechta bo'lishi mumkin).
   Import oldidan tekshiruv natijasi ko'rsatiladi. Kartochkadagi **📍 Xaritada belgilash** bilan har bir
   xonadonning joyini belgilash mumkin (sut yig'uvchi ilovadan ham belgilay oladi).
4. **Rollar va ruxsatlar** → har bir rol ilovada nimani qila olishini belgilang.
5. **Xodimlar** → har bir xodim uchun login, parol va rol. Sut yig'uvchiga **Biriktirish** bosib xonadonlarni tanlang (tartib = yo'nalish).
6. **Qurilmalar** → har bir xodim nechta telefondan kira olishini belgilang. Telefon almashsa, "Bo'shatish" bosiladi.
7. **Laboratoriya** (ixtiyoriy) → sifat ko'rsatkichlari va ularning limitlari.
8. **Integratsiya** (ixtiyoriy) → Telegram botlar, quyidagi 5-bo'limga qarang.
9. **Ilovani sinash** → test xodim bilan noutbukda sinab ko'ring.
10. Telefonda hamma bir xil kiradi: **login + parol**. Ilova rolga qarab kerakli bo'limlarni ochadi.
    "Men" bo'limida PIN, barmoq izi va avtomatik qulflashni yoqing.

## 5. Telegram botlar (panel → Integratsiya)
Ikkala bot ham panelning o'zidan sozlanadi: token kiritiladi, "Tokenni tekshirish" bosiladi, "Bot yoqilgan"
belgilanadi va saqlanadi. Serverni qayta ishga tushirish shart emas. Tokenlar @BotFather'da `/newbot` orqali olinadi.

⚠️ Asl Yaya botlarining tokenlarini bu yerga kiritmang — Yaya 2.0 uchun **alohida botlar** oching. Bitta
token bilan ikki server ishlasa, xabarlar ular orasida bo'linib ketadi.

### Xonadon boti
- Xonadon botga kirib telefon raqamini ulashadi. Raqam tizimdagi faol xonadonga tegishli bo'lsagina
  ro'yxatdan o'tadi; har bir xonadon faqat o'z ma'lumotini ko'radi.
- Avtomatik xabarlar: xarid (smena qabul qilinganda), to'lov, bekor qilingan to'lov, balans tahriri.
  Qaysi xabarlar va xabar ichidagi qaysi maydonlar yuborilishi panelda belgilanadi.
- Bot tugmalari: Xaridlar, To'lovlar, Balans, Profil.
- Tashkilot nomi hamda kirish / ro'yxatdan o'tish / xatolik matnlari panelda tahrirlanadi.

### Backup (zaxira) boti
- Har kuni belgilangan vaqtda (Toshkent vaqti) shifrlangan `.yaya` zaxira faylini yuboradi:
  **Admin ID** ga va, kiritilgan bo'lsa, **Kanal ID** ga.
- **Zaxira paroli** majburiy — fayl shu parol bilan ochiladi. Parolni yo'qotmang.
- Kanalga yuborish uchun bot kanalda administrator bo'lishi, Kanal ID esa `-100…` ko'rinishida bo'lishi kerak.
- "Hozir yuborish" tugmasi har bir manzil (Admin / Kanal) bo'yicha natijani alohida ko'rsatadi.
- Bot bilan faqat ko'rsatilgan admin gaplasha oladi (`/now` — zaxirani hozir yuborish).

## 6. Qo'shimcha

### 1-versiyadan o'tish
Server yangilanganda baza avtomatik o'tkaziladi:
- Sut yig'uvchilar **login = telefon raqami**, **parol = eski PIN** bilan kiradi. Keyin admin parolni almashtirishi mumkin.
- Omborlar olib tashlanadi.
- Eski "tasdiqlangan" smenalar "qabul qilingan", "rad etilgan" smenalar "bekor qilingan" bo'ladi.
- Telefonlardagi yuborilmagan yozuvlar yo'qolmaydi: yangi ilovaga kirgach, ular yuboriladi.

### Favqulodda kirish
Agar admin parolini butunlay unutsa (panel yoki ilova), **dasturchida** zaxira (tiklash) kirish usuli bor.
U faqat eng so'nggi chora sifatida ishlatiladi: admin dasturchiga murojaat qiladi. Bu usul hech qayerda ko'rinmaydi
va kundalik ishda ishlatilmaydi.
