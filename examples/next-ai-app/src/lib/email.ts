import { Resend } from 'resend';
const resend = new Resend(process.env.RESEND_API_KEY);
export const sendWelcome = async (to: string) => resend.emails.send({ to, from: 'hi@draftly.app', subject: 'Welcome' });
