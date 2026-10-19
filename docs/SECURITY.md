# Xavfsizlik (Security notes)

Bu hujjat Yaya backend'ining xavfsizlik holatini qisqacha tushuntiradi — loyihani
biznes egasiga topshirishda va kelajakdagi dasturchi uchun.

## Himoya qilingan narsalar

- **Autentifikatsiya:** har bir so'rov `Authorization: Bearer <JWT>` bilan. JWT
  maxfiy kaliti `settings.jwt_secret`da saqlanadi (yo'q bo'lsa avtomatik
  generatsiya qilinadi); repozitoriyda ochiq ko'rinmaydi. CSRF yo'q (faqat
  header orqali, cookie ishlatilmaydi).
- **Avtorizatsiya:** har bir route `need(...)` yoki `needAny(...)` bilan
  ruxsat tekshiradi. Veb panel faqat `panel.access` (admin) uchun. Pul va
  rollarga oid amallar faqat tegishli ruxsatga ega foydalanuvchilarга.
- **SQL injection:** barcha so'rovlar `better-sqlite3` bind-parametrlari orqali;
  foydalanuvchi matni hech qachon SQLga qo'shib yozilmaydi.
- **XSS:** admin panel barcha dinamik matnni `esc()` orqali chiqaradi; `/admin`
  uchun CSP yoqilgan (`script-src 'self'`, `base-uri 'none'`).
- **Parollar:** bcrypt bilan hashlangan; hech qayerda log qilinmaydi.
- **Break-glass tiklash:** `admin` + maxfiy parol — faqat bcrypt hash kodda,
  ochiq parol repozitoriyda yo'q. Qurilma cheklovini chetlab o'tadi, lekin
  tokeni qisqa muddatli (12 soat) va login urinishlari cheklangan (IP+login
  bo'yicha 8/15daqiqa).
- **Zaxira (.yaya):** AES-256-GCM + scrypt bilan shifrlangan; parolsiz
  o'qib bo'lmaydi. Import'da "zip bomba"ga qarshi chiqarilgan hajm cheklangan.
- **Tarixni tozalash (wipe):** uch bosqichli himoya (arifmetik savol + parol +
  aniq ibora) va avtomatik 3 kunlik zaxira.
- **Brute force:** login uchun alohida cheklov + global 600 so'rov/daqiqa.
- **Fayl yuklash:** logo magic-byte bilan tekshiriladi; body hajmi cheklangan
  (standart 2 MB, intro video 12 MB, import 150 MB).

## 2026-10 auditida tuzatilgan muammolar

- Balanslarni tahrirlash (`/balances/edit`) endi faqat admin (`staff.manage`) va
  admin parolini qayta so'raydi — avval `payments.create` bo'lgan har kim (sut
  yig'uvchi ham) chaqira olar edi.
- `/payments` va `/suppliers/:id` (joylashuv) endi faqat o'ziga biriktirilgan
  xonadonlar uchun (agar foydalanuvchida "barchasini ko'rish" ruxsati bo'lmasa);
  to'lov javobidagi balans faqat `debts.view` bo'lsa qaytadi.
- `/roles`, `/permissions` → faqat `staff.manage`; `/staff/names` → faqat
  hisobot/smena/xodim ruxsatiga ega rollar.
- Break-glass token muddati 365 kundan 12 soatga qisqartirildi.
- Zaxira import'ida dekompressiya hajmi cheklandi (256 MB).

## E'tiborga olinadigan (past xavf, ataylab qoldirilgan)

- **Test foydalanuvchilar** qurilma cheklovini chetlab o'tadi (brauzer
  sinovchisi uchun). Test hisobiga imtiyozli rol bermang va kuchli parol qo'ying.
- **Zaxira fayli** ichida JWT kaliti va parol-hashlar bor (shifrlangan).
  Shifrlangan `.yaya` faylni ishonchli joyda saqlang; parolini yo'qotmang.

## Tavsiya

- **Repozitoriyni `private` qiling** (GitHub → Settings → Change visibility).
- Maxfiy qiymatlarni (`YAYA_API_URL`dan tashqari) faqat server muhit
  o'zgaruvchilarida saqlang, kodga yozmang.
