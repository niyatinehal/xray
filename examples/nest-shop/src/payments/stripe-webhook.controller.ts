import { Controller, Post, Req } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
@Controller('webhooks')
export class StripeWebhookController {
  constructor(private readonly events: EventEmitter2) {}
  @Post('stripe')
  handle(@Req() req) {
    if (req.body.type === 'charge.refunded') this.events.emit('payment.refunded', { id: req.body.data.object.id });
    return { received: true };
  }
}
