# Yaya 2.0 — oʻzgarishlar tarixi

Eng yangisi tepada. Qavs ichida Android `versionCode`.

## Yaya 2.0 — Reja, asosiy xomashyo, yangi smena yakuni (10-bosqich, 3-qism), 2026-11-27
- **Reja** va **Reja hisoboti**; texnologga "Bugungi rejalar" (quyma kg), quyuvchiga mahsulot bo'yicha reja soni.
- Tarkib: asosiy xomashyo tavsiyasi va nisbatdagi tavsiyalar (xira), boshqa xomashyo qo'shish; quyishda quyma bosqichdagidan ko'p emas.
- **Asosiy xomashyo** turi; "Sut ombori", "Yog'li sut"; "Xom sut (ombor)" turi olib tashlandi.
- **Separatsiya** alohida qadam; **qabul qilingan sut** yig'uvchi smenalaridan tanlanadi; yo'qotish to'liq kiritiladi;
  sut tanlangan smenalar tannarxida, yo'qotish asosiy xomashyo qiymati ulushiga ko'ra.
- Oflayn yozuvlar ro'yxati, qayta sinxronlash, bekor qilish; monoblok klaviaturasi sozlamasi. 73 ta test.

## Yaya 2.0 — Tex karta (10-bosqich, 2-qism), 2026-11-26
- Ishlab chiqarish xaritasi → **Tex karta**, faqat tayyor mahsulot uchun: "Ishlab chiqarish"da quyma mahsuloti (quyma
  tarkibi), "Quyish"/"Qadoqlash"da tarkib tanlanadi; bir quymadan bir nechta tayyor mahsulot.
- Umumiy quyish / qadoqlash tarkiblari (mahsulotni Tex karta bog'laydi). Quyuvchi quyma bo'yicha mahsulotni tanlaydi.
- Ishlab chiqarish bosqichida ishbay haq va "kim bilan" yo'q; ishbay faqat quyish, qadoqlash, qopqoq yopishda.
- Mahsulot belgilari: "Sotuv uchun mavjud", "Xomashyo".
- Reja (buyurtma asosida) — keyingi bosqichga. 72 ta avtomatik test.

## Yaya 2.0 — bosqichlar va ishlab chiqarish xaritasi (10-bosqich, 1-qism), 2026-11-25
- **Bosqichlar:** 10 ta bosqich ombor sifatida (o'zgaradigan / o'zgarmas, ishbay haq, mas'ullar, tartib); har bir
  mahsulotning ishlab chiqarish xaritasi; bosqichlar jurnali. Har bir amal oldingi bosqichdan oladi.
- **Haqiqiy tannarx:** manfiy qoldiqdan olingan mahsulot keyin kelgan mahsulot bilan haqiqiy tannarxda yopiladi (butun zanjir FIFO).
- **Texnolog:** sut Xom sut omboridan to'g'ridan-to'g'ri; separatsiya smena oxirida (yog'siz sutni oldindan ishlatish mumkin).
- **"Mening qo'limda" yo'q:** eski qoldiqlar bosqichlarga o'tdi; xodimga topshirish yo'q.
- **Variantli mahsulotlar** ("Zakvaska / 499"), Excel importda ham; Mahsulotlar sahifasida import tugmasi.
- **Laboratoriya** butunlay olib tashlandi. **Issiqxona taymeri** olib tashlandi. **Qopqoq yopish** — faqat miqdor.
- **"Bu ishni kim bilan qildingiz?"** — o'zi belgilangan; ish haqi teng bo'linadi.
- **Monoblok:** "Monoblokdan foydalanadi" belgisi, takrorlanmas PIN, katta raqam tugmalari.
- 70 ta avtomatik test (butun zanjir bosqichlar bilan qayta yozildi).

## Yaya 2.0 — omborgacha fokus, 2026-11-22
- Sotuv, qaytarish, mijozlar, narxlar, savdo sozlamalari, "Sotuvchi" roli, savdo hisobotlari va sotuv grafigi olib
  tashlandi (panel, ilova, server). 11–12-bosqichlarda distributsiya bilan yangi uslubda qaytadi.
- Bazadagi eski savdo ma'lumotlari saqlanib qoldi. Sotuvchilar tizimga kira olmaydi, bo'sh kassalari yopildi.
- Kassalar va to'lov turlarini boshqarish — **Moliya → Kassalar**ga ko'chdi.
- Muddati o'tgan mahsulot qayta ishlashga oddiy topshirish orqali boradi (tayyor ombor → "Muddati o'tganlar" → qayta ishlovchi).
- Bosh panel: "Savdo" bloki o'rniga sut va ishlab chiqarishga ketgan sut grafiklari; Balanslar'da mijozlar yo'q.
- 69 ta avtomatik test.

## Yaya 2.0 — butun zanjir (ERP), 2026-11-18 — 2026-11-21
Server va panel; mobil ilova brauzer versiyasida (`/app/`) sinalgan, APK hali yig'ilmagan. Batafsil: docs/ERP_PLAN.md.
- **Ombor:** omborlar va mas'ullar, partiyalar va FIFO, topshirish → qabul, hisobdan chiqarish (xodim hisobiga ham),
  inventarizatsiya (kamomad kim hisobiga — so'raladi), boshlang'ich qoldiq va Excel import; yig'uvchilar suti → bitta "Xom sut".
- **Ishlab chiqarish:** tarkiblar va alternativlar, texnolog smenasi, qaynatishdagi yo'qotishni tannarxga taqsimlash,
  separatsiya, nisbatdagi limitlar va **shartli limitlar** ("shu xomashyo ishlatilsa — X–Y kg") va rahbar tasdig'i; quyish va qopqoq (ishbay haq bo'linishi), issiqxona turish vaqti va
  kechikish ogohlantirishlari; muddati o'tganlarni qayta ishlash.
- **Savdo:** mijozlar, narxlar, sotuv, 80 mm chek, qaytarish turlari, qaytgan tannarx, muddati o'tgan siyosati, to'lovlar.
- **Moliya:** kassalar, xarajat va kirim, o'tkazmalar, yetkazib beruvchilar va xarid, oylik (avtomatik oklad, bonus,
  jarima, to'lov), foyda-zarar; xonadonlarga to'lov kassadan chiqadi (panelda kassa tanlanadi, yig'uvchi to'lasa —
  uning o'z kassasidan; bekor qilinsa pul qaytadi); **kassa nazorati** — kassani sanash (ortiqcha — kirim, kamomad —
  kim hisobiga, so'raladi); **Balanslar** sahifasi — kassalar, mijozlar, xonadonlar, yetkazib beruvchilar, xodimlar.
- **Ish joyi:** monoblok (PIN bilan almashish), internetsiz navbat.
- **Hisobotlar:** savdo, ishlab chiqarish, ombor harakati, yo'qotishlar, muddatlar, xodimlar; Excel; Bosh panel grafiklari.
- **Panel:** bo'limlar bo'yicha guruhlangan menyu va "Bosh panel".
- Panelda sahifani yangilaganda (masalan #pnl) bosh sahifaga qaytib ketish tuzatildi.
- 71 ta avtomatik test, jumladan butun zanjir va buxgalteriya muvozanati, xodimlarga summa sizmasligi, zaxira/tiklash.

## Yaya 2.0 — mustaqil nusxa (2026-11-16)
- Loyiha asl Yaya'dan ajratildi: oʻz reposi (`abdullayev7052-bot/Yaya_2_0`), oʻz serveri
  (https://yaya2-production.up.railway.app, Railway, Yevropa hududi) va oʻz bazasi.
- Ilova nomi "Yaya 2.0", paketi `uz.yaya2.collector` (Android va iOS) — asl Yaya ilovasini almashtirmaydi,
  telefonda uning yonida alohida oʻrnatiladi.
- Ilovaning standart serveri va APK yigʻishda logo olinadigan manzil yangi serverga oʻtkazildi.
- Mobil versiya 2.9.3 (20) oʻzgarmadi.

## 2.9.3 (20) — 2026-11-11
- Aloqa uzilib qolgan soʻrovlar avtomatik qayta yuboriladi (2 marta: 0,7 va 1,4 soniyadan keyin).
  Faqat xavfsiz takrorlanadigan soʻrovlar: barcha oʻqishlar va sinxron (takror yuborish ikki marta yozmaydi).
  Server aniq rad javobi bergan boʻlsa, qayta urinilmaydi.
- Natija: aloqa yomon joyda xonadonlar roʻyxati boʻshab qolmaydi, yopilgan smena ofisga tezroq yetadi.
- Server kodi oʻzgarmadi.

## 2.9.2 (19) — 2026-10-24
- Tuzatish: paneldagi kompaniya logosi APK ikonkasi sifatida ishlatilmayotgan edi. Endi yigʻish paytida logo
  ilova ikonkasi, adaptiv ikonka, kirish ekrani logosi va favicon oʻrniga yoziladi.
- Paneldagi logo oʻzgarsa, keyingi yigʻishda oʻzi olinadi — kod oʻzgartirish shart emas.

## 2.9.1 (18) — 2026-10-24
- **Sinxron xatolari ekrani:** qizil "qabul qilinmadi" satri bosilganda server rad etgan har bir yozuv
  koʻrinadi (qaysi xonadon/smena/toʻlov, miqdor, vaqt, aniq sabab). Bittalab yoki hammasini bekor qilish
  yoki qayta yuborish mumkin.
- **Xonadonlar roʻyxati himoyasi:** uzilib qolgan yoki chala server javobi endi xato hisoblanadi va oxirgi
  toʻgʻri roʻyxat saqlanadi (avval roʻyxat va ruxsatlar vaqtincha yoʻqolib qolardi). Boʻsh roʻyxatda
  "yangilash" tugmasi bor.
- **Laboratoriya:** "Bor/Yoʻq" turidagi koʻrsatkichda "Bor" tanlansa, kg kiritiladi; limitdan oshsa
  "Normada emas" chiqadi va hisobot admin koʻrigi uchun belgilanadi. Limit panelda har bir koʻrsatkich
  uchun sozlanadi.

## 2.8.3 (17) — 2026-10-23
- Ilova ikonkasi va kirish ekrani logosi tozalandi.
- "Kun" boʻlimida real/nominal tannarx tugmasi ixchamlashtirildi.
- Panel: Integratsiya va Sozlamalar sahifalaridagi ortiqcha izoh matnlari olib tashlandi.

## 2.8.2 (16) — 2026-10-23
- Pastki boʻlimlar paneli siqilmaydi: boʻlim kam boʻlsa kenglikni toʻldiradi, koʻp boʻlsa suriladi.
- Laboratoriya tafsilotida maʼlumotni kim va qachon kiritgani (va kim koʻrib chiqqani) koʻrinadi.
- Kirish ekranida video oʻynalmaydi — faqat logo koʻrsatiladi (Android'da video ustidan "panjara" chiqib
  qolardi).
- Ilovadagi ortiqcha matnlar qisqartirildi.
- Backup boti: "Hozir yuborish" har bir manzil (Admin / Kanal) natijasini Telegram xatosi bilan alohida
  koʻrsatadi.

## 2.8.1 (15) — 2026-10-23
- Yangi ruxsat **"oʻz toʻlovlarini koʻrish"** (`payments.view_own`): sut yigʻuvchi faqat oʻzi kiritgan
  toʻlovlarni koʻradi, boshqa xonadonlar qarzini va kompaniya balanslarini koʻrmaydi.
- Ilovada "Toʻlovlarim" boʻlimi: kun yoki oraliq boʻyicha, nusxalash bilan.

## 2.8.0 (14) — 2026-10-22
- **Xaridlar** (panel): qabul qilingan smenadagi har bir xonadon tashrifi raqamlangan xarid
  (`24-2` — 24-smenadagi 2-xonadon). Smenadagi qabul farqi alohida yakuniy qator. Filtrlar: sana, sut
  yigʻuvchi, xonadon, smena; CSV eksport; mahsulot boʻyicha tafsilot.
- **Toʻlov raqamlari:** har bir toʻlov doimiy tartib raqamiga ega (`#36`).
- **Integratsiya** (panel) — ikkita Telegram bot, tokeni panelda kiritiladi:
  - *Xonadon boti:* telefon raqami orqali roʻyxatdan oʻtish (tizimda yoʻq raqam oʻta olmaydi); xarid,
    toʻlov, bekor qilingan toʻlov va balans tahriri haqida xabar; Xaridlar / Toʻlovlar / Balans / Profil
    tugmalari; xabar turlari va maydonlari sozlanadi.
  - *Backup boti:* har kuni belgilangan vaqtda AES-256 shifrlangan zaxira Admin ID va ixtiyoriy kanalga
    yuboriladi; faqat koʻrsatilgan admin foydalana oladi.
- Ilova: bir kunlik toʻlovlarni nusxalash (jami va har xonadon summasi).
- Yangi ruxsat `collect.detail_own`: sut yigʻuvchi oʻzining qabul qilingan smenasi tafsilotini ochadi va
  nusxalaydi (narxlar ruxsat boʻlmasa yashirin).

## v2.8 server — 2026-10-20
- **Laboratoriya** boʻlimi: qabul qilingan smenalar uchun sifat koʻrsatkichlari, limitlar,
  qizil/sariq/yashil holatlar. Laborant faqat smena raqami, sut yigʻuvchi va jami kg ni koʻradi — narx va
  xonadonlarni koʻrmaydi. Yangi "Laborant" roli va `lab.*` ruxsatlari.
- Boʻsh joy tuzatildi (smena yorliqlari ostida).
- Balansi 0 boʻlgan oʻchirilgan xonadonni tarixi bilan butunlay oʻchirish.
- Smena yopilishi bilan qabul qiluvchilarga darhol koʻrinadi.

## Undan oldin
2.7 va undan oldingi versiyalar bu faylda yozilmagan. Qisqacha tarix: [PLAN.md](PLAN.md) dagi bosqichlar
jadvali va `git log`.
