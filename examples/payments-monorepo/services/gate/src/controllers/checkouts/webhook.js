import wrappers from "../../wrappers/index.js";
export default async function webhook(req, res) { return res.json(await wrappers.checkouts.complete(req.body)); }
