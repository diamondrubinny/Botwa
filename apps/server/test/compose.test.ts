import { describe, expect, it } from 'vitest';
import { DEFAULT_BOT } from '../src/bot.js';
import { composeAnswer, llmStatus, localAnswer, onlyKnownFacts, quoteAnswer, type KbAnswer } from '../src/kb/compose.js';

const bot = { ...DEFAULT_BOT, kb: { ...DEFAULT_BOT.kb, enabled: true } };
const hit: KbAnswer = {
  sourceId: 's1', chunkId: 1, title: 'תקנות הבטיחות בעבודה (עבודה בגובה), תשס"ז-2007', kind: 'doc', url: null, heading: 'סעיף 5',
  snippet: '', score: 0.9, matched: 3, tokens: 3, exact: false, sem: 0, cos: null,
  text: 'עבודה בגובה מעל 2 מטרים מחייבת הדרכה ואישור.\n\n(תקנות..., סעיף 5)\nהערה משפטית', passage: 'עבודה בגובה מעל 2 מטרים מחייבת הדרכה ואישור. לבירורים: 04-8291234.', note: '(תקנות..., סעיף 5)\nהערה משפטית',
};
const llm = { url: 'http://ollama:11434', model: 'qwen2.5:7b-instruct', timeoutMs: 5000 };
const fakeLlm = (content: string, ok = true) => async (url: string, init?: RequestInit) => {
  calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
  return ok ? Response.json({ message: { role: 'assistant', content } }) : new Response('down', { status: 500 });
};
const calls: { url: string; body: { model: string; messages: { role: string; content: string }[]; stream: boolean } | null }[] = [];

describe('knowledge-base answers', () => {
  it('quote mode: a polite opening, the passage, the source with its section, and a closing line', () => {
    const t = quoteAnswer(bot, hit);
    expect(t.startsWith(bot.kb.intro)).toBe(true);
    expect(t).toContain('עבודה בגובה מעל 2 מטרים');
    expect(t).toContain('מקור: תקנות הבטיחות בעבודה (עבודה בגובה), תשס"ז-2007, סעיף 5');
    expect(t.endsWith(bot.kb.outro)).toBe(true);
  });

  it('local model: asked with the passages only and strict rules; its wording is used with the source and the legal note', async () => {
    calls.length = 0;
    const t = await localAnswer(llm, bot, 'צריך הדרכה לעבודה על סולם של 3 מטר?', hit, 'בטי', fakeLlm('כן. לפי התקנות, עבודה בגובה של יותר מ-2 מטרים מחייבת הדרכה ואישור.'));
    expect(t).toContain('לפי התקנות, עבודה בגובה');
    expect(t).toContain('מקור: תקנות הבטיחות');
    expect(t).toContain('הערה משפטית');
    expect(calls[0]!.url).toBe('http://ollama:11434/api/chat');
    expect(calls[0]!.body).toMatchObject({ model: 'qwen2.5:7b-instruct', stream: false });
    expect(calls[0]!.body!.messages[0]!.content).toContain('אך ורק על סמך הקטעים');
    expect(calls[0]!.body!.messages[0]!.content).toContain('בטי');
    expect(calls[0]!.body!.messages[1]!.content).toContain('עבודה בגובה מעל 2 מטרים');
  });

  it('local model is never trusted blindly: "not covered", an invented number or link, an error -> null (the quote is used)', async () => {
    expect(await localAnswer(llm, bot, 'q?', hit, 'בטי', fakeLlm('NO_ANSWER'))).toBeNull();
    expect(await localAnswer(llm, bot, 'q?', hit, 'בטי', fakeLlm('התקשרו ל-03-5551234 לפרטים'))).toBeNull();          // a phone not in the passages
    expect(await localAnswer(llm, bot, 'q?', hit, 'בטי', fakeLlm('ראו https://example.com/x'))).toBeNull();
    expect(await localAnswer(llm, bot, 'q?', hit, 'בטי', fakeLlm('', true))).toBeNull();
    expect(await localAnswer(llm, bot, 'q?', hit, 'בטי', fakeLlm('x', false))).toBeNull();
    expect(await localAnswer({ ...llm, url: '' }, bot, 'q?', hit, 'בטי', fakeLlm('תשובה טובה מאוד'))).toBeNull();     // not configured
    expect(await localAnswer(llm, bot, 'q?', hit, 'בטי', fakeLlm('לבירורים אפשר להתקשר ל-04-8291234.'))).toContain('04-8291234');   // copied from the passage: fine
    const local = { ...bot, kb: { ...bot.kb, answerMode: 'local' as const } };
    expect(await composeAnswer(llm, local, 'q?', hit, 'בטי', fakeLlm('NO_ANSWER'))).toBe(quoteAnswer(local, hit));
  });

  it('checks numbers and links against the passages', () => {
    expect(onlyKnownFacts('תקן 1142 קובע', 'לפי ת"י 1142 ...')).toBe(true);
    expect(onlyKnownFacts('תקן 99999 קובע', 'לפי ת"י 1142 ...')).toBe(false);
    expect(onlyKnownFacts('2 מטרים', 'אחר')).toBe(true);   // a single digit may be worded freely
    expect(onlyKnownFacts('לפחות 10 ימים', 'תוך 14 ימים')).toBe(false);
    expect(onlyKnownFacts('משנת 2007', '[1] תקנות, תשס"ז-2007')).toBe(true);   // the title is part of the passages
  });

  it('tells whether the local model is there and installed', async () => {
    const tags = async () => Response.json({ models: [{ name: 'qwen2.5:7b-instruct', model: 'qwen2.5:7b-instruct' }] });
    expect(await llmStatus(llm, tags)).toEqual({ configured: true, reachable: true, model: 'qwen2.5:7b-instruct', installed: true });
    expect(await llmStatus({ ...llm, model: 'other' }, tags)).toMatchObject({ installed: false });
    expect(await llmStatus({ ...llm, url: '' })).toMatchObject({ configured: false });
    expect(await llmStatus(llm, async () => { throw new Error('x'); })).toMatchObject({ reachable: false });
  });
});
