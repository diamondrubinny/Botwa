/** Hebrew labels for permission keys, grouped for the role editor. */
export const PERM_GROUPS: { title: string; items: [string, string][] }[] = [
  { title: 'שיחות', items: [['inbox.view_all', 'לראות את כל השיחות (ללא: רק שלי ושטרם שויכו)'], ['conversations.assign_others', 'לשייך שיחות לנציגים אחרים'], ['contacts.block', 'לחסום/לשחרר לקוחות ולהחזיר הסכמה']] },
  { title: 'תוכן ותפעול', items: [['canned.manage', 'לנהל תשובות מוכנות'], ['tags.manage', 'לנהל תגיות'], ['reports.view', 'לצפות בדוחות'], ['bot.view', 'לצפות בהגדרות הבוט'], ['bot.manage', 'לערוך את הבוט']] },
  { title: 'ערוצים והגדרות', items: [['channels.view', 'לצפות בערוצים ובבריאותם, ועצירת חירום'], ['channels.manage', 'ליצור/לקשר/לנתק/למחוק ערוצים'], ['settings.view', 'לצפות בהגדרות'], ['settings.manage', 'לשנות הגדרות (שעות, ניתוב, מגבלות שליחה)']] },
  { title: 'אנשים ואבטחה', items: [['users.view', 'לצפות ברשימת הצוות'], ['users.manage', 'ליצור/לערוך/להשבית משתמשים ולאפס MFA'], ['roles.manage', 'לנהל תפקידים'], ['audit.view', 'לצפות ביומן הביקורת']] },
  { title: 'פרטיות וגיבוי', items: [['privacy.manage', 'לייצא ולמחוק מידע של לקוח'], ['backups.manage', 'לנהל גיבויים']] },
];
