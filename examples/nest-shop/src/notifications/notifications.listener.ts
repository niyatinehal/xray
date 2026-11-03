import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
@Injectable()
export class NotificationsListener {
  constructor(@InjectQueue('emails') private readonly emailQueue: Queue) {}
  @OnEvent('order.paid')
  async handleOrderPaid(payload: { orderId: string }) {
    await this.emailQueue.add('receipt', { orderId: payload.orderId });
  }
  @OnEvent('payment.refunded')
  async handleRefund(payload) {
    await this.emailQueue.add('refund', payload);
  }
}
