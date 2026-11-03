import { Injectable } from '@nestjs/common';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

@Injectable()
export class PaymentsService {
  async charge(orderId: string, amount: number) {
    return stripe.paymentIntents.create({ amount, currency: 'usd', metadata: { orderId } });
  }
}
