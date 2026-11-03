import { Queue } from "bullmq";
export const CHECKOUT_EXPIRY_QUEUE = "checkout-expiry";
export const checkoutExpiryQueue = new Queue(CHECKOUT_EXPIRY_QUEUE, { connection });
