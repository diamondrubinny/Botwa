import { normalize } from './bot.js';

// A message that is ONLY one of these (after normalisation) means "stop contacting me".
// Whole-message match on purpose: "please stop the delivery" must not opt the customer out.
const STOP_WORDS = new Set(['stop', 'stop all', 'unsubscribe', 'הסר', 'הסרה', 'הסר אותי', 'הסירו אותי', 'הפסק', 'הפסיקו', 'תפסיקו', 'עצור']);

export const isStopMessage = (text: string | null | undefined): boolean => !!text && STOP_WORDS.has(normalize(text));
