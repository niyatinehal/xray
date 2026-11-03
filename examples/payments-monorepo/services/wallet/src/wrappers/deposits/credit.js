import prisma from "@acme/prisma";
import { eventBus, EVENTS } from "@acme/events";
export default async function credit({ id }) {
  const deposit = await prisma.deposit.update({ where: { id }, data: { status: "COMPLETED" } });
  eventBus.emit(EVENTS.DEPOSIT_COMPLETED, { id: deposit.id, timestamp: Date.now() });
  return { success: true, data: deposit };
}
