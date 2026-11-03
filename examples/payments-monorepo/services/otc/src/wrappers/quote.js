import prisma from "@acme/prisma";
import { eventBus, EVENTS } from "@acme/events";
export default {
  async create({ orgId }) {
    return prisma.quote.create({ data: { orgId } });
  },
  async accept({ id }) {
    const quote = await prisma.quote.update({ where: { id }, data: { status: "ACCEPTED" } });
    eventBus.emit(EVENTS.WITHDRAW_CREATED, { id: quote.id, timestamp: Date.now() });
    return { success: true, data: quote };
  },
  reject: async ({ id }) => prisma.quote.update({ where: { id }, data: { status: "REJECTED" } }),
};
