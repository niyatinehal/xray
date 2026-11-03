import { checkoutExpiryQueue } from "../queues/checkoutExpiryQueue.js";
export async function addCheckoutExpiryJob(data) { return checkoutExpiryQueue.add("expire", data, { delay: 900000 }); }
