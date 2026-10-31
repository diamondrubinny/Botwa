export const t = {
  appName: 'Botwa – מערכת תמיכה',
  skip: 'דלג לתוכן הראשי',
  loading: 'טוען…',
  save: 'שמירה',
  cancel: 'ביטול',
  confirm: 'אישור',
  nav: { inbox: 'שיחות', channels: 'ערוצים', team: 'צוות', account: 'החשבון שלי', a11y: 'הצהרת נגישות', privacy: 'פרטיות ועוגיות', logout: 'התנתקות' },
  roles: { admin: 'מנהל', supervisor: 'מפקח', agent: 'נציג' },
  status: {
    stopped: 'לא פעיל', connecting: 'מתחבר…', qr: 'ממתין לסריקת QR', connected: 'מחובר', password: 'ממתין לסיסמת האימות הדו-שלבי של טלגרם', logged_out: 'מנותק (נדרשת סריקה מחדש)', error: 'שגיאה',
  } as Record<string, string>,
  errors: {
    invalid_credentials: 'האימייל או הסיסמה שגויים.',
    mfa_required: 'יש להזין קוד אימות בן 6 ספרות.',
    account_locked: 'החשבון ננעל זמנית עקב ניסיונות כושלים. נסו שוב בעוד כמה דקות.',
    invalid_code: 'הקוד שגוי.',
    email_taken: 'האימייל כבר קיים במערכת.',
    channel_not_connected: 'הערוץ אינו מחובר, לא ניתן לשלוח.',
    cannot_demote_self: 'לא ניתן להוריד הרשאות או להשבית את עצמך.',
    unsupported_channel_type: 'הפלטפורמה אינה מוגדרת בשרת (לטלגרם נדרשים TELEGRAM_API_ID ו-TELEGRAM_API_HASH).',
    password_not_requested: 'כרגע לא נדרשת סיסמה.',
    channel_error: 'הפעולה בערוץ נכשלה. בדקו את חיבור השרת לרשת.',
    file_type_not_allowed: 'סוג הקובץ אינו נתמך (מותרים: תמונות, PDF, Word, Excel, שמע ווידאו MP4).',
    file_too_large: 'הקובץ גדול מדי.',
    file_infected: 'הקובץ נחסם: זוהתה בו תוכנה זדונית.',
    scanner_unavailable: 'סורק האבטחה אינו זמין כרגע. נסו שוב בעוד רגע.',
    media_disabled: 'שליחת קבצים כבויה בשרת (לא הוגדר סורק אנטי-וירוס).',
    bad_origin: `הכתובת שבה נכנסתם (${typeof location !== 'undefined' ? location.origin : ''}) אינה הכתובת הרשמית של המערכת. היכנסו מהכתובת הרשמית (למשל בלי www).`,
    rate_limited: 'יותר מדי ניסיונות. המתינו דקה ונסו שוב.',
    internal_error: 'שגיאת שרת. נסו שוב בעוד רגע, ואם זה חוזר פנו למנהל המערכת.',
    forbidden: 'אין הרשאה לפעולה זו.',
    generic: 'אירעה שגיאה. נסו שוב.',
  } as Record<string, string>,
};

export const blockedReason: Record<string, string> = {
  type_not_allowed: 'סוג הקובץ אינו נתמך',
  too_large: 'הקובץ גדול מדי',
  media_disabled: 'קבצים מצורפים כבויים בשרת',
  download_failed: 'הורדת הקובץ נכשלה',
  scan_failed: 'סריקת האבטחה נכשלה',
};

export const errText = (code: string) => t.errors[code] ?? t.errors.generic!;
