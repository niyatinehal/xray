import { eventBus, EVENTS } from "@acme/events";
import wrappers from "./wrappers/index.js";
export function setupWalletEventListeners() {
  eventBus.on(EVENTS.GPS_TRANSACTION_COMPLETED, async (data) => { await wrappers.deposits.credit({ id: data.id }); });
}
