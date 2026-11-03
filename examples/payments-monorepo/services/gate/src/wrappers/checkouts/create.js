import prisma from "@acme/prisma";
import { eventBus, EVENTS } from "@acme/events";
import { addCheckoutExpiryJob } from "../../jobs/checkouts.js";
export default async function create({ orgId, amount }) {
  const checkout = await prisma.checkout.create({ data: { orgId, amount, status: "PENDING" } });
  await addCheckoutExpiryJob({ id: checkout.id });
  eventBus.emit(EVENTS.CHECKOUT_CREATED, { id: checkout.id, timestamp: Date.now() });
  return { success: true, data: checkout };
}
