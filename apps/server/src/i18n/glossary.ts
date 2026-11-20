import type { Db } from '../db.js';
import type { GlossaryEntry } from './mt.js';

/**
 * Starting terms for the translation glossary (common lab-safety terms). The Arabic and Russian cells are drafts for a native
 * speaker to check; the unit edits the list on the bot page. Saved under settings 'mt_glossary' once edited.
 */
export const DEFAULT_GLOSSARY: GlossaryEntry[] = [
  { he: 'מנדף', en: 'fume hood', ar: 'خزانة طرد الأبخرة', ru: 'вытяжной шкаф' },
  { he: 'ממונה בטיחות', en: 'safety officer', ar: 'مسؤول السلامة', ru: 'ответственный за технику безопасности' },
  { he: 'יחידת הבטיחות', en: 'safety unit', ar: 'وحدة السلامة', ru: 'отдел техники безопасности' },
  { he: 'חומרים מסוכנים', en: 'hazardous materials', ar: 'مواد خطرة', ru: 'опасные вещества' },
  { he: 'גיליון בטיחות', en: 'safety data sheet (SDS)', ar: 'صحيفة بيانات السلامة', ru: 'паспорт безопасности' },
  { he: 'מטף', en: 'fire extinguisher', ar: 'طفاية حريق', ru: 'огнетушитель' },
  { he: 'ציוד מגן אישי', en: 'personal protective equipment (PPE)', ar: 'معدات الحماية الشخصية', ru: 'средства индивидуальной защиты' },
  { he: 'פסולת כימית', en: 'chemical waste', ar: 'نفايات كيميائية', ru: 'химические отходы' },
  { he: 'מקלחת חירום', en: 'emergency shower', ar: 'دش الطوارئ', ru: 'аварийный душ' },
  { he: 'שוטף עיניים', en: 'eyewash station', ar: 'محطة غسيل العيون', ru: 'фонтанчик для промывания глаз' },
  { he: 'מפגע', en: 'hazard', ar: 'خطر', ru: 'опасность' },
  { he: 'הדרכת בטיחות', en: 'safety training', ar: 'تدريب السلامة', ru: 'инструктаж по технике безопасности' },
];

export async function loadGlossary(db: Db): Promise<GlossaryEntry[]> {
  const v = (await db.query(`SELECT value FROM settings WHERE key = 'mt_glossary'`)).rows[0]?.value as GlossaryEntry[] | undefined;
  return Array.isArray(v) ? v : DEFAULT_GLOSSARY;
}
