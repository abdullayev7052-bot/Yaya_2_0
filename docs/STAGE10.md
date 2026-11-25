# 10-bosqich — omborgacha jarayonni qayta qurish: talablar ro'yxati

Holat: **birinchi qism qurildi** (2026-11-25): pastdagi 1–9-bo'limlar ishlaydi (server, panel, ilova, 70 ta test).
Rahbar keyingi o'zgarishlarni aytadi (reja / buyurtma bo'yicha topshiriqlar, yaroqli qayta ishlash va boshqalar).

**Nima qurildi (qisqacha):**
- Laboratoriya butunlay olib tashlandi (kod, rol, ruxsatlar, ma'lumot); eski zaxiralar avvalgidek tiklanadi.
- Variantli mahsulotlar (yaratishda; "Zakvaska / 499"), Excel importda "Variantlar" ustuni, Mahsulotlar sahifasida import tugmasi.
- 10 ta bosqich (ombor sifatida), tartibi, turi (o'zgaradigan / o'zgarmas), ishbay haq, mas'ullar; **Ishlab chiqarish →
  Bosqichlar va xarita** sahifasida har bir mahsulot xaritasi (katakchalar) va bosqichlar jurnali.
- Har bir amal oldingi bosqichdan oladi; ko'p kiritilsa oldingi bosqich manfiyga tushadi va ogohlantiradi; keyin kelgan
  mahsulot uni **haqiqiy tannarxda** yopadi (yopilmagan farq yo'q — butun zanjir FIFO).
- "Mening qo'limda" yo'q: eski qoldiqlar rolga mos bosqichga o'tdi; xodimga topshirish yo'q.
- Texnolog: sut to'g'ridan-to'g'ri Xom sut omboridan; smena birinchi topshiriqda o'zi ochiladi; tepada sarflangan sut va
  separatsiya; smena oxirida o'lchab qolgan sut + separatsiya (qaymoq chiqdi, yog'siz sut qoldi) — 9-bo'lim bo'yicha.
- Quyuvchi idishni o'zi olmaydi — idish ombori mas'uli sifatida tarkib bo'yicha avtomatik ayriladi.
- Issiqxona soat taymeri olib tashlandi; qopqoq yopish — o'zgarmas bosqich, faqat miqdor, ishbay haq bosqichda.
- "Bu ishni kim bilan qildingiz?" — o'zi belgilangan, boshqalarni qo'shadi; ish haqi teng bo'linadi.
- Monoblok: "Monoblokdan foydalanadi" belgisi, takrorlanmas PIN, burchakda katta raqam tugmalari.

## 1. Mahsulotlar
1.1. **Mahsulotlarni Excel'dan import** qilish (hozir faqat boshlang'ich qoldiq importi bor — mahsulotlar ro'yxati
     ham to'liq import bo'lsin).

1.2. **Variantli xomashyo.** Ba'zi xomashyolar variantli: masalan "Zakvaska" → variantlari 499, 505 va h.k.
- Har bir variant — aslida alohida mahsulot, **o'z tannarxi** bilan (qoldiq, partiya, FIFO alohida).
- Xomashyo yaratishda "variantli" belgilansa, pastda variant qiymatlari (499, 505...) kiritiladigan joy ochiladi.
- Hisobotlarda, "nima ishlatildi" joylarida va xaridda nomi **"Zakvaska / 499"** ko'rinishida chiqadi.
- **Texnolog** ishlatishda avval "Zakvaska"ni bosadi, keyin **mavjud** variantini tanlaydi.

## 2. Laboratoriya — hozircha o'chiriladi
- Laboratoriya bo'limi, **Laborant** roli va laboratoriyaga bog'liq barcha ruxsatlar olib tashlanadi.

## 3. Monoblok
3.1. Xodim yaratishda yangi belgi: **"Monoblokdan foydalanadi"**. Belgilanmagan bo'lsa — PIN umuman so'ralmaydi va u
     monoblok ro'yxatida ko'rinmaydi; bunday xodim **faqat mobil ilovada** ishlaydi.
3.2. Monoblokda **ikki xodimning PIN'i bir xil bo'lishi mumkin emas** (har biri boshqalardan farqli).
3.3. Monoblok rejimida PIN terish uchun ekranning bir burchagida **katta-katta raqam tugmalari** chiqadi (boshqa
     amallarga xalaqit bermaydigan joyda).

## 4. "Mening qo'limda" o'rniga — omborlar rejimi
4.1. "Mening qo'limda" (xodim qo'lidagi qoldiq) degan butun tushuncha **olib tashlanadi**. Hamma narsa omborlarda turadi.
4.2. Omborga **bir nechta mas'ul** tanlanishi mumkin; tanlangan har bir mas'ul shu ombordagi **barcha amallarni**
     bajara oladi.
4.3. Misol — **Xom sut ombori**ga Texnolog mas'ul:
- kirim qila oladi — sut yig'uvchining sutini qabul qiladi;
- chiqim qila oladi — ishlab chiqarishda ishlatadi;
- tayyor quymani **"Quyuvchi" omboriga** o'tkazadi;
- Xomashyo omboriga ham mas'ul bo'lgani uchun xomashyoni ishlab chiqarishda bevosita ishlata oladi.
4.4. **"Quyuvchi" ombori** mas'ullari **avtomatik topshiriq** oladi: quymaning miqdorini tekshirib qabul qiladi, u
     ularga (ularning omboriga) o'tadi — zanjir shunday davom etadi.
4.5. Sut yig'uvchining suti qabul qilingach, u **Xom sut omboriga** tushadi va shu ombor mas'ullari (texnolog) uni
     ishlab chiqarishda **darhol** ishlata oladi (alohida topshirish kerak emas).
4.6. **Idish omborchisi** lavozimi va funksiyalari olib tashlanadi. Quyuvchilar idish omboriga mas'ul bo'lgani uchun
     undan erkin foydalanadi: tarkib bo'yicha quyganda idish **avtomatik** idish omboridan ayriladi.

## 5. Issiqxona va sovuqxona
5.1. Issiqxonadagi **soatlik turish rejimi** (dwell vaqti va ogohlantirishlari) hozircha o'chiriladi — keyin qaytishi mumkin.
5.2. **Issiqxona** — oddiy ombor: idishga quyilgan, lekin qopqog'i hali yopilmagan mahsulot turadi.
5.3. Issiqxonadan keyin → **Sovuqxona** (ombor) → keyin **Qopqoq yopish**.
5.4. **Qopqoq yopish** — tarkibsiz: idish, xomashyo ishlatilmaydi, limit yo'q. Xodim sovuqxonadagi mahsulotdan
     bir nechtasi yoki hammasi uchun "qopqog'ini yopdim" deb **miqdor kiritadi** va tugmani bosadi. Qopqog'i yopilgan
     mahsulot **sotuvga tayyor**. Ombordagidan ko'p kiritilsa — ombor **manfiyga** tushadi va adminga ogohlantirish boradi.

## 6. Mahsulot ishlab chiqarish xaritasi (yangi bo'lim)
Har bir mahsulot ishlab chiqarilguncha bir nechta bosqichdan o'tadi va mahsulotdan mahsulotga farq qiladi:
- ba'zilari issiqxonaga kirmaydi — quyilishi bilan sovuqxonaga ketadi;
- ba'zilarida quyish yo'q — faqat qopqoq yopiladi;
- ba'zilarida qopqoq yopishda xomashyo sarflanadi;
- ba'zilarini texnolog katta paqirlarga quyadi (quyuvchi xarajati yo'q) va ular sovuqxonaga ketadi.

Shuning uchun **har bir mahsulotda "Ishlab chiqarish xaritasi"** bo'ladi. Bosqichlar:

| # | Bosqich | Mazmuni |
|---|---|---|
| 1 | **Ishlab chiqarish** | texnolog sut va xomashyodan tayyorlaydi: quyma mahsuloti qaysi, qaysi tarkiblar amal qiladi, kimlar foydalanadi |
| 2 | **Quyish** | qaysi tarkiblar amal qiladi, kimlar foydalanadi |
| 3 | **Qadoqlash** | qaysi tarkiblar amal qiladi, kimlar foydalanadi |
| 4 | **Issiqxona** | ombor |
| 5 | **Sovuqxona** | ombor |
| 6 | **Qopqoq yopish** | tarkibsiz, faqat miqdor; ko'p kiritilsa manfiy + adminga ogohlantirish |
| 7 | **Tayyor mahsulot ombori** | faqat shu yerdagi mahsulot sotuvga, vozvrat omboriga o'tkazishga yoki agent orqali chiqarishga tayyor (agent rejimi — keyin) |
| 8 | **Vozvrat ombori** | faqat sotuvdan qaytgan yoki tayyor mahsulot omboridan transfer qilingan mahsulot tushadi; qayta ishlash shu ombordan bo'ladi |
| 9 | **Yaroqli qayta ishlash** | yangi funksiya — keyin tushuntiriladi |
| 10 | **Yaroqsiz qayta ishlash** | hozirgi "Qayta ishlash" — faqat nomi o'zgaradi |

- Har bir bosqichni mahsulotda **yoqish yoki o'chirish** mumkin. O'chiq bosqichdan mahsulot o'tmaydi — keyingi
  yoqilgan bosqichga sakrab o'tadi.
- Maqsad: keyinchalik hisobotlarda va real vaqtli dashboardlarda **har bir mahsulot ayni damda qaysi bosqichda**
  ekanini ko'rish.

## 7. Bosqichlar — ombor sifatida (javoblar, 2026-11-25)
7.1. **Har bir bosqichning o'z ombori bor**, lekin u "ombor" emas, **"Bosqich"** deb nomlanadi. U **Omborlar bo'limida**
     ombor sifatida ochiladi (masalan "Quyish" bosqichi, "Issiqxona" bosqichi). "Mening qo'limda"dagi qoldiqlar
     tegishli bosqichga o'tadi.
7.2. Har bir bosqichga **mas'ul shaxslar** tanlanadi. Ular shu bosqichdagi topshiriqni boshqaradi:
     oldingi bosqichdan **qabul qiladi** → **miqdor kiritadi** (tarkib bo'yicha) → **kimlar qatnashganini** tanlaydi →
     **yopadi** → **keyingi bosqichga o'tkazadi**.
7.3. Har bir amal **jurnalga** yoziladi: nima qilindi va **qaysi profildan**.
7.4. **Ishbay haq — "Bu ishni kim bilan qildingiz?"**: amalni bajarayotgan profil egasi **avtomatik belgilangan**
     bo'ladi; xohlasa o'zini olib tashlaydi, xohlasa yana bir nechta xodimni qo'shadi. Ish haqi **aynan tanlangan
     xodimlarga** yoziladi (tarkibdagi stavka bo'yicha, teng bo'linadi — hozirgidek).
7.5. **Qadoqlash** — quyishga o'xshash amal: tarkib tanlanadi, tarkib bo'yicha xodimga ish haqi yoziladi. Faqat bir-ikki
     mahsulotda yoqiladi. Odatda bunday mahsulotlarda **Ishlab chiqarish bosqichi o'chiq**: kg lik mahsulot tashqaridan
     **xarid qilinadi** (omborga kirim) → faqat **Qadoqlash**dan o'tadi → **Tayyor mahsulot ombori**ga tushadi.

## 8. Javoblar (2026-11-25, ikkinchi qism)

### 8.1. Variantli mahsulotlar
- Mahsulot **yaratilayotganda** "variantlimi?" so'raladi; keyin **o'zgartirib bo'lmaydi**.
- Har bir variantning tannarxi **alohida yoki bir xil** bo'lishi mumkin (har biri o'z partiyalari bilan yuradi).
- Variantlar **o'lchov birligini** (va yaroqlilik muddatini) asosiy mahsulotdan oladi — faqat **nomi va tannarxi**
  farq qiladi. Vazni yo'q (odatda donali emas).
- **Xaridda** (yetkazib beruvchidan) variantlar **alohida mahsulot** sifatida kiritiladi ("Zakvaska / 499").
- **Texnolog** xomashyo tanlaganda **ichma-ich oyna**: avval "Zakvaska" → oyna ochiladi → 499, 505...

### 8.2. Bosqich turlari: "O'zgaradigan" va "O'zgarmas"
Bosqich ochishda yoki tahrirlashda turi tanlanadi:
- **O'zgaradigan** — mahsulot jismi o'zgaradi: masalan kg li yarim tayyor "Quyma 5%" → donali "5% 400 g qatiq".
  Tarkib bor: bir nechta xomashyo (idish, etiketka va h.k.) va **ish haqi**; **limit va chegaralar** bor.
- **O'zgarmas** — mahsulot jismi o'zgarmaydi: xodim oldingi bosqichda turgan mahsulotdan ma'lum miqdorni kiritadi.
  - **Ishbay haq** so'raladi (masalan qopqoq yopish — kiritilgan stavka yoziladi) yoki **yo'q** (issiqxona, sovuqxona).
  - Oxirida "Bu ishni kim bilan qildingiz?" (odatda qopqoqni ilovada amalni bajarayotgan xodimning o'zi yopadi).
  - Miqdor **kam** kiritilsa — qolgani oldingi bosqichda qoladi; **ko'p** kiritilsa — oldingi bosqich (ombor)
    **manfiyga** ketadi (va adminga ogohlantirish — 5.4).
- Bosqichlar tartibi: yangi bosqichni **qaysi bosqichlar orasiga** qo'yishni **qo'lda surib** belgilash mumkin.

### 8.3. Laboratoriya
- Laboratoriya **butunlay** o'chiriladi: kod, ekranlar, ruxsatlar, rol **va bazadagi barcha yozuvlar** — go'yo hech
  qachon bo'lmagandek. **Alohida zaxira olinmaydi** (Yaya 1.0 da ham ishlatilmayapti). Laborant rejimi kelajakda —
  balki yig'ishdan (build) oldin — yangi tartibda mukammal qayta quriladi.
- **Zaxira mosligi saqlanadi:** eski zaxira fayllari (jumladan **Yaya 1.0** dan) avvalgidek tiklanadi — xonadonlar,
  qarzlar va to'lovlar tarixi, balanslar, qarzdorliklar, sut yig'uvchilar, xonadonlarning sut narxlari, smenalar,
  xaridlar tarixi va boshqa hamma narsa. Fayldagi laboratoriya ma'lumotlari tiklashda shunchaki **e'tiborga olinmaydi**.

### 8.4. Tarkiblar va xarita
- Bosqich ochishda yoki tahrirlashda **shu bosqichda qaysi tarkiblar amal qilishi** belgilanadi; amal bajarilayotganda
  ro'yxatda **faqat o'sha tarkiblar** chiqadi.
- **Bitta mahsulotga bitta tarkib** — xodim tarkib tanlab ovora bo'lmaydi: oldingi bosqichdan o'tgan mahsulotni
  belgilaydi va ishlab ketaveradi.
- Keyinchalik **reja** (buyurtmaga bog'liq) bo'yicha topshiriqlar — rahbar keyingi o'zgarishlarda aytadi.

### 8.5. Separatsiya
- Texnolog tomonda; **texnolog ekranida tepada alohida ajralib** turadi (u uchun juda muhim).
- Texnolog xom sut miqdorini va chiqqan **yog'siz sut** va **qaymoq** miqdorini kiritadi — yangi quyma ishlab
  chiqarishga o'xshaydi; ko'pincha barcha mahsulotlardan keyin bajariladi.
- Chiqqan qaymoq ham, yog'siz sut ham **xomashyo** sifatida **Xomashyo omboriga** qo'shiladi.
- Texnolog **smenadagi umumiy sut sarfini** ekranning tepasida doim ko'rib turadi.
- Muammo: texnolog quymalarni tarozida o'lchaydi, **qaymoqni biladi**, lekin separatsiyaga ketgan sutni va chiqqan
  yog'siz sutni darhol aniq bilmaydi — smena davomida turli miqdorda separatsiya qilib, qaymoq va yog'siz sutni darrov
  xomashyo sifatida ishlatib yuboradi; aniq miqdor smena oxirida ma'lum bo'ladi. Yechim — 9-bo'lim (taklif).

### 8.6. Qaytgan mahsulot
- "Toza" qaytgan → **Tayyor mahsulot ombori**; "Vozvrat" → **Vozvrat ombori**. Qaytarish turlari keyingi versiyalarda.
- Hozirgi asosiy maqsad: **omborga kirguncha** barcha jarayonlarni optimallashtirish — **real tannarxni buzmasdan**
  hisoblash, **xodimlar ish haqini to'g'ri** hisoblash, omborlar va bosqichlarni **real vaqtda** to'g'ri nazorat qilish.

## 9. Separatsiya: yog'siz sut va qaymoqni "oldindan ishlatish" — ✅ ma'qullandi (2026-11-25)
**Rahbar sharti:** tizimda **taxminiy narx qolib ketmasin**. Manfiy yopilganda albatta **haqiqiy tannarx** yuklatiladi —
aynan shu smenada qabul qilingan xom sut, yo'qotishlar, qaymoqning qat'iy tannarxi va hamma narsa hisobga olinadi.
**Butun tizim** (faqat separatsiya emas, butun zanjir) **FIFO** rejimida ishlaydi.

Maqsad — texnolog smena davomida bemalol ishlatsin, tannarx esa oxirida aniq va to'g'ri bo'lsin, moliya qoidalari
buzilmasin (hech bir xarajat yo'qolmaydi yoki ikki marta yozilmaydi).

1. **Smena davomida.** Yog'siz sut va qaymoq (separatsiya mahsulotlari) Xomashyo omborida **shu smena ichida vaqtincha
   manfiyga** tushishi mumkin. Texnolog ularni boshqa tarkiblarda ishlataveradi; sarf **taxminiy tannarxda** yoziladi
   (oxirgi separatsiyadagi 1 kg tannarxi; birinchi marta — tarkibdagi rejaviy tannarx). Ekranda tepada: "Yog'siz sut:
   −85 kg (smena yakunida aniqlanadi)".
2. **Qaymoq** — texnolog bilgani uchun, qaymoqni chiqqan zahoti kiritishi mumkin (yoki oxirida).
3. **Smena oxirida — "Separatsiya yakuni"**. Texnolog faqat bilganini kiritadi:
   - chiqqan **qaymoq** (agar avval kiritilmagan bo'lsa);
   - **qolgan yog'siz sut** (ishlatilmay qolgani; bo'lmasa 0).
   Tizim qolganini o'zi hisoblaydi:
   - **chiqqan yog'siz sut** = smenada ishlatilgani + qolgani;
   - **separatsiyaga ketgan sut** = smenada olingan sut − boshqa topshiriqlarda ishlatilgan sut − qaytarilgan sut −
     yo'qotishlar (hozirgi smena yopishdagi sut hisobi bilan bir xil).
   Agar separatsiyaga ketgan sut yoki yog'siz sut tarkibdagi nisbatdan (limit) chiqib ketsa — rahbar tasdig'iga boradi.
4. **Hujjat va tannarx.** Yakunda bitta "Separatsiya" hujjati yoziladi: sut chiqimi → qaymoq va yog'siz sut kirimi
   **haqiqiy tannarxda** (hozirgi qoida: qaymoq qat'iy / foiz, yog'siz sut — qolgan tannarx). Bu kirim manfiyni yopadi.
5. **Farqni to'g'rilash.** Taxminiy va haqiqiy tannarx orasidagi farq **yog'siz sut ishlatilgan partiyalarga qayta
   taqsimlanadi** (hozir qaynatishdagi yo'qotishni taqsimlashda ishlatilayotgan mexanizm — partiya manbalari orqali,
   keyingi bosqichga o'tgan partiyalarga ham). Mahsulot sotilib yoki hisobdan chiqib bo'lgan bo'lsa — farq
   "Tannarx farqi" moddasiga. Natija: har bir mahsulotning tannarxi — haqiqiy.
6. **Himoya.** Smena yopilmaguncha manfiy qoldiq faqat shu smenaning separatsiya mahsulotlarida ruxsat etiladi; smena
   yopilganda manfiy qolishi mumkin emas (yakun kiritilmasa smena yopilmaydi). Ogohlantirish rahbarga ko'rinadi.

## 10. Savollar — hammasiga javob berildi
1. ✅ 8.1 (variantlar). 2. ✅ 8.3 (laboratoriya — butunlay o'chiriladi). 3. ✅ 7.1–7.2. 4. ✅ 7.4. 5. ✅ 7.5.
6. ✅ 8.2 (qopqoq — "O'zgarmas" bosqich, stavka bosqichda yoziladi). 7. ✅ 8.4. 8. ✅ 8.5. 9. ✅ 8.6.
10. ✅ Separatsiya taklifi ma'qul — 9-bo'lim (taxminiy narx qolmaydi; butun zanjir FIFO).
11. ✅ Qopqoq yopishda hech narsa ayrilmaydi: qopqoq **quyish bosqichida idishi bilan juft** holda ombordan chiqib
    ketgan va tannarxda allaqachon bor. Idish omborida alohida "qopqoq" turmaydi.
12. ✅ Variantlar — 8.1 (birlik bir xil, faqat nomi va tannarxi farq qiladi).
