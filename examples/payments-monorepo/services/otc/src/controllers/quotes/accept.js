import wrapper from "../../wrappers/index.js";
export default async (req, res) => res.json(await wrapper.quote.accept({ id: req.params.id }));
