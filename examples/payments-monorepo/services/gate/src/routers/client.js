import { Router } from "express";
import create from "../controllers/checkouts/create.js";
import get from "../controllers/checkouts/get.js";
const router = Router();
router.post("/", create);
router.get("/:id", get);
export default router;
