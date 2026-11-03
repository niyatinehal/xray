import { eventBus, EVENTS } from "@acme/events";
import { broadcast } from "./utils/broadcast.js";
eventBus.on(EVENTS.CHECKOUT_COMPLETED, (d) => broadcast("checkout", d));
eventBus.on(EVENTS.DEPOSIT_COMPLETED, (d) => broadcast("deposit", d));
