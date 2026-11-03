import { eventBus, EVENTS } from "@acme/events";
import prisma from "@acme/prisma";
export function setupCommonEventListeners() {
  eventBus.on(EVENTS.DEPOSIT_COMPLETED, async (data) => {
    const deposit = await prisma.deposit.findFirst({ where: { id: data.id } });
    await prisma.notification.create({ data: { orgId: deposit.orgId, type: "DEPOSIT" } });
  });
  eventBus.on(EVENTS.GPS_TRANSACTION_ATTEMPT_FAILED, async (data) => {
    await prisma.notification.create({ data: { type: "TX_FAILED", ref: data.attemptId } });
  });
}
