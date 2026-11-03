import { Worker } from "bullmq";
import wrappers from "../wrappers/index.js";
const concurrency = Number(process.env.GPS_TX_CONCURRENCY || 10);
export const worker = new Worker("production-transaction", async (job) => wrappers.transactions.settle(job.data), { connection, concurrency });
