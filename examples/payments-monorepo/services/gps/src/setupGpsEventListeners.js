import { eventBus, EVENTS } from "@acme/events";
import prisma from "@acme/prisma";
import wrappers from "./wrappers/index.js";
export function setupGpsEventListeners() {
  eventBus.on(EVENTS.CHECKOUT_COMPLETED, async (data) => {
    const checkout = await prisma.checkout.findFirst({ where: { id: data.id } });
    await wrappers.transactions.create({ checkoutId: checkout.id, amount: checkout.amount });
  });
}
