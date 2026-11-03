import { PartnerGateway } from "../base/PartnerGateway.js";
class RailPay extends PartnerGateway {
  constructor() { super({ name: "railpay", baseUrl: process.env.RAILPAY_URL, timeoutMs: Number(process.env.RAILPAY_TIMEOUT_MS || 15000), retryAttempts: 3 }); }
  async payout(body) { return this.request("POST", "/payouts", { body }); }
}
export default new RailPay();
