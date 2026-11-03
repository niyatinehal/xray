import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Order } from './order.entity';
import { PaymentsService } from '../payments/payments.service';
import { InventoryService } from '../inventory/inventory.service';

@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    private readonly payments: PaymentsService,
    private readonly inventory: InventoryService,
    private readonly events: EventEmitter2,
  ) {}

  async create(dto: CreateOrderDto) {
    await this.inventory.reserve(dto.items);
    const order = await this.orders.save({ ...dto, status: 'pending' });
    const intent = await this.payments.charge(order.id, dto.total);
    await this.orders.update(order.id, { status: 'paid', paymentId: intent.id });
    this.events.emit('order.paid', { orderId: order.id });
    return order;
  }

  findOne(id: string) {
    return this.orders.findOneBy({ id });
  }
}
