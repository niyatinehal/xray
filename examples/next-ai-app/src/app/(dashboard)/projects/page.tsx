import { createProject } from '@/actions/projects';
export default function Page() { return <form action={createProject}><input name="name" /></form>; }
