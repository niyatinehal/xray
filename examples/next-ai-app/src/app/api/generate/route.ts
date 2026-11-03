import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { draft } from '@/lib/ai';
import { checkLimit } from '@/lib/ratelimit';

export async function POST(req: Request) {
  const { userId, projectId, prompt } = await req.json();
  if (!(await checkLimit(userId))) return NextResponse.json({ error: 'slow down' }, { status: 429 });
  const project = await db.project.findUnique({ where: { id: projectId } });
  const text = await draft(`${project?.context}\n${prompt}`);
  const gen = await db.generation.create({ data: { projectId, text } });
  return NextResponse.json(gen);
}
