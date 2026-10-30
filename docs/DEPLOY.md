# פריסה על שרת Ubuntu (Docker Compose + HTTPS אוטומטי)

> הפקודות באנגלית, ההסברים בעברית. מדריך זה לא נבדק על שרת אמיתי (אין Docker daemon בסביבת הפיתוח) – בצעו את שלב 7 (בדיקת עשן) לפני שימוש.

## דרך מהירה (סקריפטים)
```bash
git clone -b <branch> git@github.com:diamondrubinny/Botwa.git /opt/botwa && cd /opt/botwa
DOMAIN=support.example.com ./scripts/install.sh          # Docker, חומת אש, .env עם סודות חדשים, הרצה
./scripts/create-admin.sh you@example.com "השם שלך"      # הסיסמה נקראת בלי הד ובלי היסטוריה
DOMAIN=support.example.com ./scripts/smoke.sh            # בדיקות עשן (HTTPS, HSTS, CSP, פורטים, הרשאות .env)
./scripts/update.sh                                       # עדכון בעתיד: גיבוי ← pull ← build
```
הסקריפטים אידמפוטנטיים (`install.sh` לא דורס `.env` קיים). הם נבדקו רק חלקית: יצירת `.env` ותחביר – לא פריסה אמיתית. המדריך המפורט להלן נשאר תקף.

## דרישות
- Ubuntu 22.04/24.04, 2 vCPU, 2GB RAM ומעלה, 20GB דיסק.
- דומיין (רשומת A לכתובת השרת) ופורטים 80/443 פתוחים. פורט 22 מוגבל ל-IP מוכרים/מפתחות SSH.
- Docker Engine + Compose plugin: https://docs.docker.com/engine/install/ubuntu/

## 1. הכנת השרת
```bash
sudo apt update && sudo apt -y upgrade
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable
sudo apt -y install unattended-upgrades
git clone <REPO_URL> /opt/botwa && cd /opt/botwa
git checkout claude/stoic-faraday-i0ave8      # או הענף הראשי לאחר מיזוג
```

## 2. הגדרות
```bash
cp .env.example .env && chmod 600 .env
openssl rand -base64 32      # -> ENCRYPTION_KEY
openssl rand -base64 24 | tr -d '/+='   # -> DB_PASSWORD
nano .env                    # DOMAIN, APP_ORIGIN=https://<DOMAIN>, מפתחות, MESSAGE_RETENTION_DAYS
```
**גבו את `ENCRYPTION_KEY` במקום נפרד מהשרת (מנהל סיסמאות).** בלעדיו אי אפשר לפענח סשנים של ווצאפ/טלגרם וה-MFA של המשתמשים.

טלגרם: צרו `api_id`/`api_hash` ב-https://my.telegram.org (API development tools) ומלאו `TELEGRAM_API_ID` ו-`TELEGRAM_API_HASH`. בלעדיהם ערוץ טלגרם לא יוצע.

## 3. הרצה
```bash
docker compose up -d --build
docker compose ps            # server צריך להיות healthy
docker compose logs -f server
```

## 4. יצירת מנהל ראשון
```bash
docker compose exec \
  -e ADMIN_EMAIL=you@example.com -e ADMIN_NAME="Your Name" -e ADMIN_PASSWORD='at-least-12-characters' \
  server node dist/scripts/create-admin.js
```
היכנסו ל-`https://<DOMAIN>`. המערכת תחייב הפעלת אימות דו-שלבי (MFA) למנהל. אחרי הכניסה החליפו את הסיסמה הראשונית.
הערה: הסיסמה נראית בהיסטוריית הטרמינל – נקו אותה (`history -c`) או החליפו מיד.

## 5. קישור ווצאפ / טלגרם
1. ערוצים ← ערוץ חדש ← "קישור / הפעלה".
2. ווצאפ: בטלפון הגדרות ← מכשירים מקושרים ← קישור מכשיר ← סרקו את ה-QR. 
3. טלגרם: הגדרות ← מכשירים ← קישור מכשיר שולחן עבודה ← סרקו. אם בחשבון אימות דו-שלבי, יופיע שדה סיסמה.
4. שלחו הודעה מטלפון אחר למספר המקושר וודאו שהיא מופיעה ב"שיחות". ענו וודאו שהתשובה התקבלה.

**המלצה:** השתמשו במספר ייעודי ולא במספר אישי/ראשי. החיבור הלא רשמי עלול להוביל לחסימה.

## 5א. קבצים מצורפים (אופציונלי)
ברירת המחדל: כבוי (קבצים נחסמים). להפעלה: הוסיפו ל-`.env` את `CLAMAV_HOST=clamav` והריצו
```bash
docker compose --profile media up -d --build
docker compose logs -f clamav     # בהפעלה ראשונה מורידים חתימות (כמה דקות) עד שה-healthcheck תקין
```
נדרש כ-2–3GB RAM נוספים. הקבצים נשמרים ב-volume `media` (יש לגבות אותו יחד עם המסד), והחתימות מתעדכנות אוטומטית בקונטיינר clamav. אם הסורק לא זמין – קבצים נכנסים נשארים "בסריקה" ושליחת קבצים מחזירה שגיאה (סגירה כברירת מחדל).

## 6. גיבוי ושחזור
```bash
sudo mkdir -p /var/backups/botwa && sudo chmod 700 /var/backups/botwa
# מומלץ להצפין: gpg --import <public key> ; export BACKUP_GPG_RECIPIENT=<key id>
sudo crontab -e   # 03:15 daily:
15 3 * * * cd /opt/botwa && ./scripts/backup.sh >> /var/log/botwa-backup.log 2>&1
```
שחזור (בדקו אותו פעם אחת לפני שנזקקים לו!):
```bash
gunzip -c botwa-YYYYmmdd-HHMMSS.sql.gz | docker compose exec -T db psql -U botwa -d botwa
```
גיבוי הקבצים: `docker run --rm -v botwa_media:/d -v /var/backups/botwa:/b alpine tar czf /b/media-$(date +%F).tgz -C /d .` (שם ה-volume תלוי בשם התיקייה).
### גיבוי מתוך הפאנל (מומלץ בנוסף ל-cron)
הגדרות ← גיבויים ← "יצירת גיבוי עכשיו" (או אוטומטי יומי עם `BACKUP_AUTO_HOUR`). הקבצים מוצפנים (AES-256-GCM, מפתח נגזר מ-`ENCRYPTION_KEY`) ונשמרים ב-volume `backups` (נשמרים `BACKUP_KEEP` אחרונים). הורדה נרשמת ביומן הביקורת. **שחזור מתבצע ידנית בלבד (בכוונה):**
```bash
docker compose cp server:/data/backups/<file>.sql.gz.enc ./            # או הורדה מהפאנל
docker compose exec -T server node dist/scripts/decrypt-backup.js /data/backups/<file>.sql.gz.enc /tmp/out.sql.gz
docker compose exec -T server cat /tmp/out.sql.gz | gunzip | docker compose exec -T db psql -U botwa -d <EMPTY_DB>
```
שחזרו למסד **ריק** (למשל `createdb botwa_restore`), בדקו, ורק אז החליפו. הקבצים המצורפים נגבים בנפרד (volume `media`). ה-Dockerfile מתקין `pg_dump` מ-PGDG – שלב זה לא נבדק בסביבת הפיתוח.

העתיקו גיבויים גם מחוץ לשרת (למשל rsync/rclone ליעד מוצפן).

## 7. בדיקת עשן אחרי פריסה
- [ ] `curl -I https://<DOMAIN>` מחזיר 200 עם HSTS ו-CSP.
- [ ] `http://<DOMAIN>` מופנה ל-HTTPS.
- [ ] התחברות עם MFA עובדת, התנתקות מבטלת סשן.
- [ ] `docker compose restart server` – הערוצים מתחברים אוטומטית בלי סריקה חוזרת.
- [ ] שליחה וקבלת הודעה בכל ערוץ.
- [ ] גיבוי ידני רץ והקובץ אינו ריק; שחזור נבדק על מסד נפרד.

## עדכון גרסה
```bash
cd /opt/botwa && ./scripts/backup.sh && git pull && docker compose up -d --build
```
מיגרציות מסד נתונים רצות אוטומטית בעליית השרת.

## פתרון תקלות
| תסמין | בדיקה |
|---|---|
| אין תעודת HTTPS | רשומת DNS, פורטים 80/443, `docker compose logs caddy` |
| 403 `bad_origin` בכניסה | `APP_ORIGIN` חייב להיות זהה בדיוק לכתובת בדפדפן (כולל https) |
| ה-QR לא מופיע | `docker compose logs server`; ודאו שהשרת מגיע לרשת (`curl -I https://web.whatsapp.com`) |
| "מנותק" אחרי יום-יומיים | המכשיר הוסר בטלפון, או שהחשבון נחסם. קשרו מחדש |
| `Invalid configuration` | `docker compose logs server` מציג איזה משתנה סביבה חסר |
