import { Entity, Column } from 'typeorm';
@Entity()
export class Order { @Column() status: string; }
