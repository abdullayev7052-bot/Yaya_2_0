# Yaya — reja

## Maqsad
Sut yig'uvchi (haydovchi) yo'lda, internet bo'lmasa ham, 3 ta bosishda xaridni kiritadi:
**yetkazib beruvchini bosadi → kg kiritadi → OK**.
Yaya — **to'liq mustaqil** tizim: o'z bazasi, o'z hisob-kitobi, o'z analitikasi, o'z ruxsatlar tizimi.

## Arxitektura
```
 [Mobil ilova — barcha xodimlar]  --(HTTPS, oflayn navbat)-->  [Yaya server: Node.js + SQLite]  <--  [Veb panel — faqat admin]
  · bitta login: rol bo'limlarni ochadi                         Railway, volume /data
  · PIN / barmoq izi qulfi
```

| Qism | Texnologiya |
|---|---|
| Server | Node.js + Fastify + SQLite (bitta fayl baza, volume'da) |
| Veb panel | Faqat admin (ruxsat: "Veb boshqaruv paneliga kirish") |
| Mobil | React Native (Expo); telefonda SQLite; iOS ham shu koddan |
| Brauzer test | Mobil ilovaning o'zi web'ga yig'iladi (`/app/`) |
| APK | GitHub Actions; doimiy kalit bilan imzolanadi; ikonka = yuklangan logo |

## Xodimlar, rollar va ruxsatlar
Har bir xodim — bitta hisob (login + parol). Kirish ekranida "kim siz?" so'ralmaydi: server login orqali
odamni taniydi, ilova faqat uning roliga ruxsat etilgan bo'limlarni ochadi.

| Rol | Ilovada nimani ko'radi |
|---|---|
| **Admin** | Hammasi + veb panel |
| **Menejer** | Kun hisoboti, smenalarni qabul/bekor qilish, qarzlar va to'lovlar, narxlar |
| **Omborchi** | Smenalarni qabul qilish / bekor qilish / nusxa, qarzlar, to'lov; narx va summalarni ko'rmaydi |
| **Buxgalter** | Smenalarni qabul/bekor qilish, narxlar, qarzlar, to'lov va uni bekor qilish, hisobot, Excel |
| **Sut yig'uvchi** | Smena ochish, sut kiritish, o'z ochiq smenasini tuzatish, yetkazib beruvchi kartochkasi (kg va qarz, narxsiz), to'lov |

Ruxsatlar admin panelda **guruhlab** ko'rsatiladi va istalgan rolga yoqiladi yoki o'chiriladi. Masalan, "Yangi
yetkazib beruvchi qo'shish", "Yetkazib beruvchini tahrirlash", "Bekor qilingan smenadan nusxa olish".
Ruxsatlar **serverda** tekshiriladi. Narxlarni ko'rish ruxsati bo'lmasa, server javobidan narx va summalar olib tashlanadi.

## Smena qoidalari
`ochiq (qoralama)` → yopiladi → `qabul kutmoqda` → `qabul qilingan` yoki `bekor qilingan`

- **Ochiq smena — qoralama.** Uni egasi erkin tahrirlaydi va qatorlarni o'chiradi (ruxsat bo'yicha). Qarzga ham, hisobotga ham kirmaydi.
  Admin va ruxsatli xodimlar ochiq smena miqdorlarini jonli ko'radi.
- **Yopilgan smenani hech kim o'zgartira olmaydi**, admin ham. Faqat qabul qilish, bekor qilish yoki nusxa olish mumkin.
- Sut **faqat smena yopilib, qabul qilingandan keyin** qarzga va hisobotga kiradi. Narx shu paytda muhrlanadi.
  Narxi belgilanmagan qator bo'lsa, smena qabul qilinmaydi.
- **Bekor qilingan** smena hisobga kirmaydi va qarz yaratmaydi. Sababi majburiy va xodimga ko'rinadi.
- **Nusxa** — xuddi shu raqamli yangi ochiq smena ("#12-copy"). Xodim qatorlarni tuzatib qayta yopadi, hammasini qaytadan kiritish shart emas.
- Smenalar yagona raqamlanadi (#1, #2, ...).
- Xodim oldingi smenasi ochiq yoki qabul qilinmagan bo'lsa, yangi smena ocha olmaydi.
- **To'lovlar darhol hisobga kiradi**, smena holatidan qat'i nazar.

## Hisob-kitob qoidalari
- Narx har bir yetkazib beruvchi + mahsulot uchun alohida.
- Summa = `round(miqdor × narx)` har bir qator uchun.
- **Qarz** = boshlang'ich qarz + qabul qilingan sut summasi − to'lovlar. Musbat — biz qarzmiz, manfiy — avans.
- **O'rtacha tannarx** (har mahsulot uchun) = jami summa ÷ jami miqdor, faqat qabul qilingan smenalardan.
- Kun — Toshkent vaqti (UTC+5). Test xodimning yozuvlari hisobotlar va qarzlarga kirmaydi.

## Himoya
- **Qurilma joylari:** har bir xodim faqat o'ziga ochilgan joylar soniga teng qurilmadan kira oladi
  (admin — 3, boshqalar — 1, admin o'zgartiradi). Joylar band bo'lsa, to'g'ri parol bilan ham yangi qurilmadan kirib bo'lmaydi.
  Joy bo'shatilsa, eski qurilma darhol chiqariladi.
- **Ilova qulfi:** 4 xonali PIN va barmoq izi / Face ID. Avtomatik qulflash 1, 5, 15, 30, 60 daqiqa yoki o'chiq.
  5 marta noto'g'ri PIN kiritilsa, ilova hisobdan chiqaradi.
- Telefonda xodim chiqmaguncha hisobda qoladi. Veb panel sessiyasi 12 soat.
- Parollar bcrypt bilan saqlanadi. Login'ga ko'p xato urinish bloklanadi. Har bir IP uchun so'rovlar soni cheklangan.
- HTTPS (HSTS). Qidiruv tizimlari va botlar uchun `noindex` va `robots.txt`. Panelga qat'iy CSP.
- Har bir muhim amal **oddiy o'zbek tilida** jurnalga yoziladi: kim, qachon, nima qildi.
- Excel eksportda formula-injection'dan himoya bor.

## Ma'lumotlar
- **Zaxira nusxa:** butun tizim bitta `.yaya` faylga, siz tanlagan parol bilan AES-256 shifrlab yuklab olinadi.
  Yangi serverda (masalan 2.0) shu fayl import qilinadi va ish to'xtagan joyidan davom etadi.
- **Tarixni tozalash:** admin paroli, matematik savol, aniq ibora va jiddiy ogohlantirish so'raladi.
  Oldin avtomatik nusxa olinadi va **3 kun ichida tiklash** mumkin.

## Oflayn kafolatlar (telefon)
- Har bir yozuv, tuzatish va to'lov OK bosilishi bilan telefon bazasiga yoziladi. "Keshni tozalash" ularni o'chirmaydi.
- Internet chiqishi bilan (va har 30 soniyada) yuboriladi. Takror yuborish ikki marta yozmaydi.
- Server rad etgan yozuv sababi bilan ko'rsatiladi.
- Telefonga boshqa xodim kirsa, avvalgisining yuborilmagan yozuvlari boshqa nom bilan ketmaydi.

## Bosqichlar
| # | Bosqich | Holat |
|---|---|---|
| 1 | Server, baza, mobil sinxron, panel, APK, Railway | ✅ |
| 2 | Mustaqil tizim: analitika, grafiklar, Excel, bekor qilish, jurnal, brauzer test | ✅ |
| 3 | To'lovlar va qarz, yetkazib beruvchi kartochkasi (akt-sverka), o'rtacha tannarx | ✅ |
| 4 | Rollar va ruxsatlar, smenani tasdiqlash, sut yig'uvchining o'z xatosini tuzatishi, dala to'lovi | ✅ |
| 5 | Mobil "Rahbar" rejimi, telefon bo'yicha qidiruv, Excel import, logo | ✅ |
| 5.1 | Barcha xodimlar uchun bitta ilova, smart login, qurilma joylari, ilova qulfi | ✅ |
| 5.2 | Smena: qoralama → yopish → qabul/bekor → nusxa; raqamlash; faqat qabul qilinganlar hisobda | ✅ |
| 5.3 | Shifrlangan zaxira/import, himoyalangan tozalash (3 kun tiklash), o'zbekcha jurnal; omborlar olib tashlandi | ✅ |
| 6 | Telegram'ga kunlik hisobot | ⏳ tayyorgarlik: [NEXT.md](NEXT.md) |
| 7 | Manzil va geolokatsiya | ⏳ tayyorgarlik: [NEXT.md](NEXT.md) |
| 8 | iOS versiya | ⏳ tayyorgarlik: [NEXT.md](NEXT.md) |

## Qo'shimcha imkoniyatlar (2.1)
- **Joylashuv va marshrut:** yetkazib beruvchi kartochkasida (panel va ilova) manzil va xaritadagi nuqta belgilanadi
  (hozirgi joy yoki xaritadan tanlab). Sut yig'uvchida smena ochiq paytda ro'yxat eng yaqinidan tartiblanadi,
  har birining yonida masofa (m/km) ko'rsatiladi; bosilsa Google xaritada marshrut ochiladi. Faqat sut yig'uvchidan joylashuv so'raladi.
- **Narx va qarz:** narx qabul qilish payti muhrlanadi — keyin narx o'zgartirilsa, eski qarz o'zgarmaydi, yangi narx faqat keyingi xaridlarga.
- **Ruxsatlar:** "manzil/joylashuvni belgilash" alohida ruxsat (ism/telefon tahriridan ayrim).
- **Sozlamalar:** salomlashish matni ({ism}) va kirish animatsiyasi (qisqa ovozsiz video).
- **To'lovlar:** har bir to'lov kim tomonidan (qaysi xodim) kiritilgani yoziladi va ko'rinadi.
- **Hisob:** admin va boshqa sut yig'maydigan xodimlar uchun ilovada smena ochilmaydi (ular qabul qiladi, to'laydi, boshqaradi).
  Admin o'z ism/login/parolini o'zgartira oladi. Parolni esdan chiqargan admin uchun dasturchida zaxira kirish usuli bor.
