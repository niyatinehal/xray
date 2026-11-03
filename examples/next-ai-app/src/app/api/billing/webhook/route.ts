import Stripe from 'stripe';
import { db } from '@/lib/db';
import { sendWelcome } from '@/lib/email';
const stripe = new Stripe(process.env.STRIPE_KEY!);
export async function POST(req: Request) {
  const event = stripe.webhooks.constructEvent(await req.text(), req.headers.get('stripe-signature')!, process.env.WH!);
  if (event.type === 'checkout.session.completed') {
    const sub = await db.subscription.upsert({ where: { id: event.data.object.id }, create: {}, update: {} });
    await sendWelcome(event.data.object.customer_email);
  }
  return new Response('ok');
}
