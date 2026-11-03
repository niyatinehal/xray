import wrappers from "../../wrappers/index.js";
export default async function get(req, res) { return res.json(await wrappers.checkouts.get({ id: req.params.id })); }
