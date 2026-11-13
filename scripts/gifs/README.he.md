# GIF מובנים (נושא בטיחות)

12 האנימציות ב-`apps/server/src/gif-presets/` צוירו במיוחד למערכת, והן שייכות לפרויקט בלי רישיון של צד שלישי. הגופן בהן הוא Heebo (רישיון OFL, ראו `apps/web/public/fonts/OFL-Heebo.txt`).
- הן נוספות לספריית ה-GIF פעם אחת, באתחול הראשון אחרי העדכון. מנהל יכול למחוק כל אחת, והיא לא תחזור.
- כשמוסיפים או מציירים מחדש, מעלים את `GIF_PRESETS_VERSION` ב-`apps/server/src/gif-presets.ts`.

יצירה מחדש (צריך Playwright עם Chromium ו-Pillow):
```bash
NODE_PATH=$(npm root -g) node scripts/gifs/frames.cjs /tmp/gif-frames
python3 scripts/gifs/assemble.py /tmp/gif-frames apps/server/src/gif-presets
```
