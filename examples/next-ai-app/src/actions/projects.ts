'use server';
import { db } from '@/lib/db';
import { revalidatePath } from 'next/cache';
export async function createProject(formData: FormData) {
  const project = await db.project.create({ data: { name: formData.get('name') } });
  revalidatePath('/projects');
  return project;
}
