# Keyingi yangilanishlar

Bu yerda faqat **hali qilinmagan** ishlar turadi. Qilingan ishlar: [CHANGELOG.md](CHANGELOG.md).

## Allaqachon tayyor (avval shu faylda reja edi)
- **Telegram botlar** — 2.8.0 da yozilgan: xonadon boti va backup (zaxira) boti. Kod: `server/src/integrations.js`
  va `server/src/telegram.js`; sozlash: panel → **Integratsiya**. Ulash tartibi: [DEPLOY.md](DEPLOY.md), 5-bo'lim.
- **Manzil va geolokatsiya** — 2.1 da qilingan: [PLAN.md](PLAN.md).

## 1. Telegram: rahbarlar guruhiga xabarlar va kunlik hisobot
**Boshlanmagan.** Hozirgi botlar xonadonlarga va zaxira uchun; xodimlar/rahbarlar guruhiga hech narsa yuborilmaydi.

### Nima bo'ladi
- **Har bir hodisada darhol xabar:**
  - smena yopildi (kim, nechta uy, necha kg);
  - smena qabul qilindi;
  - smena bekor qilindi (sababi bilan; qabul qilingan smena bekor qilingan bo'lsa — alohida ogohlantirish);
  - nusxa ochildi.
- **Kunlik hisobot** belgilangan soatda (masalan 20:00):
  - qabul qilingan kg (mahsulot bo'yicha);
  - o'rtacha tannarx;
  - kim qancha yig'di;
  - qabul kutayotgan smenalar;
  - jami qarz.
- AI ishlatilmaydi: server oddiy matn yuboradi.

### Tayyor
- Serverda **`events` jadvali** (outbox) bor va to'ldirib boriladi: `shift.closed`, `shift.accepted`,
  `shift.cancelled`, `shift.copied`. `delivered_at` — yuborilgan vaqt. Hozircha ularni **hech narsa yubormaydi**.
- Telegram bilan ishlash qismi tayyor (`server/src/telegram.js`), panelda Integratsiya sahifasi bor —
  yangi bo'lim shu yerga qo'shiladi.
- Kunlik raqamlar tayyor: `/api/admin/dashboard?day=`.

### Qilinadigan ish
- `events` navbatini tartib bilan, bittadan, yo'qotmasdan yuboruvchi qism (internet uzilsa, navbatda kutadi).
- Panel → Integratsiya: guruh(lar) ID'si, har bir xabar turini yoqish/o'chirish, kunlik hisobot soati,
  "Sinov xabari" tugmasi.
- Qaysi bot yuborishini hal qilish: alohida uchinchi bot yoki mavjud backup boti.

### Himoya
- Token serverda saqlanadi.
- Bot faqat ro'yxatdagi guruh(lar)ga yozadi.
- Guruhdan kelgan buyruqlar bajarilmaydi: bot faqat xabar yuboradi.

## 2. iOS versiya

### Tayyor
- Ilova React Native (Expo): **kodning o'zi iOS'da ham ishlaydi**.
  - `app.json`da `ios.bundleIdentifier` (`uz.yaya2.collector`), Face ID va joylashuv ruxsati matnlari belgilangan.
  - Telefon bazasi (SQLite), oflayn navbat, PIN va Face ID qulfi iOS'ga mos.

### Sizdan kerak bo'ladi
1. **Apple Developer** hisobi (yiliga 99$). Ilovani iPhone'larga tarqatish uchun majburiy.
2. Mac kompyuter **shart emas**: iOS yig'ish Expo EAS bulut xizmatida bajariladi.
3. Tarqatish: **TestFlight** (yopiq, faqat xodimlar uchun) yoki App Store.

### Texnik reja
- `eas.json` qo'shiladi.
- GitHub Actions'da `eas build -p ios` va `eas submit` ishga tushiriladi.
- Ikonka Android'dagi kabi yuklangan logodan olinadi.
