'use client';
export function Editor({ projectId }) {
  async function run(prompt) {
    const res = await fetch('/api/generate', { method: 'POST', body: JSON.stringify({ projectId, prompt }) });
    return res.json();
  }
  return null;
}
