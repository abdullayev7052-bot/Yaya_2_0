# 10-bosqich — omborgacha jarayonni qayta qurish: talablar ro'yxati

Holat: **yig'ilmoqda** (2026-11-25). Hali kod yozilmadi — rahbar qo'shimcha o'zgarishlarni aytadi, keyin hammasi
birga rejalashtiriladi. Pastdagi "Ochiq savollar" ish boshlanishidan oldin aniqlanadi.

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

## 8. Ochiq savollar (ish boshlashdan oldin aniqlanadi)
1. Variantlar: variant qiymati faqat raqam/nommi (499, 505) yoki variantning o'z birligi va xossalari (vazn, muddat)
   ham alohida bo'ladimi? Tarkibda "Zakvaska" yozilsa, texnolog istalgan mavjud variantni tanlay oladimi?
2. Laboratoriya: eski laboratoriya yozuvlari bazada saqlanib qolsinmi (savdodagi kabi — kod o'chadi, ma'lumot qoladi)?
3. ✅ Javob berildi — 7.1–7.2 (har bir bosqichning o'z ombori, bir nechta mas'ul).
4. ✅ Javob berildi — 7.4 ("Bu ishni kim bilan qildingiz?", o'zi avtomatik belgilangan).
5. ✅ Javob berildi — 7.5 (xarid qilingan kg lik mahsulotni qadoqlash).
6. Qopqoq yopish: ishbay haq qoladimi (hozir 90 so'm/dona)? Qopqoqning o'zi (idish ombori) ham ayrilmaydimi?
7. Xaritadagi tarkiblar: hozirgi tarkiblar (tayyorlash, separatsiya, quyish, qopqoq, qayta ishlash) xaritaga
   bog'lanadimi yoki tarkiblar to'liq xarita ichiga ko'chadimi?
8. Separatsiya xaritaning qaysi bosqichiga kiradi (1-bosqich ichidami)?
9. Vozvrat ombori: savdo hozir yo'q — hozircha faqat tayyor mahsulot omboridan transfer bilan to'ldiriladi, to'g'rimi?
