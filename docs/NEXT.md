# Keyingi yangilanishlar — tayyorgarlik

Quyidagilar hali **boshlanmagan**. Tizim ularga tayyorlab qo'yilgan, ish siz "boshla" deganingizda boshlanadi.

## 1. Telegram: kunlik hisobot, bot va guruh

### Nima bo'ladi
- **Har bir hodisada darhol xabar** yuboriladi:
  - smena yopildi (kim, nechta uy, necha kg);
  - smena qabul qilindi;
  - smena bekor qilindi (sababi bilan; agar qabul qilingan smena bekor qilingan bo'lsa — alohida ogohlantirish);
  - nusxa ochildi.
- **Kunlik hisobot** belgilangan soatda (masalan 20:00) yuboriladi:
  - qabul qilingan kg (mahsulot bo'yicha);
  - o'rtacha tannarx;
  - kim qancha yig'di;
  - qabul kutayotgan smenalar;
  - jami qarz.
- AI ishlatilmaydi: server oddiy matn yuboradi.

### Tayyor
- Serverda **`events` jadvali** (outbox) bor. Smena yopilganda, qabul qilinganda, bekor qilinganda va nusxa olinganda yozuv tushadi: `shift.closed`, `shift.accepted`, `shift.cancelled`, `shift.copied`. `delivered_at` — yuborilgan vaqt.
- Telegram ulanganda shu navbatdagi xabarlar tartib bilan, bittadan, yo'qolmasdan yuboriladi.
- Internet uzilsa, xabarlar navbatda kutib turadi.
- Kunlik raqamlar tayyor: `/api/admin/dashboard?day=`.

### Bot va guruh — ulash tartibi
Bu ishni siz qilasiz, taxminan 5 daqiqa.
1. Telegram'da **@BotFather** ga `/newbot` yozing. Nom bering va **token** oling. Tokenni hech kimga bermang.
2. Rahbarlar uchun Telegram **guruh** oching (masalan "Yaya hisobot").
3. Botni guruhga qo'shing va guruhda `/start` yozing.
4. Panelda "Sozlamalar → Telegram" bo'limi qo'shiladi:
   - token kiritiladi;
   - "Guruhni topish" tugmasi bosiladi (server botga kelgan oxirgi xabardan guruh ID'sini oladi);
   - "Sinov xabari" yuboriladi.
5. Har bir xabar turi alohida yoqiladi yoki o'chiriladi. Kunlik hisobot soati tanlanadi. Kerak bo'lsa, ikkinchi guruh qo'shiladi (masalan, omborchilar uchun faqat "smena yopildi").

### Himoya
- Token serverda saqlanadi va panelga qaytib ko'rsatilmaydi.
- Bot faqat ro'yxatdagi guruh(lar)ga yozadi.
- Botga kelgan buyruqlar bajarilmaydi: bot faqat xabar yuboradi.

## 2. iOS versiya

### Tayyor
- Ilova React Native (Expo): **kodning o'zi iOS'da ham ishlaydi**.
  - `app.json`da `ios.bundleIdentifier` va Face ID ruxsati matni belgilangan.
  - Telefon bazasi (SQLite), oflayn navbat, PIN va Face ID qulfi iOS'ga mos.

### Sizdan kerak bo'ladi
1. **Apple Developer** hisobi (yiliga 99$). Ilovani iPhone'larga tarqatish uchun majburiy.
2. Mac kompyuter **shart emas**: iOS yig'ish Expo EAS bulut xizmatida bajariladi.
3. Tarqatish: **TestFlight** (yopiq, faqat xodimlar uchun) yoki App Store.

### Texnik reja
- `eas.json` qo'shiladi.
- GitHub Actions'da `eas build -p ios` va `eas submit` ishga tushiriladi.
- Ikonka Android'dagi kabi yuklangan logodan olinadi.
