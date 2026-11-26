# Yaya 2.0 — ishga tushirish qo'llanmasi

Bu qo'llanma tizimni haqiqiy ishga tushirish tartibini beradi: nimani, qaysi ketma-ketlikda va qayerda
kiritish kerak. Hamma narsa panelda (https://yaya2-production.up.railway.app/admin/) qilinadi, xodimlar esa
ilovada (telefon, planshet yoki monoblokdagi brauzer: `/app/`) ishlaydi.

## 0. Sinov ma'lumotlarini tozalash (ishga tushirishdan oldin)
1. **Boshqaruv → Sozlamalar → Zaxira:** avval zaxira faylini yuklab oling (parol bilan).
2. Shu joyda **"Tarixni tozalash"**: barcha hujjatlar, qoldiqlar, kassa va ish haqi yozuvlari
   o'chadi; xodimlar, mahsulotlar, omborlar, tarkiblar va sozlamalar qoladi.
3. Sinov uchun yaratilgan ortiqcha mahsulot yoki xodimlarni "nofaol" qiling.
4. Xato bo'lsa, tozalashdan oldingi holat 3 kun saqlanadi ("Avtomatik nusxalar").

## 1. Xodimlar va rollar
**Boshqaruv → Xodimlar.** Har bir xodimga bitta rol:

| Rol | Kim | Ilovada nimani ko'radi |
|---|---|---|
| Admin | rahbar | hammasi (summalar bilan) |
| Menejer | boshqaruvchi | ombor, ishlab chiqarish nazorati, tasdiqlash, moliya (oyliksiz) |
| Omborchi | ombor mas'uli | topshirish/qabul, inventarizatsiya, hisobdan chiqarish (summasiz) |
| Texnolog | texnolog | "Ishlab chiqarish" bosqichi: quyma, smena, separatsiya |
| Quyuvchi | quyuvchi | "Quyish" (va kerak bo'lsa "Issiqxona") bosqichi — ishbay haq |
| Qopqoq yopuvchi | qopqoqchi | "Qopqoq yopish" bosqichi — ishbay haq |
| Qayta ishlovchi | qayta ishlovchi | "Yaroqsiz qayta ishlash" bosqichi |
| Buxgalter, Sut yig'uvchi | — | avvalgidek |

Kim qaysi bosqichda ishlashini **rol emas, bosqichga mas'ullik** belgilaydi (Ishlab chiqarish → Bosqichlar va xarita).
Xodim yaratishda **"Monoblokdan foydalanadi"** belgisi: belgilanmasa PIN so'ralmaydi va u faqat telefonda ishlaydi.

Rol ruxsatlarini **Boshqaruv → Rollar va ruxsatlar**da o'zgartirasiz. Muhim ruxsatlar:
"Tannarx va summalarni ko'rish" (oddiy xodimlarga bermang) va "Oylik" (faqat rahbar/buxgalter).

## 2. Omborlar
**Ombor → Omborlar.** Tavsiya etilgan ro'yxat (har biriga mas'ul xodimlarni belgilang):
- **Xom sut ombori** — turi "Xom sut ombori", **manfiy qoldiqqa ruxsat** (sut kirimdan oldin berilishi mumkin);
  shu sahifada "Smenadan qabul qilingan sut qaysi omborga kiradi" — shu omborni tanlang.
- Xomashyo ombori, Idish ombori, **Issiqxona** (turi "Issiqxona" — turish vaqti nazorat qilinadi),
  Tayyor mahsulot ombori, **Muddati o'tganlar ombori**, Qayta ishlash ombori.

## 3. Mahsulotlar
**Ombor → Mahsulotlar** yoki **Ombor → Excel import → Mahsulotlar** (shablonni yuklab, to'ldirib, tekshirib, import).
- Turi: xomashyo, quyma, idish, etiketka, tayyor mahsulot, qaytgan, qayta ishlangan.
- Tayyor mahsulotda: **netto/brutto vazn** (qayta ishlash va hisobotlar uchun), **yaroqlilik muddati** (soat),
  **issiqxonada turish vaqti** (soat).
- "Xom sut" o'zi yaratiladi; sut yig'uvchilar mahsulotlari (Yog'li/Yog'siz sut) **Sut yig'ish → Sut mahsulotlari**da.

## 4. Boshlang'ich qoldiq va balanslar
- **Qoldiqlar:** Ombor → Excel import → "Boshlang'ich qoldiqlar" (ombor, mahsulot, miqdor, tannarx, yaroqlilik)
  yoki Ombor → Qoldiqlar → "+ Boshlang'ich qoldiq". Keyin kerak bo'lsa **inventarizatsiya** (to'liq yoki qisman).
- **Kassalar:** Moliya → Kassalar → "Boshlang'ich qoldiq" (har bir kassadagi pul).
- **Yetkazib beruvchilar:** Moliya → Yetkazib beruvchilar → "Boshlang'ich qarz".
- **Xodimlar:** Moliya → Oylik → xodim → "Boshlang'ich balans" (musbat — xodim qarzdor, manfiy — kompaniya qarzdor).
- **Xonadonlar:** avvalgidek, Sut yig'ish → Qarzlar.

## 5. Ishlab chiqarish sozlamalari
**Ishlab chiqarish → Bosqichlar va xarita** (eng muhimi):
- 10 ta bosqich bor: Ishlab chiqarish, Quyish, Qadoqlash, Issiqxona, Sovuqxona, Qopqoq yopish, Tayyor mahsulot ombori,
  Vozvrat ombori, Yaroqli qayta ishlash, Yaroqsiz qayta ishlash. Har biri — ombor ("Bosqich"). Yangi bosqichni kerakli
  joyga qo'yasiz, ↑↓ bilan tartibini o'zgartirasiz.
- **Turi:** *O'zgaradigan* — mahsulot boshqasiga aylanadi (tarkib, xomashyo, chegaralar, ishbay haq tarkibda);
  *O'zgarmas* — o'sha mahsulot keyingi joyga o'tadi (ishbay haq bosqichda, masalan qopqoq 90 so'm; issiqxonada bo'sh).
- **Mas'ullar:** shu bosqichni kim boshqaradi. Xomashyo / idish olinadigan omborlarga ham shu xodimlarni mas'ul qiling
  (texnolog — Xom sut va Xomashyo ombori; quyuvchi — Idish ombori): tarkib bo'yicha o'zi ayriladi.
- **Tex karta** (faqat tayyor mahsulot uchun): qaysi bosqichlardan o'tishi; "Ishlab chiqarish"da — **quyma mahsuloti**
  (quyma tarkibi), "Quyish"/"Qadoqlash"da — tarkibi. Bir quymadan bir nechta tayyor mahsulot chiqadi; quyuvchi qaysi birini
  quyishni tanlaydi. Tex kartani shu sahifadan yoki Ombor → Mahsulotlar'dan ochasiz. O'chiq bosqich o'tkazib yuboriladi.
- **Ishbay haq** faqat quyish, qadoqlash va qopqoq yopishda; ishlab chiqarish (quyma) tarkibida bo'lmaydi.
- **Jurnal:** har bir amal — qaysi bosqichda, kim bajardi, kimlar qatnashdi.

**Ishlab chiqarish → Tarkiblar:** har bir tarkib bitta bosqichga tegishli. Quyish / qadoqlash tarkibi "umumiy" bo'lishi
mumkin (chiqadigan mahsulot bo'sh) — uni tayyor mahsulotning Tex kartasi bog'laydi.
**Mahsulot belgilari:** "Sotuv uchun mavjud" (kg hisobida ham sotiladi) va "Xomashyo" (xomashyo sifatida ham ishlatiladi).
- **Tayyorlash (quyma)** — asosiy partiya: xom sut, qaymoq, zakvaska...; har qatorga alternativ;
  chiqish oralig'i (masalan 320–335 kg) — partiyaga qarab o'zi o'zgaradi.
  **Shartli limitlar:** "B zakvaska ishlatilsa — 315–330 kg" kabi; bir nechtasi mos kelsa eng aniqi (ko'p xomashyolisi)
  olinadi, birortasi mos kelmasa — umumiy oraliq. Texnolog ilovada qaysi chegara ishlayotganini ko'radi.
- **Separatsiya** — chiqadigan mahsulotlar: qaymoq "qat'iy 1 kg tannarxi", yog'siz sut "qolgan tannarx".
- **Quyish** va **Qadoqlash** — 1 dona uchun; ishbay haq (masalan 170 so'm) va topshiriq muddati. Qadoqlash — masalan
  tashqaridan kg lab xarid qilingan mahsulotni idishga solish (bunday mahsulotda "Ishlab chiqarish" o'chiq turadi).
- **Variantli xomashyo** ("Zakvaska") tarkibda bitta qator; texnolog ishlatishda variantini (499, 505) tanlaydi.
- **Qayta ishlash** — 1 dona muddati o'tgan mahsulotdan: idish (qat'iy tannarx, "idish" belgisi) va ichidagi
  mahsulot (netto vazndan, chegara bilan, tannarx 0).

**Ishlab chiqarish → Yo'qotish sabablari:** texnolog sabablari (Qaynatishda, Oxladitelda, To'kildi) — ta'siri
(tannarxga / kompaniya xarajatiga / xodim hisobiga) va limit (masalan 1000 kg sutga 100 kg).

## 6. Savdo — hozircha yo'q
Sotuv, qaytarish va mijozlar olib tashlandi; ular 11–12-bosqichlarda distributsiya (agentlar, vositachilar, do'konlar,
buyurtmalar) bilan qaytadi. Avval "Sotuvchi" rolida bo'lgan xodimlar tizimga kira olmaydi (tarixi saqlangan) — kerak
bo'lsa Boshqaruv → Xodimlar'da boshqa rol berib, qayta faol qiling. Kassalar va to'lov turlari endi **Moliya → Kassalar**da.

## 7. Moliya va oylik
**Moliya → Oylik:** har bir xodimga oklad va kun (1–28) — shu kuni avtomatik yoziladi. Bonus va jarima — sabab bilan.
**Moliya → Foyda-zarar** va **Hisobotlar → Umumiy hisobotlar** — natijalar.
**Xonadonlarga to'lov** kassadan chiqadi: panelda "Qaysi kassadan" tanlanadi (standart — asosiy kassa); sut yig'uvchi
dalada to'lasa — uning o'z kassasidan (birinchi to'lovda "<ism> kassasi" o'zi ochiladi), keyin u pulni asosiy kassadan
oladi yoki topshiradi. To'lov bekor qilinsa pul kassaga qaytadi.
**Kassa nazorati:** Moliya → Kassalar → "Kassani sanash" — sanalgan pulni yozasiz. Ortiqcha — "Kassa ortiqchasi" kirimi;
kamomad — kim hisobiga ekani so'raladi (xodim(lar)ga summa, qolgani "Kassa kamomadi" xarajati).
**Moliya → Balanslar:** kassalarda qancha pul, kim bizga va biz kimga qarz — har biri ism bilan.

## 8. Monoblok (sexdagi umumiy kompyuter)
1. **Boshqaruv → Monobloklar → "+ Monoblok"** (bo'sh tursa necha daqiqada ismlar ro'yxatiga qaytsin).
2. Monoblokda ishlaydigan xodimlarga **"Monoblokdan foydalanadi"** belgisi (Boshqaruv → Xodimlar), so'ng 4 xonali PIN
   (shu sahifada yoki xodim o'zi: ilova → Profil). Ikki xodimning PIN'i bir xil bo'lishi mumkin emas.
   Monoblokda son kiritiladigan joy bosilganda burchakda katta raqam tugmalari chiqadi.
3. Monoblokda brauzerda `/app/` → **"🖥 Monoblok rejimi"** → panelda "Ulash kodi" bilan olingan 6 xonali kod.
4. Monoblokni to'liq ekran rejimida qoldiring (brauzerda F11).

## 9. Kundalik ish oqimi
1. **Sut yig'uvchi** smena yopadi → **omborchi/buxgalter** qabul qiladi → sut "Xom sut ombori"ga o'zi tushadi va
   texnolog darhol ishlata oladi.
2. **Reja** (panel → Ishlab chiqarish → Reja): har kuni tayyor mahsulotlar soni kiritiladi.
3. **Texnolog** (ilova → Ishlab chiqarish) "Bugungi rejalar"dan quymani bosadi — tarkib tavsiyalari bilan ochiladi; sut
   va xomashyo omborlardan o'zi ayriladi, quyma "Ishlab chiqarish" bosqichida turadi. Yog'siz sutni separatsiyadan oldin
   ham ishlatish mumkin. Smena oxirida: **separatsiya** (toza qaymoqni yozadi, yog'siz sut o'zi), **qabul qilingan sut**
   (⬇ — yig'uvchi smenalarini tanlaydi), so'ng yo'qotishni sabablar bo'yicha to'liq yozadi — haqiqiy tannarx shunda aniqlanadi.
3. **Quyuvchi** "Quyish" bosqichida kutayotgan quymani ko'radi, nechta quyganini yozadi, "kim bilan" — ishbay haq bo'linadi.
4. **Issiqxona → Sovuqxona → Qopqoq yopish → Tayyor mahsulot ombori:** har bir bosqich mas'uli oldingi bosqichdan
   nechtasini olganini yozadi. Ko'p yozilsa oldingi bosqich manfiyga tushadi va rahbarga xabar boradi.
5. Muddati o'tgani tayyor mahsulot omboridan **Vozvrat ombori**ga o'tadi, u yerdan **qayta ishlovchi** qayta ishlaydi.
6. Hech kimning "qo'lida" mahsulot yo'q — hamma narsa ombor yoki bosqichda.
8. **Rahbar** Bosh panelda kunlik holatni, "Tasdiqlash"da limitdan chiqqanlarni, hisobotlarda natijani ko'radi.

Internet bo'lmasa: to'lov, topshirish, hisobdan chiqarish, qabul qilish va o'zgarmas bosqich amallari navbatga tushadi
va internet chiqqanda o'zi ketadi (ilova tepasida "⏳"). Ishlab chiqarish topshiriqlari, inventarizatsiya va
monoblokka kirish uchun internet kerak.

## 10. Hozircha yo'q (keyingi ishlar)
- Android ilova (APK) va Desktop o'rnatuvchisini yig'ish; telefonga push xabarlar; Android'da chek printeri.
- Buyurtmalar va logistika; soliq va Didox; keldi-ketdi (HR).
