# Yaya 2.0 — ishlab chiqarish tizimi: umumiy reja (v0.3)

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

### Sut yig'uvchilardan kelgan sut → bitta "Xom sut"
- Sut yig'uvchilar (ilova va paneldagi sut yig'ish bo'limi) faqat **"Yog'li sut"** va **"Yog'siz sut"** ni ko'radi.
- Smena qabul qilinganda ikkalasi **bitta mahsulot — "Xom sut"** bo'lib xom sut omboriga kiradi:
  - miqdor = qabul qilingan (farq bilan yoki farqsiz) miqdorlar yig'indisi;
  - tannarx = shu smenada xonadonlarga belgilangan narxlar bo'yicha umumiy summa;
  - 1 kg tannarxi = umumiy summa ÷ umumiy miqdor (shu smenaning real o'rtachasi: kam chiqsa qimmatlashadi, ko'p chiqsa arzonlashadi).
  - Misol: 100 kg yog'li × 5 000 + 20 kg yog'siz × 3 000 = 560 000 so'm → 120 kg "Xom sut", 1 kg = 4 666,67 so'm.
- Ishlab chiqarishdagi **"Yog'siz sut"** butunlay boshqa mahsulot — separatsiyadan chiqadigan **xomashyo**.

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

### Limitlar — hammasi nisbatda
Tizimdagi har qanday limit sozlamada **ma'lum bir miqdor uchun** yoziladi (masalan 100 kg yoki 1 000 kg), lekin
**nisbatda ishlaydi**: miqdor ikki baravar kamaysa, limit ham ikki baravar kamayadi.
- Qaynatishdagi yo'qotish: "1 000 kg sutga 100 kg gacha" → 500 kg sut ishlatilgan smenada 50 kg gacha.
- Tayyor quyma og'irligi: "5%" tarkibi (xom sut 320 kg + toza qaymoq 6 kg + zakvaska 4,2 g = 326,0042 kg) uchun
  320–335 kg deb belgilansa, yarim tarkibda (163,0021 kg) tizim o'zi 160–167,5 kg deb biladi.
- Limitdan chiqsa — topshiriq yopilmaydi, **ogohlantirish sozlamasida** belgilangan admin/menejerlarga xabar boradi,
  ular sabab yozib ruxsat beradi yoki rad etadi.
- **Shartli limit** ham bo'ladi: "shu xomashyolar ishlatilsa, chiqadigan mahsulot X dan kam va Y dan ko'p bo'lmasin".

### Yo'qotish (va yutish) sabablari — har bir bo'limga alohida
- Sabablar ro'yxati sozlamada, nomlari o'zgartiriladi, har biriga **alohida limit**.
- Har bir sabab **faqat o'z bo'limida** ko'rinadi: texnolog sabablari quyuvchi yoki qayta ishlovchiga ko'rinmaydi va h.k.
- Har bir sababda ta'sir sozlanadi:
  - **tannarxga** — shu partiya mahsulotlari tannarxiga qo'shiladi (masalan "Qaynatishda", "Oxladitelda");
  - **kompaniya xarajatiga** (masalan "To'kildi");
  - **xodim hisobiga** (oylikdan ushlanadi).
- Xarajatga yoki xodimga yozilgan yo'qotish partiya tannarxiga **ta'sir qilmaydi**.
- Yo'qotish ham, **yutish** ham bo'ladi (90% holatda yo'qotish): yo'qotish qizil "−", yutish yashil "+"; yutish tannarxni arzonlashtiradi.

### Texnolog smenasi va sut sarfi
Qozonlar har xil, mahsulotlar aralash qaynaydi — qaynagan sutni tortib bo'lmaydi. Shuning uchun:
1. Smena davomida tizim har bir topshiriqning **sut sarfini** tarkib bo'yicha hisoblab boradi (separatsiya ham sut sarfi).
   Sut omborga hali kirim bo'lmagan bo'lsa ham vaqtincha manfiy qoldiqda hisoblanadi.
2. Smena oxirida tizim farqni o'zi topadi: masalan 1 000 kg sut olingan, 9 ta mahsulotga 100 kg dan = 900 kg ishlatilgan →
   **100 kg qayerga ketdi?** Texnolog bir yoki bir nechta sabab tanlaydi va miqdorni bo'ladi
   ("Qaynatishda" 80 kg, "To'kildi" 20 kg va h.k.). Limit nisbatda tekshiriladi.
3. **Tannarxga** ta'sir qiluvchi yo'qotish shu smenada chiqqan mahsulotlarga **ishlatilgan sut miqdoriga qarab** bo'linadi.
   Separatsiyada qaymoq tannarxi qat'iy (o'zgarmaydi), ulush yog'siz sutga tushadi.
4. Mahsulot keyingi bosqichga (quyish, idishga) o'tgan bo'lsa ham tannarx u orqali ko'tariladi — tizim partiyalar
   zanjirini (qaysi partiyadan nima chiqqan) saqlaydi. Smena yopilmaguncha mahsulot sotilmaydi.
5. Smena yopilmaguncha tannarx **taxminiy** (xira rangda) ko'rsatiladi, yopilgach **haqiqiy**.

### Xomashyo qo'shilgandan keyin — tortib yoziladi
Texnolog tayyor quymani (masalan "5% siyro") tarozida tortadi va yozadi — faqat limit ichida (yuqoridagi nisbatda).
Quyma tannarxi (texnologga ko'rinmaydi): **ishlatilgan sut + qaynatishdagi yo'qotishning shu mahsulotga ulushi +
xomashyolar**. Keyin topshiriqni yopib quyuvchiga o'tkazadi.

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

### Quyish → tayyor dona mahsulot
Quyuvchi hech narsani bittalab tanlamaydi: o'zidagi topshiriqni yoki mahsulotni tanlaydi, masalan "40 kg 5% siyrodan
100 ta **5% qatiq 400 g** chiqdi" — tarkib bo'yicha hammasi avtomatik yechiladi va 100 dona keyingi jarayonga yoki omborga kirim bo'ladi.

### Tannarx
Dona mahsulot tannarxi = quyma tannarxi (qaynatishdagi yo'qotish qo'shilgandan keyingi) × tarkibdagi miqdor (masalan 400 g)
+ idish + etiketka + quyuvchi haqi (masalan 170) + qopqoq yopuvchi haqi (masalan 90).
Keyin sozlamada boshqa xarajatlar (ijara, kommunal) qo'shilishi uchun joy qoldiriladi.

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
- Chek (80 mm printer): kompaniya nomi va logo, chek turi (**Sotuv** yoki **Qaytarish** + qaytarish turi, masalan
  "Toza" / "Muddati o'tgan"), raqam, sana va vaqt, sotuvchi, mijoz; mahsulotlar — nomi, miqdori, narxi, summasi;
  jami (sozlamaga ko'ra umumiy vazn/hajm), to'lov turi va to'langan summa, **mijozning oldingi qarzi va savdodan
  keyingi qarzi**, omborchi va mijoz imzosi uchun joy. Keyinchalik yangi maydonlar qo'shiladi.
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
  - Oklad har bir xodimga **qat'iy summa**; belgilangan sana kelganda tizim xodimni shu summaga haqdor qiladi.
  - Kelmagan kunlar hozircha qo'lda **jarima** sifatida ayriladi ("ishga kelmagan" + summa).
  - Keldi-ketdi nazorati (HR) keyingi versiyalarda.
- Balanslar va akt-sverka: mijoz, yetkazib beruvchi, xonadon, xodim, kassa.

## 9. Boshlang'ich ma'lumot
Server hozir bo'sh — haqiqiy ma'lumot hamma jarayon tugagach kiritiladi. Shuning uchun:
- **boshlang'ich balanslar**: mijoz, yetkazib beruvchi, xonadon, xodim, kassa;
- **boshlang'ich qoldiqlar** va **inventarizatsiya** (to'liq va qisman);
- hammasi bittalab ham, **Excel shablon orqali ommaviy** ham kiritiladi (avval tekshiruv natijasi ko'rsatiladi).
- **Inventarizatsiya kamomadi** har safar so'raladi: kompaniya hisobiga, bitta xodim hisobiga yoki **qisman kompaniya,
  qisman xodim(lar)** — summalar qo'lda bo'linadi. Buni summalarni ko'radigan rahbar hal qiladi; omborchi sanoqni
  qoralama qilib saqlaydi va farqlarni (summasiz) ko'radi.

### Zaxira va tozalash
Eski Yaya kabi: istalgan payt **tarixni tozalash**, **zaxiraga eksport** va **zaxiradan import**. Eski Yaya zaxira fayli
Yaya 2.0 ga ham tiklanadi (ombor qismi bo'sh holda; ma'lumotnomalar o'zi qayta yaratiladi).

## 10. Sozlamalar
Har bir bo'limning o'z sozlamalari bo'ladi, qiyin joylarda izoh bilan:

| Bo'lim | Sozlamalar |
|---|---|
| Umumiy | kompaniya, logo, o'lchov birliklari, ko'rinish (vazn/hajm cheklarda) |
| Ombor | omborlar va mas'ullar, manfiy qoldiq va ogohlantirish (har biriga alohida), hisobdan chiqarish sabablari |
| Ishlab chiqarish | tarkiblar, separatsiya, limitlar (nisbatda), bo'limlar bo'yicha yo'qotish sabablari va ta'siri, ishbay stavkalar, turish vaqtlari, topshiriq muddatlari |
| Qayta ishlash | qaysi mahsulotdan nima chiqadi, idish narxi, kg limitlari, xarajat nomi |
| Savdo | mijoz turlari, narxlar, qaytarish turlari → omborlar, muddati o'tgan siyosati, chek shabloni |
| Moliya | kassalar va mas'ullar, to'lov turlari, xarajat toifalari |
| Xodimlar | rollar, ruxsatlar, PIN, qurilmalar, oklad |
| Ogohlantirishlar | kimga, qaysi hodisada, qanday (hozircha ilova ichida: ovoz, push; Telegram keyinroq) |
| Sut yig'ish | mavjud sozlamalar |

## 11. Platformalar
Bitta server, bitta kod:
- **Ish joyi ilovasi** (hozirgi Expo ilova kengayadi): Android telefon/planshet, brauzer va **Desktop** (Windows ilova
  ichida shu web versiya + oflayn baza). Monoblokda katta tugmalar va xodim almashish rejimi.
- **Boshqaruv paneli** — brauzerda. Butun zanjir uchun bitta panel: yuqorida bo'limlar (Bosh panel · Sut yig'ish · Ishlab chiqarish ·
  Ombor · Hisobotlar · Boshqaruv), ostida tanlangan bo'lim sahifalari. "Bosh panel" — barcha bo'limlarning kunlik ko'rsatkichlari.
- Yig'ish (APK, Desktop o'rnatuvchi) **eng oxirida** — hammasi avval ichki brauzerda sinaladi.

## 12. Bosqichlar
| # | Bosqich | Holat |
|---|---|---|
| 1 | **Ombor asosi:** nomenklatura (vazn, hajm, shakl, muddatlar), omborlar va mas'ullar, manfiy qoldiq sozlamasi, partiyalar va FIFO, topshirish-qabul, hisobdan chiqarish (xodim hisobiga ham), boshlang'ich qoldiq, inventarizatsiya, Excel import; qabul qilingan yog'li + yog'siz sut → bitta "Xom sut" (smena o'rtacha tannarxi); kamomadni taqsimlash; eski zaxira mosligi; panelda "Ombor" bo'limi, ilovada "Ombor" tabi | ✅ |
| 2 | **Ishlab chiqarish:** tarkiblar va alternativlar, texnolog smenasi va sut sarfi, qaynatishdagi yo'qotishni (va yutishni) taqsimlash — keyingi bosqichga o'tgan partiyalarga ham, separatsiya (qat'iy / foiz / qolgan), nisbatdagi limitlar, bo'lim sabablari va ta'siri, rahbar tasdig'i, taxminiy va haqiqiy tannarx; panelda umumiy "Bosh panel" va bo'limlar bo'yicha guruhlangan menyu | ✅ (shartli limit — "shu xomashyolar bo'lsa X–Y" — keyinroq) |
| 3 | **Quyish zanjiri:** quyish va qopqoq yopish tarkiblari (1 dona uchun), ishbay haq (ko'p xodimga teng bo'linadi, bekor qilinsa qaytadi), mahsulotni keyingi joyga (issiqxona, tayyor ombor) topshirish, issiqxonada turish vaqti va kechikkan topshiriq ogohlantirishlari (xodim ismi bilan, ilovada ovozli banner); idish berish/qaytarish va ortgan quyma — oddiy topshirish orqali; Quyuvchi va Qopqoq yopuvchi rollari | ✅ (telefonga push — yig'ishda) |
| 4 | **Savdo:** mijozlar va turlari, narxlar (umumiy / mijoz turi / mijoz), FIFO sotuv (tushum va tannarx), sotuvchining o'z kassasi, qisman to'lov va qarz, 80 mm chek (oldingi va keyingi qarz bilan), qaytarish turlari → omborlar, qaytgan tannarx (oxirgi partiya / o'rtacha N kun), muddati o'tgan siyosati, mijozdan to'lov, akt-sverka, bekor qilish; Sotuvchi roli | ✅ (Android printer — yig'ishda) |
| 5 | **Qayta ishlash** (6-bo'lim): "Qayta ishlash" tarkibi 1 dona uchun — chiqadigan mahsulotlar (1 donadan miqdor yoki netto vazndan, chegara, qat'iy tannarx yoki 0, idish belgisi); qolgan tannarx "Qayta ishlashda yo'qotilgan tannarx" xarajatiga; chiqmagan idish uchun "N ta chiqishi kerak edi..." savoli va sabablar (singan / yo'qolgan, aralash) → idish yo'qotilishi xarajati; chegaradan tashqari — rahbar tasdig'i; Qayta ishlovchi roli | ✅ |
| 6 | **Moliya va oylik:** kassalar va ularning hisob varag'i, xarajat va boshqa kirim (moddalar bilan), kassadan kassaga o'tkazma (sotuvchi o'z kassasini asosiy kassaga topshiradi), kassa boshlang'ich qoldig'i; yetkazib beruvchilar — xarid (kirim omborga), to'lov, akt-sverka; oylik — har oy belgilangan kuni avtomatik oklad (o'tgan oylar uchun emas), bonus, jarima (sabab bilan), xodimga to'lov, boshlang'ich balans, hisob varag'i; foyda-zarar hisoboti; umumiy balanslar (kim kimga qarz) | ✅ (xonadon to'lovlarini kassaga bog'lash — keyin) |
| 7 | **Ish joyi ilovasi:** monoblok rejimi, PIN bilan almashish, topshiriqlar ro'yxati, ogohlantirishlar (ovoz, push) | |
| 8 | **Hisobotlar va dashboardlar** | |
| 9 | Sinov, tuzatish, so'ng Android va Desktop yig'ish | |

Har bir bosqich serverda testlar bilan yoziladi va panel/ilovada sinab ko'riladigan holga keltiriladi.

## 13. Hal qilingan savollar
1. **Oklad:** har bir xodimga qat'iy summa; belgilangan sanada haqdor bo'ladi; kelmagan kun — qo'lda jarima (8-bo'lim).
2. **Ogohlantirishlar:** hozircha ilova ichida; Telegram bot/guruh keyin, kerak bo'lsa.
3. **Inventarizatsiya kamomadi:** har safar so'raladi — kompaniya, xodim yoki qisman ikkalasi (9-bo'lim). Serverda tayyor.
4. **Chek:** 7-bo'limdagi ro'yxat; keyin maydonlar qo'shiladi.
