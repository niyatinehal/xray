import prisma from "@acme/prisma";
import { eventBus, EVENTS } from "@acme/events";
import railpay from "../../partners/railpay/index.js";
export default async function settle({ id }) {
  const attempt = await prisma.transactionAttempt.create({ data: { transactionId: id } });
  const result = await railpay.payout({ attemptId: attempt.id });
  if (!result.success) {
    eventBus.emit(EVENTS.GPS_TRANSACTION_ATTEMPT_FAILED, { attemptId: attempt.id, timestamp: Date.now() });
    return result;
  }
  eventBus.emit(EVENTS.GPS_TRANSACTION_COMPLETED, { id, timestamp: Date.now() });
  return { success: true, data: attempt };
}
