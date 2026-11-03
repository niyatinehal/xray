import { PartnerGateway } from "../base/PartnerGateway.js";
class Fireblocks extends PartnerGateway { async createAddress(b){ return this.request("POST","/vault/addresses",{ body: b }); } }
export default new Fireblocks({ name: "fireblocks", baseUrl: process.env.FIREBLOCKS_URL });
