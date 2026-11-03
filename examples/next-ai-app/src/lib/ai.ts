import OpenAI from 'openai';
const openai = new OpenAI();
export async function draft(prompt: string) {
  const res = await openai.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: prompt }] });
  return res.choices[0].message.content;
}
