import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Stock } from './stock.entity';
@Injectable()
export class InventoryService {
  constructor(@InjectRepository(Stock) private readonly stock: Repository<Stock>) {}
  async reserve(items) {
    const rows = await this.stock.findBy({ sku: items.map((i) => i.sku) });
    await this.stock.save(rows.map((r) => ({ ...r, reserved: r.reserved + 1 })));
  }
}
