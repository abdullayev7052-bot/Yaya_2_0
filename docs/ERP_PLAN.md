# Yaya 2.0 — ishlab chiqarish tizimi: umumiy reja (v0.2)

Holat: **kelishilgan reja**, javoblaringiz (2026-11-18) kiritilgan. Ish bosqichma-bosqich boshlandi.
Hali aniqlanadigan joylar 13-bo'limda.

## 1. Maqsad va chegaralar
Sexdagi butun zanjir bitta tizimda:

**sut xaridi → xom sut ombori → texnolog → quyish → issiqxona → qopqoq yopish → tayyor mahsulot ombori →
sotuv → qaytarish → muddati o'tganni qayta ishlash**, ustida moliya, kassa, oylik, hisobotlar.

| Qilinadi (10 kun) | Keyinga qoldirildi |
|---|---|
| Ombor, ishlab chiqarish, qayta ishlash, sotuv, qaytarish | iPhone / iPad versiyasi |
| Kassa, kontragentlar, oylik, asosiy hisobotlar | Buyurtma olish |
| Brauzer + oflayn **Desktop** + Android (bitta kod) | Yetkazib berish / logistika |
| Boshlang'ich qoldiq va balanslar, inventarizatsiya, Excel import | Soliq, Didox, rasmiy hisob-faktura |
| 80 mm chek printeri | Tarozi integratsiyasi, alohida POS dasturi |
| Faqat so'm | Boshqa valyutalar |
| | Ijara, kommunal kabi umumiy xarajatlarni tannarxga qo'shish (joyi qoldiriladi) |

**Sut yig'ish** tayyor: alohida bo'lim bo'lib qoladi, faqat takomillashtiriladi. Qabul qilingan smena endi
avtomatik ravishda xom sut omboriga kirim bo'ladi.

## 2. Kim qayerda ishlaydi
| Kim | Qurilma | Rejim |
|---|---|---|
| Sut yig'uvchilar | o'z telefoni | hozirgidek, o'zgarmaydi |
| Sex xodimlari (5+) | **1 ta umumiy monoblok** | "xodim almashish": har kim qisqa PIN kodini terib kiradi, ishini yopadi, chiqadi |
| Sex xodimlari (svet o'chganda) | o'z telefoni | xuddi shu ishlar |
| Admin | telefon + panel | hammasi, narx va moliya |
| 2 menejer | noutbuk, brauzer | boshqaruv, ogohlantirishlar |

Sexda internet barqaror emas → **monoblok va telefonlar internetsiz ham hamma ishni bajaradi**, internet chiqqanda
o'zi sinxronlanadi (hozirgi sut yig'ish mexanizmi kabi).

### Ikki xil ekran
- **Ish joyi** (monoblok, telefon, brauzer) — xodimlar uchun: topshiriqlar, qabul/topshirish, sotuv, qaytarish,
  inventarizatsiya. **Tannarx va summalar ko'rinmaydi.**
- **Boshqaruv paneli** (`/admin/`) — admin uchun: narxlar, moliya, kassa, sozlamalar, hisobotlar. Har bir amal tarixida
  admin summalarni ko'radi.

Bu qoida serverda tekshiriladi: tannarx ko'rish ruxsati bo'lmagan xodimga server summalarni umuman yubormaydi.

## 3. Asos: uchta daftar va hujjatlar
Qoldiqlar qo'lda yozilmaydi — hammasi harakatlardan hisoblanadi.

1. **Ombor daftari** — nima, qaysi partiya, qayerda (ombor **yoki xodim zimmasida**), qancha, tannarxi, qaysi hujjat.
2. **Kontragent daftari** — mijoz, yetkazib beruvchi, xonadon, xodim bilan oldi-berdi.
3. **Kassa daftari** — har bir kassa va to'lov turi bo'yicha kirim-chiqim.

**Hujjat** — daftarlarga yozuv tushiradigan yagona narsa. Raqamlanadi, holati bor (qoralama → o'tkazilgan → bekor
qilingan), o'tkazilgandan keyin o'zgarmaydi. Bekor qilinsa, uning barcha oqibatlari ham (ombor, balans, **ish haqi**)
teskari yoziladi. Har bir hujjatda mijozning qurilmasi yaratgan UUID bor — oflayn qayta yuborish ikki marta yozmaydi.

**Topshirish → qabul qilish.** Mahsulot bir joydan ikkinchisiga faqat shunday o'tadi; qabul qilinmaguncha
topshiruvchi zimmasida turadi. Xodim xodimga ham topshira oladi — zanjir qabul qilgan xodimdan davom etadi.

**FIFO.** Har bir kirim — alohida partiya (o'z tannarxi bilan). Chiqimda shu joydagi eng eski partiya birinchi ketadi.

**Manfiy qoldiq** — har bir omborda alohida: ruxsat bor/yo'q va manfiyga tushganda ogohlantirish yuborish/yubormaslik.

## 4. Nomenklatura
Mahsulot kartochkasi:
- turi: xom sut, xomashyo, yarim tayyor (quyma), idish/tara, etiketka, tayyor mahsulot, qaytgan, qayta ishlangan;
- o'lchov birligi (kg, g, l, dona...) — birliklar ro'yxati sozlamada;
- **vazn: netto va brutto** (gramm); **hajm** (son + birlik: m³, m², l...) va **shakl** (dumaloq, to'rtburchak...);
- yaroqlilik muddati; **issiqxonada / omborda turish vaqti** (soat);
- turkum, artikul/shtrix-kod, faol/nofaol.

Sotuv, qaytarish, ombor hisobotlari va cheklarda umumiy vazn va hajmni ko'rsatish yoki yashirish — sozlama.

## 5. Ishlab chiqarish
### Tarkiblar (shablonlar)
- Sozlamada istalgan payt qo'shiladi, o'zgartiriladi, o'chiriladi: mahsulot → xomashyo, idish, etiketka va miqdorlari.
- Har bir qatorga **alternativ mahsulotlar** qo'shiladi (masalan boshqa idish yoki etiketka).
- Texnolog yoki quyuvchi topshiriqda mahsulotni tanlasa, tarkib avtomatik keladi. Shu partiya uchun qatorni o'zgartirish
  yoki alternativni bir bosishda tanlash mumkin (asl tarkib o'zgarmaydi).

### Separatsiya (bitta kirim → bir nechta mahsulot)
Sozlama: chiqadigan mahsulotlar va tannarx qanday bo'linishi.
- **Qat'iy tannarx:** bir mahsulotga belgilangan 1 kg tannarxi (masalan qaymoq 42 000 so'm, undan oshmaydi);
- **foiz** bo'yicha bo'lish;
- **qoldiq:** qolgan barcha xarajat boshqa mahsulot(lar)ga avtomatik tushadi.

Misol: qaynatilgan sut 1 237,50 kg, tannarxi 7 103 505,41 so'm → qaymoq 86,50 kg × 42 000 = 3 633 000 →
qolgan 3 470 505,41 so'm yog'siz sutga → 1 151,00 kg, 1 kg = 3 015,21 so'm.
(Keyingi versiyalarda boshqa usullar qo'shiladi.)

### Yo'qotish limitlari
- kg yoki foizda; texnolog, quyuvchi va qayta ishlash uchun alohida;
- **shartli limit:** "shuncha xomashyo ishlatilsa, chiqadigan mahsulot X dan kam va Y dan ko'p bo'lmasin";
- limitdan chiqsa — topshiriq yopilmaydi, **ogohlantirish sozlamasida** belgilangan admin/menejerlarga xabar boradi,
  ular sabab yozib ruxsat beradi yoki rad etadi.

### Bosqichlar
1. **Texnolog:** ombordan sut va xomashyoni qabul qiladi → tayyorlaydi (tarkib bo'yicha) / separatsiya qiladi →
   quymani kg da quyuvchiga topshiradi.
2. **Quyish:** quyuvchi quymani kg da qabul qiladi, idish omborchisidan idish oladi, quyadi, ishlatilmagan idishni
   qaytaradi, mahsulotni issiqxonaga topshiradi.
3. **Issiqxona:** omborchi qabul qiladi; har bir mahsulotning turish vaqti hisoblanadi.
4. **Qopqoq yopish:** issiqxonadan qabul qiladi, qopqoqlaydi, tayyor mahsulot omboriga topshiradi.

### Ortib qolgan quyma
Quyilmagan holicha omborga topshiriladi (omborchi qabul qiladi) yoki boshqa xodimga topshiriladi (u qabul qilgach
o'tadi, zanjir undan davom etadi).

### Xodim aybi bilan to'kilgan / sidirilgan mahsulot
Sut, quyma, tayyor mahsulot, xomashyo, idish — istalgani. Tannarxi **xodim balansiga** yoziladi (xodim kompaniyadan
qarzdor bo'ladi) va oylikdan ushlanadi.

### Kechikkan topshiriqlar
Har bir topshiriq turi uchun muddat sozlanadi. Muddat o'tsa: ovozli signal, xodim telefoniga push va monoblokda
**xodim ismi bilan** ogohlantirish. Kimga, qachon — ogohlantirish sozlamasida.

### Ishbay haq
- Har bir mahsulot va amal (quyish, qopqoq yopish...) uchun stavka sozlanadi (masalan 1 dona uchun 170 so'm).
- Bitta topshiriqni bir nechta xodim bajarishi mumkin: yopayotganda "Necha kishi birga quydi?" deb so'raydi,
  xodimlar ismi tanlanadi, haq teng bo'linadi (2 kishi — 85 dan, 3 kishi — 56,67 dan).
- Topshiriq bekor qilinsa, ish haqi ham bekor qilinadi.

### Tannarx
Hozircha: sut + xomashyo + idish/etiketka + ishbay haq. Keyin sozlamada boshqa xarajatlar (ijara, kommunal)
qo'shilishi uchun joy qoldiriladi.

## 6. Qayta ishlash (muddati o'tgan mahsulot)
Oddiy ishlab chiqarishdan alohida sozlama va boshqa formula.

Misol: "muddati o'tgan" omborida 1 dona **Smetana 20% 400 g** (tannarxi 7 000 so'm):
- chiqadi: 1 dona **V idish smetana 20% 400 g** — tannarxi sozlamadagi qat'iy narx (masalan 800 so'm);
- chiqadi: **400 g "Vozvrat qatiq"** (yoki "Vozvrat qaymoq") — miqdori mahsulotning **netto vaznidan**, tannarxi **0**;
- qolgan 6 200 so'm → **"Qayta ishlashda yo'qotilgan tannarx"** xarajati (xarajat nomlari sozlamada o'zgartiriladi).

Qoidalar:
- Chiqadigan kg tizim hisoblaydi, xodim tasdiqlashdan oldin o'zgartira oladi — **limit ichida** (masalan 400 o'rniga
  370–450 g).
- Bo'sh idish soni ham o'zgartiriladi. Kam kiritilsa tizim so'raydi: "17 ta chiqishi kerak edi, 14 ta kiritdingiz,
  qolgan 3 tasi nima bo'ldi?" — 3 avtomatik turadi, xodim sabab tanlaydi (singan / yo'qolgan, aralash ham bo'lishi mumkin).
  Bu idishlar avval 800 so'mdan qayta ishlab chiqarilgan deb, keyin hisobdan chiqarilgan deb yoziladi:
  3 × 800 = 2 400 so'm kompaniya xarajati, sof foydani kamaytiradi.
- Usul keyinroq kengaytiriladigan qilib quriladi.

## 7. Savdo
- **Mijoz turlari** sozlamada (do'kon, diler, chakana...), har bir mijozga **alohida narx** bo'lishi mumkin.
- Sotuv FIFO bo'yicha (eng avval ishlab chiqarilgan partiya birinchi).
- Chek: 80 mm printer, omborchi va mijoz imzosi uchun joy.
- **Qaytarish turlari** sozlamada: har bir tur o'z omboriga avtomatik tushadi (sifatli → tayyor mahsulot ombori,
  muddati o'tgan → muddati o'tganlar ombori va h.k.).
- **Muddati o'tgan qaytarish siyosati — har bir mijozda:** balansdan ayriladi yoki ayrilmaydi.
- **Qaytgan mahsulot tannarxi** qaytarishda tanlanadi:
  - *oxirgi narx* — shu mijozga sotilgan aynan shu mahsulot partiyasining tannarxi;
  - *o'rtacha narx* — shu mijozga oxirgi N kun (masalan 7) ichida sotilgan shu mahsulot tannarxlari yig'indisi ÷ miqdor.

## 8. Moliya
- Bir nechta **kassa**; bitta kassaga bir nechta mas'ul. Xodim o'z profilidan sotsa, pul o'zi mas'ul kassaga tushadi;
  keyin o'tkazma bilan asosiy kassaga o'tkaziladi.
- To'lov turlari (naqd, karta, o'tkazma...) sozlamada.
- Mijozdan pul olish, yetkazib beruvchi va xonadonga to'lash, xarajatlar va ularning toifalari.
- **Oylik:** oklad + ishbay + bonus − jarima − xodim aybi bilan yo'qotilgan mahsulot. Istalgan payt bonus yoki jarima.
- Balanslar va akt-sverka: mijoz, yetkazib beruvchi, xonadon, xodim, kassa.

## 9. Boshlang'ich ma'lumot
Server hozir bo'sh — haqiqiy ma'lumot hamma jarayon tugagach kiritiladi. Shuning uchun:
- **boshlang'ich balanslar**: mijoz, yetkazib beruvchi, xonadon, xodim, kassa;
- **boshlang'ich qoldiqlar** va **inventarizatsiya** (to'liq va qisman);
- hammasi bittalab ham, **Excel shablon orqali ommaviy** ham kiritiladi (avval tekshiruv natijasi ko'rsatiladi).

## 10. Sozlamalar
Har bir bo'limning o'z sozlamalari bo'ladi, qiyin joylarda izoh bilan:

| Bo'lim | Sozlamalar |
|---|---|
| Umumiy | kompaniya, logo, o'lchov birliklari, ko'rinish (vazn/hajm cheklarda) |
| Ombor | omborlar va mas'ullar, manfiy qoldiq va ogohlantirish (har biriga alohida), hisobdan chiqarish sabablari |
| Ishlab chiqarish | tarkiblar, separatsiya, yo'qotish limitlari, ishbay stavkalar, turish vaqtlari, topshiriq muddatlari |
| Qayta ishlash | qaysi mahsulotdan nima chiqadi, idish narxi, kg limitlari, xarajat nomi |
| Savdo | mijoz turlari, narxlar, qaytarish turlari → omborlar, muddati o'tgan siyosati, chek shabloni |
| Moliya | kassalar va mas'ullar, to'lov turlari, xarajat toifalari |
| Xodimlar | rollar, ruxsatlar, PIN, qurilmalar, oklad |
| Ogohlantirishlar | kimga, qaysi hodisada, qanday (ilova, ovoz, push, Telegram) |
| Sut yig'ish | mavjud sozlamalar |

## 11. Platformalar
Bitta server, bitta kod:
- **Ish joyi ilovasi** (hozirgi Expo ilova kengayadi): Android telefon/planshet, brauzer va **Desktop** (Windows ilova
  ichida shu web versiya + oflayn baza). Monoblokda katta tugmalar va xodim almashish rejimi.
- **Boshqaruv paneli** — brauzerda.
- Yig'ish (APK, Desktop o'rnatuvchi) **eng oxirida** — hammasi avval ichki brauzerda sinaladi.

## 12. Bosqichlar
| # | Bosqich | Holat |
|---|---|---|
| 1 | **Ombor asosi:** nomenklatura (vazn, hajm, shakl, muddatlar), omborlar va mas'ullar, manfiy qoldiq sozlamasi, partiyalar va FIFO, topshirish-qabul, hisobdan chiqarish (xodim hisobiga ham), boshlang'ich qoldiq, inventarizatsiya, Excel import; qabul qilingan sut → xom sut ombori | ⏳ boshlandi |
| 2 | **Ishlab chiqarish:** tarkiblar va alternativlar, texnolog topshiriqlari, separatsiya, yo'qotish va shartli limitlar, ruxsat so'rash | |
| 3 | **Quyish zanjiri:** quyish (ko'p xodim, ishbay haq bo'linishi), idish berish/qaytarish, issiqxona va turish vaqti, qopqoq yopish, ortgan quyma | |
| 4 | **Savdo:** mijozlar va turlari, narxlar, sotuv, chek, qaytarish turlari, qaytgan tannarx (oxirgi/o'rtacha), muddati o'tgan siyosati | |
| 5 | **Qayta ishlash** (6-bo'lim) | |
| 6 | **Moliya va oylik:** kassalar, to'lov turlari, to'lovlar, xarajatlar, o'tkazmalar, oylik, boshlang'ich balanslar, akt-sverka | |
| 7 | **Ish joyi ilovasi:** monoblok rejimi, PIN bilan almashish, topshiriqlar ro'yxati, ogohlantirishlar (ovoz, push) | |
| 8 | **Hisobotlar va dashboardlar** | |
| 9 | Sinov, tuzatish, so'ng Android va Desktop yig'ish | |

Har bir bosqich serverda testlar bilan yoziladi va panel/ilovada sinab ko'riladigan holga keltiriladi.

## 13. Hali aniqlanadigan joylar
1. Oklad qanday hisoblanadi: oyma-oy qat'iy summami yoki ishlagan kunga qarabmi?
2. Ogohlantirishlar Telegram'ga ham borishi kerakmi (rahbarlar guruhi) yoki ilova yetarlimi?
3. Inventarizatsiyada kamomad kim hisobiga: har doim kompaniyami yoki mas'ul omborchi tanlanadimi?
4. Chek shablonida nimalar bo'lsin (logo, kompaniya nomi, mijoz qarzi, imzo joylari)?
