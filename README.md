# Yaya 2.0

Sut korxonasi uchun tizim — omborgacha bo'lgan zanjir: sut yig'ish → xom sut va xomashyo omborlari → ishlab chiqarish
(texnolog, quyish, issiqxona, qopqoq) → tayyor mahsulot ombori, muddati o'tganlarni qayta ishlash, ustida moliya va oylik,
hisobotlar. Sotuv, qaytarish, mijozlar va distributsiya (agentlar, vositachilar, do'konlar, buyurtmalar) — 11–12-bosqichlarda. Barcha xodimlar uchun oflayn ishlaydigan ilova (telefon, planshet,
monoblok — PIN bilan almashish) + rahbar uchun veb panel. Oddiy xodimlar tannarx va summalarni ko'rmaydi.
Bu — asl Yaya loyihasining mustaqil nusxasi; server: https://yaya2-production.up.railway.app (`main` branchdan deploy bo'ladi).

**Ishga tushirish qo'llanmasi: [docs/QOLLANMA.md](docs/QOLLANMA.md)** · ERP reja va bosqichlar: [docs/ERP_PLAN.md](docs/ERP_PLAN.md)

Reja: [docs/PLAN.md](docs/PLAN.md) · Deploy va o'rnatish: [docs/DEPLOY.md](docs/DEPLOY.md) · O'zgarishlar: [docs/CHANGELOG.md](docs/CHANGELOG.md) · Keyingi bosqichlar: [docs/NEXT.md](docs/NEXT.md)

## Tuzilma
- `server/` — Node.js API (mobil sinxron, panel, ombor/ishlab chiqarish/moliya — `src/erp/`, hisobotlar), SQLite
- `admin/` — boshqaruv paneli (`/admin/`)
- `mobile/` — mobil ilova, barcha xodimlar uchun (Expo / React Native). Brauzer versiyasi `/app/` da (test uchun)
- `.github/workflows/android.yml` — APK yig'ish (hozircha faqat qo'lda: GitHub → Actions → Android APK → Run workflow)

## Lokal ishga tushirish
```bash
cd server && npm install
ADMIN_LOGIN=admin ADMIN_PASSWORD=MaxfiyParol123 npm start   # http://localhost:3000/admin/
npm test

# brauzer test-ilovasi uchun (ixtiyoriy):
cd ../mobile && npm install && npx expo export --platform web   # server /app/ da beradi
```
