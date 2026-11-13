import { useEffect, useState } from 'react';
import { canPromptInstall, isInstalled, isIos, onInstallChange, promptInstall } from '../install';

/** Install the panel as an app on the phone or computer (internal use: no app store needed). */
export function InstallApp() {
  const [, force] = useState(0);
  const [msg, setMsg] = useState('');
  useEffect(() => onInstallChange(() => force((n) => n + 1)), []);
  return (
    <section className="card" aria-labelledby="inst-h">
      <h2 id="inst-h">אפליקציה בטלפון ובמחשב</h2>
      {isInstalled() ? <p>הפאנל פתוח כאפליקציה מותקנת במכשיר הזה.</p> : canPromptInstall() ? (
        <>
          <p>אפשר להתקין את הפאנל כאפליקציה: אייקון במסך הבית, חלון מלא בלי שורת כתובת, והתראות על הודעות חדשות.</p>
          <button type="button" className="primary" onClick={async () => setMsg((await promptInstall()) ? 'האפליקציה הותקנה.' : 'ההתקנה בוטלה. אפשר לנסות שוב מכאן.')}>התקנת האפליקציה במכשיר</button>
        </>
      ) : isIos() ? (
        <p>באייפון: פתחו את הכתובת ב-Safari, לחצו על כפתור השיתוף ואז "הוספה למסך הבית".</p>
      ) : (
        <p>באנדרואיד: פתחו את הכתובת ב-Chrome, לחצו על ⋮ ואז "התקנת אפליקציה" (או "הוספה למסך הבית"). במחשב: סמל ההתקנה בשורת הכתובת של Chrome או Edge.</p>
      )}
      <p role="status" className="hint">{msg}</p>
      <p className="hint">האפליקציה מתעדכנת לבד עם השרת. להתראות על הודעות חדשות יש לאשר התראות כשהמערכת שואלת.</p>
    </section>
  );
}
