# Yaya 2.0

Sut xaridi uchun korporativ tizim: barcha xodimlar uchun oflayn ishlaydigan mobil ilova + admin uchun veb panel. To'liq mustaqil tizim.
Bu — asl Yaya loyihasining mustaqil nusxasi; server: https://yaya2-production.up.railway.app (`main` branchdan deploy bo'ladi).

Reja: [docs/PLAN.md](docs/PLAN.md) · Deploy va o'rnatish: [docs/DEPLOY.md](docs/DEPLOY.md) · O'zgarishlar: [docs/CHANGELOG.md](docs/CHANGELOG.md) · Keyingi bosqichlar: [docs/NEXT.md](docs/NEXT.md)

## Tuzilma
- `server/` — Node.js API (mobil sinxron, panel, hisobotlar), SQLite
- `admin/` — boshqaruv paneli (`/admin/`)
- `mobile/` — mobil ilova, barcha xodimlar uchun (Expo / React Native). Brauzer versiyasi `/app/` da (test uchun)
- `.github/workflows/android.yml` — APK avtomatik yig'iladi

## Lokal ishga tushirish
```bash
cd server && npm install
ADMIN_LOGIN=admin ADMIN_PASSWORD=MaxfiyParol123 npm start   # http://localhost:3000/admin/
npm test

# brauzer test-ilovasi uchun (ixtiyoriy):
cd ../mobile && npm install && npx expo export --platform web   # server /app/ da beradi
```
