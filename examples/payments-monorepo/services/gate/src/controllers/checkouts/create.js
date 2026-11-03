import wrappers from "../../wrappers/index.js";
export default async function create(req, res) {
  const result = await wrappers.checkouts.create({ orgId: req.orgId, ...req.body });
  return res.json(result);
}
