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
| Texnolog | texnolog | smena, quyma va separatsiya topshiriqlari |
| Quyuvchi | quyuvchi | quyish topshiriqlari (ishbay haq) |
| Qopqoq yopuvchi | qopqoqchi | qopqoq yopish topshiriqlari (ishbay haq) |
| Qayta ishlovchi | qayta ishlovchi | muddati o'tganlarni qayta ishlash |
| Buxgalter, Sut yig'uvchi, Laborant | — | avvalgidek |

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
**Ishlab chiqarish → Tarkiblar:**
- **Tayyorlash (quyma)** — asosiy partiya: xom sut, qaymoq, zakvaska...; har qatorga alternativ;
  chiqish oralig'i (masalan 320–335 kg) — partiyaga qarab o'zi o'zgaradi.
  **Shartli limitlar:** "B zakvaska ishlatilsa — 315–330 kg" kabi; bir nechtasi mos kelsa eng aniqi (ko'p xomashyolisi)
  olinadi, birortasi mos kelmasa — umumiy oraliq. Texnolog ilovada qaysi chegara ishlayotganini ko'radi.
- **Separatsiya** — chiqadigan mahsulotlar: qaymoq "qat'iy 1 kg tannarxi", yog'siz sut "qolgan tannarx".
- **Quyish** va **Qopqoq yopish** — 1 dona uchun; ishbay haq (masalan 170 va 90 so'm) va topshiriq muddati.
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
2. Xodimlarga 4 xonali PIN (shu sahifada yoki xodim o'zi: ilova → Profil → "Monoblok uchun PIN").
3. Monoblokda brauzerda `/app/` → **"🖥 Monoblok rejimi"** → panelda "Ulash kodi" bilan olingan 6 xonali kod.
4. Monoblokni to'liq ekran rejimida qoldiring (brauzerda F11).

## 9. Kundalik ish oqimi
1. **Sut yig'uvchi** smena yopadi → **omborchi/buxgalter** qabul qiladi → sut "Xom sut ombori"ga o'zi tushadi.
2. **Omborchi** texnologga sut va xomashyoni **topshiradi** (Ombor → Topshirish); texnolog **qabul qiladi**.
3. **Texnolog** smena ochadi, topshiriq bajaradi (tarkib bo'yicha, quymani tortib yozadi), quymani quyuvchiga
   topshiradi, smena oxirida qolgan sutni qaytaradi va yo'qotishni sabablar bilan yozadi.
4. **Quyuvchi** quyadi (kim bilan birga — ishbay haq bo'linadi), mahsulot **issiqxonaga** ketadi;
   turish vaqti o'tsa, mas'ul ismi bilan ogohlantirish chiqadi.
5. **Qopqoq yopuvchi** issiqxonadan oladi, qopqoqlaydi → **tayyor mahsulot ombori**.
6. Muddati o'tgan mahsulotni **omborchi** tayyor mahsulot omboridan **"Muddati o'tganlar" omboriga topshiradi**.
7. Muddati o'tgan qaytgan mahsulotni **qayta ishlovchi** qayta ishlaydi.
8. **Rahbar** Bosh panelda kunlik holatni, "Tasdiqlash"da limitdan chiqqanlarni, hisobotlarda natijani ko'radi.

Internet bo'lmasa: to'lov, topshirish, hisobdan chiqarish va qabul qilish navbatga tushadi
va internet chiqqanda o'zi ketadi (ilova tepasida "⏳"). Ishlab chiqarish topshiriqlari, inventarizatsiya va
monoblokka kirish uchun internet kerak.

## 10. Hozircha yo'q (keyingi ishlar)
- Android ilova (APK) va Desktop o'rnatuvchisini yig'ish; telefonga push xabarlar; Android'da chek printeri.
- Buyurtmalar va logistika; soliq va Didox; keldi-ketdi (HR).
