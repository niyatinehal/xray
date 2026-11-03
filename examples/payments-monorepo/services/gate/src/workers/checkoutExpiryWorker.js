import { Worker } from "bullmq";
import prisma from "@acme/prisma";
import { CHECKOUT_EXPIRY_QUEUE } from "../queues/checkoutExpiryQueue.js";
const concurrency = Number(process.env.CHECKOUT_EXPIRY_CONCURRENCY || 5);
export const worker = new Worker(CHECKOUT_EXPIRY_QUEUE, async (job) => {
  await prisma.checkout.update({ where: { id: job.data.id }, data: { status: "EXPIRED" } });
}, { connection, concurrency });
