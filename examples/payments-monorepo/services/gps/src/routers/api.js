import { Router } from "express";
import createTx from "../controllers/transactions/create.js";
const router = Router();
router.post("/transactions", createTx);
export default router;
