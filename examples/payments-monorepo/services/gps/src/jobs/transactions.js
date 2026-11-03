import { productionTransactionQueue } from "../queues/productionTransactionQueue.js";
export const addTransactionJob = (data) => productionTransactionQueue.add("settle", data);
