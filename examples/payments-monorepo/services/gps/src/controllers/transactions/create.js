import wrappers from "../../wrappers/index.js";
export default async (req, res) => res.json(await wrappers.transactions.create(req.body));
