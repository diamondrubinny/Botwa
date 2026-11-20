# אווטרים מובנים (נושא בטיחות)

24 התמונות ב-`apps/server/src/avatar-presets/p01.png` עד `p24.png` צוירו במיוחד למערכת:
- 12 דמויות עם ציוד מגן: גוני עור שונים, קסדות בצבעים שונים, אפודה זוהרת, משקפי מגן, אטמי אוזניים, מסכת נשימה ומשקפי מעבדה.
- 12 סמלי בטיחות: מטף, ערכת עזרה ראשונה, קסדה, משקפיים, אטמי אוזניים, כפפה, קונוס, שלט אזהרה, מגן, סולם, צלוחית מעבדה ונעל בטיחות.

הן שייכות לפרויקט, בלי רישיון של צד שלישי.

יצירה מחדש:
```bash
python3 scripts/avatars/generate.py /tmp/avsvg
mkdir -p /tmp/avpng
NODE_PATH=$(npm root -g) node scripts/avatars/render.cjs /tmp/avsvg /tmp/avpng   # צריך Playwright עם Chromium
cp /tmp/avpng/p*.png apps/server/src/avatar-presets/
```

השמות חייבים להישאר בתבנית `pNN.png`. משתמש שכבר בחר תמונה שומר אותה, כי התמונה מועתקת לפרופיל שלו בזמן הבחירה.
