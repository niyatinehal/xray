import prisma from "@acme/prisma";
import { eventBus, EVENTS } from "@acme/events";
export default async function complete({ id }) {
  const checkout = await prisma.checkout.update({ where: { id }, data: { status: "COMPLETED" } });
  eventBus.emit(EVENTS.CHECKOUT_COMPLETED, { id: checkout.id, timestamp: Date.now() });
  return { success: true, data: checkout };
}
