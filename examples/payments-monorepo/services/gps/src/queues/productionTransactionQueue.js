import { Queue } from "bullmq";
export const productionTransactionQueue = new Queue("production-transaction", { connection });
