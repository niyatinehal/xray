import { Processor, Process } from '@nestjs/bull';
import { Job } from 'bull';
import { Resend } from 'resend';
const resend = new Resend(process.env.RESEND_KEY);
@Processor('emails')
export class EmailProcessor {
  @Process({ name: 'receipt', concurrency: 5 })
  async sendReceipt(job: Job) {
    await resend.emails.send({ to: job.data.email, subject: 'Your receipt' });
  }
}
