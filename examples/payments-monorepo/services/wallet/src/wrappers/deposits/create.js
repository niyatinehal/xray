import prisma from "@acme/prisma";
import { eventBus, EVENTS } from "@acme/events";
import fireblocks from "../../partners/fireblocks/index.js";
export default async function create({ orgId, amount }) {
  const address = await fireblocks.createAddress({ orgId });
  const deposit = await prisma.deposit.create({ data: { orgId, amount, address } });
  eventBus.emit(EVENTS.DEPOSIT_CREATED, { id: deposit.id, timestamp: Date.now() });
  return { success: true, data: deposit };
}
